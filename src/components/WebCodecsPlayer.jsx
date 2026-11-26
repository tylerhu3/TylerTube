// WebCodecs player: H.264 + PCM over the stream WebSocket (/ws/mpeg1, server/drive-ws.js), decoded by
// VideoDecoder onto a canvas, audio on an AudioContext that is also the master clock.
// Engine: webcodecs/WebCodecsEngine.js. Imperative handle: seekTo / skipBy / togglePlayPause (VideoPlayer's external buttons).
import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle
} from "react";
import { APP_VERSION } from "../version";
import { readString, writeString } from "../lib/storage";
import { formatFps, formatPlayerTime, parseFpsSetting } from "./webcodecs/playerUtils";
import SettingsMenu from "./webcodecs/SettingsMenu";
import {
  PlayerTopBar,
  BufferingOverlay,
  PlayerBezel,
  SkipIndicators,
  StatsPanel,
  SeekBar,
  ControlBar
} from "./webcodecs/PlayerChrome";
import { WebCodecsEngine } from "./webcodecs/WebCodecsEngine";
import { BackgroundAudio } from "./webcodecs/backgroundAudio";
import {
  backgroundHandoffNeeded,
  resumePosition,
  shouldHandOff
} from "./webcodecs/backgroundHandoff";
import { isWebCodecsSupported } from "./webcodecs/protocol";
import { mediaTimeFromStream } from "./webcodecs/scheduler";
import {
  autoFpsLadder,
  createAutoFpsState,
  restartAutoFpsWarmup,
  stepAutoFps
} from "./webcodecs/autoFps";

const MAX_VOLUME = 3;
// A socket that closes this soon after the page became visible again (iOS may deliver the close
// of a connection it killed in the background late) rebuilds the engine once.
const AUTO_REBUILD_WINDOW_MS = 10000;

// Background <audio> handoff only where Web Audio is suspended in the background (touch-first
// mobile); desktop keeps the engine playing in a hidden tab.
function detectBackgroundHandoffNeeded() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  let coarsePointer = false;
  try {
    coarsePointer = Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  } catch {
    coarsePointer = false;
  }
  return backgroundHandoffNeeded({
    coarsePointer,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    ua: navigator.userAgent || ""
  });
}
// Frame-rate setting ("auto" | "source" | "60" | "30" | "24"; default 24, see
// DEFAULT_FPS_SETTING / parseFpsSetting in playerUtils). Kept here rather than in App.jsx
// because it only matters to this player (VideoPlayer doesn't need to pass it through).
const FPS_SETTING_KEY = "tylertube_webcodecs_fps";

// What to ask the server for: Auto → its current ladder rung (rung 0 = "source").
function fpsRequestFor(setting, autoState, ladder) {
  if (setting === "auto") {
    const level = autoState?.level || 0;
    return level > 0 && ladder && ladder[level] ? ladder[level] : "source";
  }
  return setting;
}

const WebCodecsPlayer = forwardRef(function WebCodecsPlayer(
  {
    video,
    savedTime = 0,
    getStartTime,
    onTimeUpdate,
    onEnded,
    isHidden = false,
    onToggleTheater
  },
  ref
) {
  const supported = isWebCodecsSupported();

  const playerBoxRef = useRef(null);
  const canvasHostRef = useRef(null);
  const progressWrapRef = useRef(null);
  const settingsMenuRef = useRef(null);
  const settingsBtnRef = useRef(null);
  const engineRef = useRef(null);

  const seekBaseTimeRef = useRef(0);
  const currentMediaTimeRef = useRef(0);
  const mediaDurationRef = useRef(0);
  const playbackSpeedRef = useRef(1);
  const currentQualityRef = useRef(720);
  const loopEnabledRef = useRef(false);
  const isPausedRef = useRef(false);
  const isEndedRef = useRef(false);
  const isMutedRef = useRef(false);
  const curVolRef = useRef(1);
  const prevVolBeforeMuteRef = useRef(1);
  const syncOffsetRef = useRef(0);
  const isDraggingSeekRef = useRef(false);
  const dragSeekTimeRef = useRef(0);
  const controlsHideTimerRef = useRef(null);
  const lastTapTimeRef = useRef(0);
  const clickToggleTimerRef = useRef(null);
  const skipLeftTimerRef = useRef(null);
  const skipRightTimerRef = useRef(null);
  const bezelTimerRef = useRef(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onEndedRef = useRef(onEnded);
  const videoIdRef = useRef(video?.id);
  const initialSavedTimeRef = useRef(savedTime);
  const bufferTargetRef = useRef(2.0);
  const lastReportedSecondRef = useRef(-1);
  const restartFromEndRef = useRef(null);
  // Tap-to-reveal: true when the current touch/pen press started while the controls were hidden.
  const controlsHiddenNowRef = useRef(false);
  const tapRevealOnlyRef = useRef(false);
  const audioLockedOnPressRef = useRef(false);
  const fpsSettingRef = useRef(null);
  const autoFpsStateRef = useRef(createAutoFpsState());
  const autoFpsLadderRef = useRef(null); // built from meta/reset fpsCap
  const requestedFpsRef = useRef("source"); // last fps request sent to the server
  // Background playback (webcodecs/backgroundAudio.js): hidden <audio> of the same MP4 that takes
  // over while the page is hidden; the engine stays paused meanwhile.
  const bgAudioRef = useRef(null); // BackgroundAudio, kept across files so its unlock persists
  const handedOffRef = useRef(null); // { pausedExternally, started } while the <audio> plays for us
  const handoffNeededRef = useRef(null); // touch-first mobile only (detectBackgroundHandoffNeeded)
  if (handoffNeededRef.current === null) handoffNeededRef.current = detectBackgroundHandoffNeeded();
  const pendingHandoffRef = useRef(null); // { fromFile }: bg <audio> ended while hidden → next file
  // Dead-socket recovery (engine onDisconnected): when the page last became visible, whether that
  // resume already used its one auto-rebuild, and whether the socket died while hidden.
  const resumedAtRef = useRef(0);
  const autoRebuildUsedRef = useRef(false);
  const diedWhileHiddenRef = useRef(false);
  const resumeOverrideRef = useRef(null); // { file, time, paused }: start of a rebuilt engine
  const playbackEndedRef = useRef(null); // the current engine's onPlaybackEnded handler

  const [isPaused, setIsPaused] = useState(false);
  const [isEnded, setIsEnded] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [bufferedAheadSec, setBufferedAheadSec] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [bufferMode, setBufferMode] = useState("normal");
  const [isMuted, setIsMuted] = useState(false);
  const [volumePct, setVolumePct] = useState(100);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [quality, setQuality] = useState(720);
  const [fpsSetting, setFpsSetting] = useState(() => parseFpsSetting(readString(FPS_SETTING_KEY)));
  const [streamFps, setStreamFps] = useState(0); // output fps of the current stream (server)
  if (fpsSettingRef.current === null) fpsSettingRef.current = fpsSetting;
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [syncOffsetMs, setSyncOffsetMs] = useState(0);
  const [fps, setFps] = useState(0);
  const [statusText, setStatusText] = useState("Starting WebCodecs stream...");
  const [errorText, setErrorText] = useState("");
  const [audioLocked, setAudioLocked] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hoverPct, setHoverPct] = useState(0);
  const [hoverTimeText, setHoverTimeText] = useState("0:00");
  const [isHoveringSeek, setIsHoveringSeek] = useState(false);
  const [isDraggingSeek, setIsDraggingSeek] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsLines, setStatsLines] = useState(["Waiting for stream..."]);
  const [bezelType, setBezelType] = useState(null);
  const [bezelKey, setBezelKey] = useState(0);
  const [skipLeftLabel, setSkipLeftLabel] = useState("");
  const [skipRightLabel, setSkipRightLabel] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0); // bump → rebuild the engine (dead socket)

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onEndedRef.current = onEnded;
    videoIdRef.current = video?.id;
    initialSavedTimeRef.current = savedTime;
  }, [onTimeUpdate, onEnded, video?.id, savedTime]);

  const targetFile = video?.src || "";
  const targetFileRef = useRef(targetFile);
  targetFileRef.current = targetFile;
  const displayChannelName = video?.title || "";

  const sendWsCommand = useCallback((payload) => {
    return engineRef.current ? engineRef.current.send(payload) : false;
  }, []);

  // seek/speed/quality restart ffmpeg; the engine drops media until the server's "reset"
  // (and sends "resume" too if the server had already ended).
  const sendRestart = useCallback((payload) => {
    return engineRef.current ? engineRef.current.sendExpectingReset(payload) : false;
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setControlsHidden(false);
    if (controlsHideTimerRef.current) {
      clearTimeout(controlsHideTimerRef.current);
    }
    if (!isPausedRef.current && !isDraggingSeekRef.current) {
      controlsHideTimerRef.current = setTimeout(() => {
        if (!isPausedRef.current && !isDraggingSeekRef.current) {
          setControlsHidden(true);
        }
      }, 3000);
    }
  }, []);

  const triggerBezel = useCallback((type) => {
    setBezelType(type);
    setBezelKey((k) => k + 1);
    if (bezelTimerRef.current) clearTimeout(bezelTimerRef.current);
    bezelTimerRef.current = setTimeout(() => {
      setBezelType(null);
    }, 520);
  }, []);

  const triggerSkipIndicator = useCallback((dir, label) => {
    if (dir < 0) {
      setSkipLeftLabel(label || "« 10s");
      if (skipLeftTimerRef.current) clearTimeout(skipLeftTimerRef.current);
      skipLeftTimerRef.current = setTimeout(() => setSkipLeftLabel(""), 650);
    } else {
      setSkipRightLabel(label || "10s »");
      if (skipRightTimerRef.current) clearTimeout(skipRightTimerRef.current);
      skipRightTimerRef.current = setTimeout(() => setSkipRightLabel(""), 650);
    }
  }, []);

  const tryUnlockAudio = useCallback((ev) => {
    if (engineRef.current) engineRef.current.unlockAudio();
    // The background <audio> needs a real gesture (iOS counts touchend/click/keydown, not
    // touchstart); a failed unlock stays "none" and retries on the next one.
    if (ev && ev.isTrusted && ev.type !== "touchstart" && bgAudioRef.current) {
      bgAudioRef.current.unlock();
    }
  }, []);

  const seekTo = useCallback(
    (targetSec) => {
      if (!engineRef.current) return;
      const dur = mediaDurationRef.current > 0 ? mediaDurationRef.current : 0;
      let clamped = Number(targetSec) || 0;
      clamped = dur > 0 ? Math.max(0, Math.min(dur - 0.1, clamped)) : Math.max(0, clamped);
      isEndedRef.current = false;
      setIsEnded(false);
      setIsBuffering(!isPausedRef.current);
      seekBaseTimeRef.current = clamped;
      currentMediaTimeRef.current = clamped;
      lastReportedSecondRef.current = -1;
      setDisplayTime(clamped);
      showControlsTemporarily();
      sendRestart({ type: "seek", time: clamped });

      if (videoIdRef.current && onTimeUpdateRef.current) {
        onTimeUpdateRef.current(videoIdRef.current, clamped, dur, { force: true });
      }
    },
    [sendRestart, showControlsTemporarily]
  );

  const skipBy = useCallback(
    (deltaSec) => {
      if (!engineRef.current) return;
      const dur = mediaDurationRef.current;
      let target = currentMediaTimeRef.current + deltaSec;
      target = dur > 0 ? Math.max(0, Math.min(dur - 0.1, target)) : Math.max(0, target);
      const label =
        (deltaSec < 0 ? "« " : "") + Math.abs(deltaSec) + "s" + (deltaSec > 0 ? " »" : "");
      triggerSkipIndicator(deltaSec, label);
      seekTo(target);
    },
    [seekTo, triggerSkipIndicator]
  );

  // Save the exact current position (pause / player switch / unmount), not just whole seconds.
  const reportExactPosition = useCallback(() => {
    const t = currentMediaTimeRef.current;
    if (!videoIdRef.current || !onTimeUpdateRef.current || !(t > 0)) return;
    onTimeUpdateRef.current(videoIdRef.current, t, mediaDurationRef.current, { force: true });
  }, []);

  const togglePlayPause = useCallback(
    (withBezel = true) => {
      const eng = engineRef.current;
      if (!eng) return;
      tryUnlockAudio();

      if (isEndedRef.current) {
        isEndedRef.current = false;
        isPausedRef.current = false;
        setIsEnded(false);
        setIsPaused(false);
        eng.setPaused(false);
        seekTo(0);
        if (withBezel) triggerBezel("play");
        showControlsTemporarily();
        return;
      }

      const nextPaused = !isPausedRef.current;
      isPausedRef.current = nextPaused;
      eng.setPaused(nextPaused); // also sends pause/resume to the server
      setIsPaused(nextPaused);
      if (nextPaused) reportExactPosition();
      if (withBezel) triggerBezel(nextPaused ? "pause" : "play");
      showControlsTemporarily();
    },
    [reportExactPosition, seekTo, showControlsTemporarily, triggerBezel, tryUnlockAudio]
  );

  restartFromEndRef.current = () => {
    // Loop: the client reached the real end of its buffer; restart from 0 and keep playing.
    isEndedRef.current = false;
    seekTo(0);
  };

  const applyVolume = useCallback((vol, muted) => {
    const effVol = muted ? 0 : vol;
    setVolumePct(Math.round(effVol * 100));
    setIsMuted(muted || effVol === 0);
    if (engineRef.current) engineRef.current.setVolume(effVol, muted || effVol === 0);
  }, []);

  const handleSetVolume = useCallback(
    (val) => {
      const clamped = Math.max(0, Math.min(MAX_VOLUME, val));
      curVolRef.current = clamped;
      if (clamped > 0) {
        isMutedRef.current = false;
        prevVolBeforeMuteRef.current = clamped;
      } else {
        isMutedRef.current = true;
      }
      applyVolume(clamped, isMutedRef.current);
      tryUnlockAudio();
    },
    [applyVolume, tryUnlockAudio]
  );

  const handleToggleMute = useCallback(
    (withBezel = false) => {
      if (isMutedRef.current) {
        isMutedRef.current = false;
        curVolRef.current = prevVolBeforeMuteRef.current > 0.05 ? prevVolBeforeMuteRef.current : 0.5;
        if (withBezel) triggerBezel("unmute");
      } else {
        prevVolBeforeMuteRef.current = curVolRef.current;
        isMutedRef.current = true;
        if (withBezel) triggerBezel("mute");
      }
      applyVolume(curVolRef.current, isMutedRef.current);
      tryUnlockAudio();
    },
    [applyVolume, triggerBezel, tryUnlockAudio]
  );

  const handleSetSpeed = useCallback(
    (spd) => {
      playbackSpeedRef.current = spd;
      setPlaybackSpeed(spd);
      seekBaseTimeRef.current = currentMediaTimeRef.current;
      sendRestart({ type: "speed", speed: spd, currentTime: currentMediaTimeRef.current });
    },
    [sendRestart]
  );

  const handleSetQuality = useCallback(
    (q) => {
      currentQualityRef.current = q;
      setQuality(q);
      seekBaseTimeRef.current = currentMediaTimeRef.current;
      sendRestart({ type: "quality", quality: q, currentTime: currentMediaTimeRef.current });
    },
    [sendRestart]
  );

  // Ask the server for another output frame rate (restarts encoding at the current position).
  const requestFps = useCallback(
    (fpsValue) => {
      if (requestedFpsRef.current === fpsValue) return;
      const t = currentMediaTimeRef.current;
      if (!sendRestart({ type: "fps", fps: fpsValue, currentTime: t })) return;
      requestedFpsRef.current = fpsValue;
      seekBaseTimeRef.current = t;
    },
    [sendRestart]
  );

  const handleSetFps = useCallback(
    (value) => {
      fpsSettingRef.current = value;
      setFpsSetting(value);
      writeString(FPS_SETTING_KEY, String(value));
      if (value === "auto") autoFpsStateRef.current = createAutoFpsState();
      requestFps(fpsRequestFor(value, autoFpsStateRef.current, autoFpsLadderRef.current));
    },
    [requestFps]
  );

  const handleToggleLoop = useCallback(() => {
    const next = !loopEnabledRef.current;
    loopEnabledRef.current = next;
    setLoopEnabled(next);
    sendWsCommand({ type: "loop", loop: next });
  }, [sendWsCommand]);

  const handleSetBufferTarget = useCallback((target) => {
    bufferTargetRef.current = target;
    setBufferMode(target === 1.0 ? "fast" : target === 5.0 ? "deep" : "normal");
    if (engineRef.current) engineRef.current.setRebufferTarget(target);
  }, []);

  const handleAdjustSync = useCallback((deltaSec) => {
    const next = Math.round((syncOffsetRef.current + deltaSec) * 10) / 10;
    syncOffsetRef.current = next;
    setSyncOffsetMs(Math.round(next * 1000));
    if (engineRef.current) engineRef.current.setSyncOffset(next);
  }, []);

  const handleResetSync = useCallback(() => {
    syncOffsetRef.current = 0;
    setSyncOffsetMs(0);
    if (engineRef.current) engineRef.current.setSyncOffset(0);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    const box = playerBoxRef.current;
    if (!box) return;
    const isNativeFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (isNativeFs || isPseudoFullscreen) {
      if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
        document.webkitExitFullscreen();
      }
      setIsPseudoFullscreen(false);
      setIsFullscreen(false);
    } else {
      const req = box.requestFullscreen || box.webkitRequestFullscreen;
      if (req) {
        try {
          const p = req.call(box);
          if (p && p.catch) {
            p.catch(() => {
              setIsPseudoFullscreen(true);
              setIsFullscreen(true);
            });
          }
        } catch {
          setIsPseudoFullscreen(true);
          setIsFullscreen(true);
        }
      } else {
        setIsPseudoFullscreen(true);
        setIsFullscreen(true);
      }
    }
  }, [isPseudoFullscreen]);

  useImperativeHandle(ref, () => ({ seekTo, skipBy, togglePlayPause }), [
    seekTo,
    skipBy,
    togglePlayPause
  ]);

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      setIsFullscreen(active || isPseudoFullscreen);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, [isPseudoFullscreen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleDocClick = (e) => {
      if (
        settingsMenuRef.current &&
        !settingsMenuRef.current.contains(e.target) &&
        settingsBtnRef.current &&
        !settingsBtnRef.current.contains(e.target)
      ) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("click", handleDocClick);
    return () => document.removeEventListener("click", handleDocClick);
  }, [settingsOpen]);

  // AudioContext needs a user gesture before it runs.
  useEffect(() => {
    document.addEventListener("click", tryUnlockAudio, true);
    document.addEventListener("touchstart", tryUnlockAudio, true);
    document.addEventListener("touchend", tryUnlockAudio, true);
    document.addEventListener("keydown", tryUnlockAudio, true);
    return () => {
      document.removeEventListener("click", tryUnlockAudio, true);
      document.removeEventListener("touchstart", tryUnlockAudio, true);
      document.removeEventListener("touchend", tryUnlockAudio, true);
      document.removeEventListener("keydown", tryUnlockAudio, true);
    };
  }, [tryUnlockAudio]);

  // ---------- Background playback handoff ----------
  // Page hidden while playing → the hidden <audio> continues from the current position and the
  // engine pauses (UI state untouched); page visible again → the engine resumes where the audio is.

  // Stops the <audio> and clears the handoff; leaves its position in currentMediaTimeRef.
  // Returns { time, pausedExternally } or null if nothing was handed off.
  const endBackgroundHandoff = useCallback((ended = false) => {
    const handoff = handedOffRef.current;
    if (!handoff) return null;
    handedOffRef.current = null;
    const bg = bgAudioRef.current;
    const stoppedAt = bg ? bg.stop() : 0;
    // If the <audio> never started playing (play() pending, no metadata yet) its currentTime is
    // meaningless: resume from where the engine was.
    const audioTimeSec = bg && handoff.started ? stoppedAt : currentMediaTimeRef.current;
    const time = resumePosition({
      audioTimeSec,
      durationSec: mediaDurationRef.current || (bg ? bg.duration : 0),
      ended
    });
    currentMediaTimeRef.current = time;
    return { time, pausedExternally: handoff.pausedExternally };
  }, []);

  // Resume the engine at the handed-back position; a dead socket rebuilds the engine there.
  const resumeEngineAfterHandoff = useCallback(
    ({ time, pausedExternally }) => {
      const eng = engineRef.current;
      setDisplayTime(time);
      if (pausedExternally) setIsPaused(true);
      if (!eng || !eng.isConnected()) {
        autoRebuildUsedRef.current = true; // this resume's rebuild; no second one on its close
        resumeOverrideRef.current = { file: targetFileRef.current, time, paused: pausedExternally };
        setReconnectKey((k) => k + 1);
        return;
      }
      if (!pausedExternally) {
        isPausedRef.current = false;
        eng.setPaused(false);
      }
      seekTo(time); // also saves the position
    },
    [seekTo]
  );

  const handOffToBackground = useCallback(() => {
    const eng = engineRef.current;
    const bg = bgAudioRef.current;
    if (!eng || !bg || handedOffRef.current) return;
    if (
      !shouldHandOff({
        hidden: document.visibilityState === "hidden",
        playing: !isPausedRef.current,
        ended: isEndedRef.current,
        unlocked: bg.isUnlocked,
        supported: handoffNeededRef.current,
        // Muted: nothing to hear. (Volume is followed only up to 1; iOS ignores element volume.)
        muted: isMutedRef.current,
        timeSec: currentMediaTimeRef.current,
        durationSec: mediaDurationRef.current
      })
    ) {
      return;
    }
    const handoff = { pausedExternally: false, started: false };
    handedOffRef.current = handoff;
    // play() must be called synchronously inside the visibilitychange handler.
    const started = bg.start({
      timeSec: currentMediaTimeRef.current,
      rate: playbackSpeedRef.current,
      volume: curVolRef.current, // clamped to 1 by the controller
      muted: isMutedRef.current,
      loop: loopEnabledRef.current
    });
    // Engine pause stops its scheduled audio; isPausedRef only, the UI keeps showing "playing".
    isPausedRef.current = true;
    eng.setPaused(true);
    started.then((ok) => {
      if (handedOffRef.current !== handoff) return;
      if (ok) {
        handoff.started = true;
        return;
      }
      // NotAllowedError / unsupported / error: fall back to the engine (no retry until next hide).
      handedOffRef.current = null;
      const e = engineRef.current;
      if (e && !isEndedRef.current) {
        isPausedRef.current = false;
        e.setPaused(false);
      }
    });
  }, []);

  // Rebuild the engine at the current position (dead socket), keeping the paused state.
  const rebuildEngineHere = useCallback(() => {
    resumeOverrideRef.current = {
      file: targetFileRef.current,
      time: currentMediaTimeRef.current,
      paused: isPausedRef.current
    };
    setReconnectKey((k) => k + 1);
  }, []);

  const returnFromBackground = useCallback(() => {
    pendingHandoffRef.current = null;
    const result = endBackgroundHandoff();
    if (result) resumeEngineAfterHandoff(result);
  }, [endBackgroundHandoff, resumeEngineAfterHandoff]);

  // Page visible again: open the auto-rebuild window, and rebuild now if the socket died while
  // hidden (and returnFromBackground didn't already rebuild).
  const markResumed = useCallback(() => {
    const now = Date.now();
    // visibilitychange and pageshow can both report one return: count it once.
    if (now - resumedAtRef.current < 1000) return;
    resumedAtRef.current = now;
    if (resumeOverrideRef.current) {
      autoRebuildUsedRef.current = true;
      diedWhileHiddenRef.current = false;
      return;
    }
    autoRebuildUsedRef.current = false;
    if (diedWhileHiddenRef.current && engineRef.current && !isEndedRef.current) {
      diedWhileHiddenRef.current = false;
      autoRebuildUsedRef.current = true;
      rebuildEngineHere();
    }
  }, [rebuildEngineHere]);

  // <audio> events while handed off.
  const handleBgTime = useCallback((sec) => {
    if (!handedOffRef.current) return;
    currentMediaTimeRef.current = sec;
    setDisplayTime(sec);
    const wholeSec = Math.floor(sec);
    if (wholeSec > 0 && videoIdRef.current && onTimeUpdateRef.current) {
      lastReportedSecondRef.current = wholeSec;
      onTimeUpdateRef.current(videoIdRef.current, sec, mediaDurationRef.current, { force: false });
    }
  }, []);

  // Lock screen / Control Center pause: a real user pause, so mirror it into the player.
  const handleBgPausedExternally = useCallback(
    (sec) => {
      const handoff = handedOffRef.current;
      if (!handoff) return;
      handoff.pausedExternally = true;
      currentMediaTimeRef.current = sec;
      setDisplayTime(sec);
      setIsPaused(true);
      reportExactPosition();
    },
    [reportExactPosition]
  );

  const handleBgPlayExternally = useCallback(() => {
    const handoff = handedOffRef.current;
    if (!handoff) return;
    handoff.pausedExternally = false;
    setIsPaused(false);
  }, []);

  // Same path as the engine running out of media (ended UI, completed progress, onEnded).
  // If onEnded autoplays the next file while still hidden, pendingHandoffRef makes the
  // background <audio> effect hand that file off too.
  const handleBgEnded = useCallback(() => {
    if (!endBackgroundHandoff(true)) return;
    pendingHandoffRef.current =
      document.visibilityState === "hidden" ? { fromFile: targetFileRef.current } : null;
    playbackEndedRef.current?.();
  }, [endBackgroundHandoff]);

  // Playback error in the background: hand back to the engine like on return.
  const handleBgError = useCallback(() => {
    returnFromBackground();
  }, [returnFromBackground]);

  // Engine lifecycle: one WebSocket + decoder + AudioContext per file / visibility.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!supported || !host || isHidden || !targetFile) {
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
      if (host) host.innerHTML = "";
      return;
    }

    let cancelled = false;
    if (engineRef.current) {
      engineRef.current.destroy();
      engineRef.current = null;
    }
    host.innerHTML = "";

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    canvas.className = "yt-drive-canvas";
    host.appendChild(canvas);

    // A rebuild after a background handoff (dead socket) starts where the <audio> stopped.
    const override =
      resumeOverrideRef.current && resumeOverrideRef.current.file === targetFile
        ? resumeOverrideRef.current
        : null;
    resumeOverrideRef.current = null;
    // getStartTime (from VideoPlayer) gives the exact position the other player left off at.
    const requestedStart = override ? override.time : getStartTime?.() ?? initialSavedTimeRef.current;
    const startSeek = Number(requestedStart) > 0 ? Number(requestedStart) : 0;
    let startPaused = Boolean(override && override.paused); // paused from the lock screen

    isPausedRef.current = false;
    isEndedRef.current = false;
    diedWhileHiddenRef.current = false;
    seekBaseTimeRef.current = startSeek;
    currentMediaTimeRef.current = startSeek;
    mediaDurationRef.current = 0;
    lastReportedSecondRef.current = -1;
    // Auto starts every video at the source rate; a fixed setting (default 24) is sent as-is,
    // so the first request already carries the cap and no auto stepping happens.
    autoFpsStateRef.current = createAutoFpsState();
    autoFpsLadderRef.current = null;
    requestedFpsRef.current = fpsRequestFor(fpsSettingRef.current, null, null);

    if (startPaused) isPausedRef.current = true; // engine.setPaused(true) once "meta" arrives
    setIsPaused(startPaused);
    setIsEnded(false);
    setIsBuffering(!startPaused);
    setBufferedAheadSec(0);
    setBufferedPct(0);
    setDisplayTime(startSeek);
    setDuration(0);
    setFps(0);
    setErrorText("");
    setStatusText("Starting WebCodecs stream...");
    showControlsTemporarily();

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      `${wsProtocol}//${window.location.host}/ws/mpeg1?file=${encodeURIComponent(targetFile)}` +
      `&quality=${currentQualityRef.current}` +
      `&speed=${playbackSpeedRef.current}` +
      `&seek=${startSeek.toFixed(2)}` +
      `&loop=${loopEnabledRef.current ? "1" : "0"}` +
      `&fps=${encodeURIComponent(String(requestedFpsRef.current))}`;

    const applyStreamInfo = (msg) => {
      const sk = parseFloat(msg.seekTime) || 0;
      seekBaseTimeRef.current = sk;
      currentMediaTimeRef.current = sk;
      lastReportedSecondRef.current = -1;
      const dur = parseFloat(msg.duration) || 0;
      if (dur > 0) {
        mediaDurationRef.current = dur;
        setDuration(dur);
      }
      const spd = parseFloat(msg.speed);
      if (spd > 0) {
        playbackSpeedRef.current = spd;
        setPlaybackSpeed(spd);
      }
      const q = parseInt(msg.quality, 10);
      if (q > 0) {
        currentQualityRef.current = q;
        setQuality(q);
      }
      const outFps = Number(msg.fps);
      setStreamFps(outFps > 0 ? outFps : 0);
      const cap = Number(msg.fpsCap);
      const ladder = autoFpsLadderRef.current;
      if (cap > 0 && (!ladder || ladder[0] !== cap)) autoFpsLadderRef.current = autoFpsLadder(cap);
      autoFpsStateRef.current = restartAutoFpsWarmup(autoFpsStateRef.current);
      if (!isDraggingSeekRef.current) setDisplayTime(sk);
    };

    // Engine ran out of media (also reused when the background <audio> ends).
    const handlePlaybackEnded = () => {
      if (cancelled) return;
      if (loopEnabledRef.current) {
        restartFromEndRef.current?.();
        return;
      }
      isEndedRef.current = true;
      isPausedRef.current = true;
      engine.setPaused(true);
      setIsBuffering(false);
      if (mediaDurationRef.current > 0) {
        currentMediaTimeRef.current = mediaDurationRef.current;
        setDisplayTime(mediaDurationRef.current);
      }
      setIsEnded(true);
      setIsPaused(true);
      if (videoIdRef.current && onTimeUpdateRef.current) {
        onTimeUpdateRef.current(
          videoIdRef.current,
          mediaDurationRef.current,
          mediaDurationRef.current,
          { force: true, completed: true }
        );
      }
      if (onEndedRef.current) onEndedRef.current();
    };

    const engine = new WebCodecsEngine({
      url: wsUrl,
      canvas,
      callbacks: {
        onControl: (msg) => {
          if (cancelled) return;
          if (msg.type === "meta") {
            setErrorText("");
            applyStreamInfo(msg);
            loopEnabledRef.current = Boolean(msg.loop);
            setLoopEnabled(Boolean(msg.loop));
            if (startPaused) {
              startPaused = false;
              // Only if still paused: a tap before meta already resumed the engine and the UI.
              if (isPausedRef.current) {
                // Socket is open now, so the server pauses ffmpeg too (re-sent if a pause before
                // open made setPaused a no-op).
                if (engine.paused) engine.send({ type: "pause" });
                else engine.setPaused(true);
              }
            }
          } else if (msg.type === "reset") {
            setErrorText("");
            applyStreamInfo(msg);
          } else if (msg.type === "ended") {
            // The engine may still hold buffered media; onPlaybackEnded fires when it runs out.
          } else if (msg.message) {
            setStatusText(msg.message);
          }
        },
        onFrame: (streamSec) => {
          if (cancelled) return;
          const dur = mediaDurationRef.current;
          const t = mediaTimeFromStream(
            seekBaseTimeRef.current,
            streamSec,
            playbackSpeedRef.current,
            dur
          );
          currentMediaTimeRef.current = t;
          if (!isDraggingSeekRef.current) setDisplayTime(t);
          const wholeSec = Math.floor(t);
          if (
            wholeSec > 0 &&
            wholeSec !== lastReportedSecondRef.current &&
            videoIdRef.current &&
            onTimeUpdateRef.current
          ) {
            lastReportedSecondRef.current = wholeSec;
            onTimeUpdateRef.current(videoIdRef.current, t, dur, { force: false });
          }
        },
        onBuffering: (b) => {
          if (!cancelled) setIsBuffering(b);
        },
        onAudioLockChange: (locked) => {
          if (!cancelled) setAudioLocked(Boolean(locked));
        },
        onPlaybackEnded: handlePlaybackEnded,
        onStatus: (text) => {
          if (!cancelled) setStatusText(text);
        },
        onError: (text) => {
          if (!cancelled) {
            setIsBuffering(false);
            setErrorText(text);
            setStatusText(`Error: ${text}`);
          }
        },
        // Socket closed under us. A handoff in progress is recovered by returnFromBackground
        // (isConnected() false). One auto-rebuild per resume, so a dead server can't loop.
        onDisconnected: () => {
          if (cancelled || isEndedRef.current || handedOffRef.current) return;
          if (document.visibilityState === "hidden") {
            diedWhileHiddenRef.current = true; // markResumed rebuilds on return
            return;
          }
          const sinceResume = Date.now() - resumedAtRef.current;
          if (resumedAtRef.current > 0 && sinceResume <= AUTO_REBUILD_WINDOW_MS && !autoRebuildUsedRef.current) {
            autoRebuildUsedRef.current = true;
            rebuildEngineHere();
            return;
          }
          if (!engine.serverEnded) {
            setIsBuffering(false);
            setErrorText((prev) => prev || "Stream disconnected");
          }
        }
      }
    });
    playbackEndedRef.current = handlePlaybackEnded;
    engine.setVolume(isMutedRef.current ? 0 : curVolRef.current, isMutedRef.current);
    engine.setSyncOffset(syncOffsetRef.current);
    engine.setRebufferTarget(bufferTargetRef.current);
    engineRef.current = engine;
    setAudioLocked(engine.isAudioLocked());
    engine.unlockAudio(); // not tryUnlockAudio: no gesture here, so leave the background <audio> alone

    const statsTimer = setInterval(() => {
      if (cancelled) return;
      // Auto frame rate: one health sample per second; step the ladder on sustained trouble/headroom.
      const health = engine.takeHealthSample();
      const ladder = autoFpsLadderRef.current;
      if (fpsSettingRef.current === "auto" && ladder) {
        const res = stepAutoFps(autoFpsStateRef.current, health, ladder.length);
        autoFpsStateRef.current = res.state;
        if (res.action) requestFps(fpsRequestFor("auto", res.state, ladder));
      }
      const s = engine.getStats();
      setFps(s.fps);
      setBufferedAheadSec(Math.max(0, s.bufferedAheadSec));
      const dur = mediaDurationRef.current;
      if (dur > 0) {
        const end = mediaTimeFromStream(
          seekBaseTimeRef.current,
          s.streamTimeSec + s.receivedAheadVideoSec,
          playbackSpeedRef.current,
          dur
        );
        setBufferedPct(Math.max(0, Math.min(100, (end / dur) * 100)));
      }
      const locked = engine.isAudioLocked();
      setAudioLocked(locked);
      const offTxt = `${s.avOffsetMs > 0 ? "+" : ""}${s.avOffsetMs}ms`;
      if (
        s.buffering ||
        s.fatalError ||
        (s.disconnected && !engine.serverEnded) ||
        isEndedRef.current ||
        isPausedRef.current
      ) {
        // Keep the last status; the top bar shows "Buffering..." or the error/disconnect text.
      } else if (locked) {
        setStatusText("Tap anywhere to unmute");
      } else if (s.decoderState === "closed" || s.decoderState === "none") {
        // Error text already set by onError.
      } else {
        setStatusText(s.clockMode === "audio" ? `Playing (A/V ${offTxt})` : "Playing");
      }
      setStatsLines([
        `Source: ${displayChannelName} (VOD, WebCodecs)`,
        `Resolution: ${s.width}x${s.height} @ ${s.fps} fps`,
        `Quality / Speed: ${currentQualityRef.current}p / ${playbackSpeedRef.current}x`,
        `Frame Rate: ${formatFps(s.streamFps) || "?"} fps encoded (setting ${fpsSettingRef.current}${
          fpsSettingRef.current === "auto"
            ? `, level ${autoFpsStateRef.current.level}, ${s.lateFrames} late`
            : ""
        })`,
        `Decoder: ${s.decoderState} ${s.codec} (decode queue ${s.decodeQueueSize})`,
        `Frame Queue: ${s.framesQueued} decoded / ${s.encodedQueued} encoded`,
        `Dropped Frames: ${s.droppedFrames} of ${s.decodedFrames} (catch-ups ${s.catchUps}, pre-key ${s.skippedBeforeKey}, errors ${s.decodeErrors})`,
        `Clock: ${s.clockMode}${s.audioGap ? " (audio gap)" : ""}`,
        `Audio: ${s.audioState}, queue ${s.audioQueuedMs} ms, ${s.audioSources} sources, out latency ${s.outputLatencyMs} ms`,
        `A/V Offset: ${offTxt} (frame vs heard audio; sync ${Math.round(syncOffsetRef.current * 1000)} ms)`,
        `Buffer Health: ${s.bufferedAheadSec.toFixed(1)}s (Rebuffer target: ${bufferTargetRef.current}s, underruns ${s.underruns})`,
        `Position: ${formatPlayerTime(currentMediaTimeRef.current)}${
          mediaDurationRef.current > 0 ? " / " + formatPlayerTime(mediaDurationRef.current) : ""
        }`,
        `Version: ${APP_VERSION}`
      ]);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(statsTimer);
      // File change / player hidden / unmount (incl. switch to Standard) while handed off: stop
      // the <audio>; its position lands in currentMediaTimeRef and is saved just below.
      endBackgroundHandoff();
      reportExactPosition();
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
      if (playbackEndedRef.current === handlePlaybackEnded) playbackEndedRef.current = null;
      if (host) host.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile, isHidden, supported, reconnectKey]);

  // Background <audio>: created once, pointed at the current file URL.
  useEffect(() => {
    if (!supported || isHidden || !targetFile || !handoffNeededRef.current || targetFile.startsWith("yt:")) return;
    if (!BackgroundAudio.isSupported()) return;
    if (!bgAudioRef.current) {
      bgAudioRef.current = new BackgroundAudio({
        onTime: handleBgTime,
        onEnded: handleBgEnded,
        onPausedExternally: handleBgPausedExternally,
        onPlayExternally: handleBgPlayExternally,
        onError: handleBgError
      });
    }
    bgAudioRef.current.setSource(targetFile);
    // Background <audio> ended while hidden and onEnded moved on: continue with this file in the
    // background from the new engine's start position (set by the engine effect, which runs
    // first). On rejection handOffToBackground falls back to the engine silently.
    const pending = pendingHandoffRef.current;
    if (pending && pending.fromFile !== targetFile) {
      pendingHandoffRef.current = null;
      if (document.visibilityState === "hidden") handOffToBackground();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile, isHidden, supported]);

  useEffect(
    () => () => {
      endBackgroundHandoff();
      if (bgAudioRef.current) {
        bgAudioRef.current.destroy();
        bgAudioRef.current = null;
      }
    },
    [endBackgroundHandoff]
  );

  // Page visibility drives the handoff (iOS: app switch / lock; desktop: tab hide).
  useEffect(() => {
    if (!supported) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        handOffToBackground();
      } else {
        returnFromBackground();
        markResumed();
      }
    };
    const onPageShow = () => {
      if (document.visibilityState === "visible") {
        returnFromBackground();
        markResumed();
      }
    };
    // The page may be frozen or discarded after this: save the exact position now.
    const onPageHide = () => {
      if (handedOffRef.current && handedOffRef.current.started && bgAudioRef.current) {
        currentMediaTimeRef.current = bgAudioRef.current.currentTime;
      }
      if (handedOffRef.current || engineRef.current) reportExactPosition();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [supported, handOffToBackground, returnFromBackground, markResumed, reportExactPosition]);

  // Seek bar scrubbing
  const getRatioFromClientX = useCallback((clientX) => {
    const wrap = progressWrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const updateSeekHoverFromClientX = useCallback(
    (clientX) => {
      const ratio = getRatioFromClientX(clientX);
      setHoverPct(ratio * 100);
      setHoverTimeText(formatPlayerTime(ratio * (mediaDurationRef.current || 0)));
      return ratio;
    },
    [getRatioFromClientX]
  );

  useEffect(() => {
    if (!isDraggingSeek) return;
    const onWinMouseMove = (e) => {
      if (!isDraggingSeekRef.current) return;
      const ratio = updateSeekHoverFromClientX(e.clientX);
      const t = ratio * (mediaDurationRef.current || 0);
      dragSeekTimeRef.current = t;
      setDisplayTime(t);
    };
    const onWinMouseUp = (e) => {
      if (!isDraggingSeekRef.current) return;
      isDraggingSeekRef.current = false;
      setIsDraggingSeek(false);
      setHoverPct(0);
      seekTo(getRatioFromClientX(e.clientX) * (mediaDurationRef.current || 0));
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWinMouseMove);
      window.removeEventListener("mouseup", onWinMouseUp);
    };
  }, [isDraggingSeek, getRatioFromClientX, seekTo, updateSeekHoverFromClientX]);

  // YouTube keyboard shortcuts
  useEffect(() => {
    if (isHidden) return;
    const onKeyDown = (e) => {
      if (!engineRef.current) return;
      const tag = e.target?.tagName?.toLowerCase() || "";
      if (tag === "input" || tag === "textarea" || tag === "select" || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === " " || key === "k") {
        e.preventDefault();
        togglePlayPause(true);
      } else if (key === "j") {
        e.preventDefault();
        skipBy(-10);
      } else if (key === "l") {
        e.preventDefault();
        skipBy(10);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skipBy(-5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skipBy(5);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        handleSetVolume(curVolRef.current + 0.05);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleSetVolume(curVolRef.current - 0.05);
      } else if (key === "f") {
        e.preventDefault();
        handleToggleFullscreen();
      } else if (e.key === "Escape" && isPseudoFullscreen) {
        setIsPseudoFullscreen(false);
        setIsFullscreen(false);
      } else if (mediaDurationRef.current > 0 && e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        seekTo(mediaDurationRef.current * (parseInt(e.key, 10) / 10));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHidden, isPseudoFullscreen, togglePlayPause, skipBy, handleSetVolume, handleToggleFullscreen, seekTo]);

  // Canvas single-click (play/pause) & double-click (skip -10s / +10s / fullscreen).
  // Touch/pen: a tap while the controls are hidden only reveals them (no pause). Mouse keeps
  // toggling: hovering already shows the controls, and a still mouse should still click-pause.
  // The snapshot is taken on press, before the player's touchstart/mousemove reveal them.
  const handleCanvasPointerDown = (e) => {
    tapRevealOnlyRef.current = e.pointerType !== "mouse" && controlsHiddenNowRef.current;
    audioLockedOnPressRef.current = Boolean(engineRef.current?.isAudioLocked());
  };
  const handleCanvasTouchStart = () => {
    // Browsers without Pointer Events; otherwise pointerdown already set the same snapshot.
    if (typeof window !== "undefined" && !window.PointerEvent) {
      tapRevealOnlyRef.current = controlsHiddenNowRef.current;
      audioLockedOnPressRef.current = Boolean(engineRef.current?.isAudioLocked());
    }
  };

  const handleCanvasClick = (e) => {
    const revealOnly = tapRevealOnlyRef.current;
    const wasAudioLocked = audioLockedOnPressRef.current;
    tapRevealOnlyRef.current = false;
    audioLockedOnPressRef.current = false;
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (wasAudioLocked && !isPausedRef.current) {
      tryUnlockAudio(e);
      triggerBezel("unmute");
      showControlsTemporarily();
      return;
    }
    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
    if (now - lastTapTimeRef.current < 280) {
      if (clickToggleTimerRef.current) clearTimeout(clickToggleTimerRef.current);
      lastTapTimeRef.current = 0;
      if (relX < 0.3) skipBy(-10);
      else if (relX > 0.7) skipBy(10);
      else handleToggleFullscreen();
      return;
    }
    lastTapTimeRef.current = now; // a reveal tap can still start a double-tap
    if (revealOnly) {
      showControlsTemporarily();
      return;
    }
    clickToggleTimerRef.current = setTimeout(() => togglePlayPause(true), 220);
  };

  const startDrag = (clientX) => {
    isDraggingSeekRef.current = true;
    setIsDraggingSeek(true);
    const t = updateSeekHoverFromClientX(clientX) * mediaDurationRef.current;
    dragSeekTimeRef.current = t;
    setDisplayTime(t);
  };

  const seekHandlers = {
    onMouseEnter: () => setIsHoveringSeek(true),
    onMouseLeave: () => {
      setIsHoveringSeek(false);
      if (!isDraggingSeekRef.current) setHoverPct(0);
    },
    onMouseMove: (e) => {
      const ratio = updateSeekHoverFromClientX(e.clientX);
      if (isDraggingSeekRef.current && mediaDurationRef.current > 0) {
        const t = ratio * mediaDurationRef.current;
        dragSeekTimeRef.current = t;
        setDisplayTime(t);
      }
    },
    onMouseDown: (e) => {
      if (mediaDurationRef.current <= 0) return;
      e.preventDefault();
      startDrag(e.clientX);
    },
    onTouchStart: (e) => {
      if (mediaDurationRef.current <= 0 || !e.touches.length) return;
      startDrag(e.touches[0].clientX);
    },
    onTouchMove: (e) => {
      if (!isDraggingSeekRef.current || !e.touches.length) return;
      const t = updateSeekHoverFromClientX(e.touches[0].clientX) * mediaDurationRef.current;
      dragSeekTimeRef.current = t;
      setDisplayTime(t);
    },
    onTouchEnd: () => {
      if (!isDraggingSeekRef.current) return;
      isDraggingSeekRef.current = false;
      setIsDraggingSeek(false);
      setHoverPct(0);
      seekTo(dragSeekTimeRef.current);
    }
  };

  if (!supported) {
    return (
      <div className="yt-drive-player paused">
        <div className="yt-top-bar">
          <div className="yt-top-left">
            <span className="yt-drive-tag">⚡ WEBCODECS</span>
            <span className="yt-ch-title">{displayChannelName}</span>
          </div>
        </div>
        <div className="yt-buffering-overlay">
          <div className="yt-buffering-text">
            This browser does not support WebCodecs VideoDecoder.
          </div>
        </div>
      </div>
    );
  }

  const playedPct = duration > 0 ? Math.max(0, Math.min(100, (displayTime / duration) * 100)) : 0;
  const syncLabelTxt = (syncOffsetMs > 0 ? "+" : "") + syncOffsetMs + "ms";
  const controlsAreHidden = controlsHidden && !isPaused && !settingsOpen && !isDraggingSeek;
  controlsHiddenNowRef.current = controlsAreHidden;

  return (
    <div
      ref={playerBoxRef}
      className={`yt-drive-player yt-webcodecs-player ${isPaused ? "paused" : ""} ${
        controlsAreHidden ? "controls-hidden" : ""
      } ${isPseudoFullscreen ? "pseudo-fullscreen" : ""}`}
      onMouseMove={showControlsTemporarily}
      onTouchStart={showControlsTemporarily}
      onMouseLeave={() => {
        if (!isPaused && !settingsOpen && !isDraggingSeek) setControlsHidden(true);
      }}
    >
      {audioLocked && !isMuted && !isEnded && !errorText && !isHidden && (
        <button
          type="button"
          className="yt-audio-toast"
          role="status"
          aria-live="polite"
          onClick={(e) => {
            e.stopPropagation();
            tryUnlockAudio(e);
            triggerBezel("unmute");
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
          </svg>
          <span>Tap anywhere on the page to enable audio</span>
        </button>
      )}

      <PlayerTopBar
        tag="⚡ WEBCODECS"
        title={displayChannelName}
        isBuffering={isBuffering}
        bufferedAheadSec={bufferedAheadSec}
        fps={fps}
        statusText={statusText}
      />

      <div
        className="yt-canvas-ClickArea"
        ref={canvasHostRef}
        onPointerDown={handleCanvasPointerDown}
        onTouchStart={handleCanvasTouchStart}
        onClick={handleCanvasClick}
      />

      {errorText ? (
        <div className="yt-buffering-overlay">
          <div className="yt-buffering-text">{errorText}</div>
          <button
            type="button"
            className="yt-pill-btn"
            onClick={(e) => {
              e.stopPropagation();
              rebuildEngineHere();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        isBuffering && !isPaused && <BufferingOverlay bufferedAheadSec={bufferedAheadSec} />
      )}

      <PlayerBezel type={bezelType} bezelKey={bezelKey} />
      <SkipIndicators leftLabel={skipLeftLabel} rightLabel={skipRightLabel} />
      <StatsPanel open={statsOpen} lines={statsLines} onClose={() => setStatsOpen(false)} />

      <SettingsMenu
        menuRef={settingsMenuRef}
        open={settingsOpen}
        playbackSpeed={playbackSpeed}
        quality={quality}
        fpsSetting={fpsSetting}
        streamFps={streamFps}
        bufferMode={bufferMode}
        bufferTarget={bufferTargetRef.current}
        syncLabelTxt={syncLabelTxt}
        loopEnabled={loopEnabled}
        statsOpen={statsOpen}
        onSetSpeed={handleSetSpeed}
        onSetQuality={handleSetQuality}
        onSetFps={handleSetFps}
        onSetBufferTarget={handleSetBufferTarget}
        onAdjustSync={handleAdjustSync}
        onResetSync={handleResetSync}
        onToggleLoop={handleToggleLoop}
        onToggleStats={() => setStatsOpen((prev) => !prev)}
      />

      <div className="yt-bottom" onClick={(e) => e.stopPropagation()}>
        <SeekBar
          wrapRef={progressWrapRef}
          isDragging={isDraggingSeek}
          isHovering={isHoveringSeek}
          hoverPct={hoverPct}
          hoverTimeText={hoverTimeText}
          bufferedPct={bufferedPct}
          playedPct={playedPct}
          handlers={seekHandlers}
        />
        <ControlBar
          isPaused={isPaused}
          isEnded={isEnded}
          isMuted={isMuted}
          volumePct={volumePct}
          displayTime={displayTime}
          duration={duration}
          syncLabelTxt={syncLabelTxt}
          quality={quality}
          isFullscreen={isFullscreen}
          settingsBtnRef={settingsBtnRef}
          volumeLabel="WebCodecs player volume"
          onTogglePlay={() => togglePlayPause(true)}
          onSkip={skipBy}
          onToggleMute={() => handleToggleMute(false)}
          onSetVolume={handleSetVolume}
          onAdjustSync={handleAdjustSync}
          onResetSync={handleResetSync}
          onToggleSettings={(e) => {
            e.stopPropagation();
            setSettingsOpen((prev) => !prev);
            showControlsTemporarily();
          }}
          onToggleTheater={onToggleTheater}
          onToggleFullscreen={handleToggleFullscreen}
        />
      </div>
    </div>
  );
});

export default WebCodecsPlayer;
