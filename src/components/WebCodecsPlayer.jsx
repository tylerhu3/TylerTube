// WebCodecs player: H.264 + PCM over the Drive WebSocket (/ws/mpeg1?codec=webcodecs), decoded by
// VideoDecoder onto a canvas, audio on an AudioContext that is also the master clock.
// Engine: webcodecs/WebCodecsEngine.js. Same props and imperative handle as DriveVideoPlayer.
import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle
} from "react";
import { APP_VERSION } from "../version";
import { formatDriveTime } from "./drive/driveUtils";
import DriveSettingsMenu from "./drive/DriveSettingsMenu";
import {
  PlayerTopBar,
  BufferingOverlay,
  PlayerBezel,
  SkipIndicators,
  StatsPanel,
  SeekBar,
  ControlBar
} from "./drive/PlayerChrome";
import { WebCodecsEngine } from "./webcodecs/WebCodecsEngine";
import { isWebCodecsSupported } from "./webcodecs/protocol";
import { mediaTimeFromStream } from "./webcodecs/scheduler";

const WebCodecsPlayer = forwardRef(function WebCodecsPlayer(
  {
    video,
    savedTime = 0,
    onTimeUpdate,
    onEnded,
    isHidden = false,
    onToggleTheater,
    onSwitchToStandard
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
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [syncOffsetMs, setSyncOffsetMs] = useState(0);
  const [fps, setFps] = useState(0);
  const [statusText, setStatusText] = useState("Starting WebCodecs stream...");
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

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onEndedRef.current = onEnded;
    videoIdRef.current = video?.id;
    initialSavedTimeRef.current = savedTime;
  }, [onTimeUpdate, onEnded, video?.id, savedTime]);

  const targetFile = video?.src || "";
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

  const tryUnlockAudio = useCallback(() => {
    if (engineRef.current) engineRef.current.unlockAudio();
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
      if (withBezel) triggerBezel(nextPaused ? "pause" : "play");
      showControlsTemporarily();
    },
    [seekTo, showControlsTemporarily, triggerBezel, tryUnlockAudio]
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
      const clamped = Math.max(0, Math.min(1, val));
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
    document.addEventListener("keydown", tryUnlockAudio, true);
    return () => {
      document.removeEventListener("click", tryUnlockAudio, true);
      document.removeEventListener("touchstart", tryUnlockAudio, true);
      document.removeEventListener("keydown", tryUnlockAudio, true);
    };
  }, [tryUnlockAudio]);

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

    const startSeek =
      Number(initialSavedTimeRef.current) > 0 ? Number(initialSavedTimeRef.current) : 0;

    isPausedRef.current = false;
    isEndedRef.current = false;
    seekBaseTimeRef.current = startSeek;
    currentMediaTimeRef.current = startSeek;
    mediaDurationRef.current = 0;
    lastReportedSecondRef.current = -1;

    setIsPaused(false);
    setIsEnded(false);
    setIsBuffering(true);
    setBufferedAheadSec(0);
    setBufferedPct(0);
    setDisplayTime(startSeek);
    setDuration(0);
    setFps(0);
    setStatusText("Starting WebCodecs stream...");
    showControlsTemporarily();

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      `${wsProtocol}//${window.location.host}/ws/mpeg1?file=${encodeURIComponent(targetFile)}` +
      `&quality=${currentQualityRef.current}` +
      `&speed=${playbackSpeedRef.current}` +
      `&seek=${startSeek.toFixed(2)}` +
      `&loop=${loopEnabledRef.current ? "1" : "0"}` +
      `&codec=webcodecs`;

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
      if (!isDraggingSeekRef.current) setDisplayTime(sk);
    };

    const engine = new WebCodecsEngine({
      url: wsUrl,
      canvas,
      callbacks: {
        onControl: (msg) => {
          if (cancelled) return;
          if (msg.type === "meta") {
            applyStreamInfo(msg);
            loopEnabledRef.current = Boolean(msg.loop);
            setLoopEnabled(Boolean(msg.loop));
          } else if (msg.type === "reset") {
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
        onPlaybackEnded: () => {
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
        },
        onStatus: (text) => {
          if (!cancelled) setStatusText(text);
        },
        onError: (text) => {
          if (!cancelled) setStatusText(`Error: ${text}`);
        }
      }
    });
    engine.setVolume(isMutedRef.current ? 0 : curVolRef.current, isMutedRef.current);
    engine.setSyncOffset(syncOffsetRef.current);
    engine.setRebufferTarget(bufferTargetRef.current);
    engineRef.current = engine;
    tryUnlockAudio();

    const statsTimer = setInterval(() => {
      if (cancelled) return;
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
      const audioLocked = engine.isAudioLocked();
      const offTxt = `${s.avOffsetMs > 0 ? "+" : ""}${s.avOffsetMs}ms`;
      if (s.buffering || isEndedRef.current || isPausedRef.current) {
        // Keep the last status; the top bar shows "Buffering..." itself.
      } else if (audioLocked) {
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
        `Decoder: ${s.decoderState} ${s.codec} (decode queue ${s.decodeQueueSize})`,
        `Frame Queue: ${s.framesQueued} decoded / ${s.encodedQueued} encoded`,
        `Dropped Frames: ${s.droppedFrames} of ${s.decodedFrames} (catch-ups ${s.catchUps}, pre-key ${s.skippedBeforeKey}, errors ${s.decodeErrors})`,
        `Clock: ${s.clockMode}${s.audioGap ? " (audio gap)" : ""}`,
        `Audio: ${s.audioState}, queue ${s.audioQueuedMs} ms, ${s.audioSources} sources, out latency ${s.outputLatencyMs} ms`,
        `A/V Offset: ${offTxt} (frame vs heard audio; sync ${Math.round(syncOffsetRef.current * 1000)} ms)`,
        `Buffer Health: ${s.bufferedAheadSec.toFixed(1)}s (Rebuffer target: ${bufferTargetRef.current}s, underruns ${s.underruns})`,
        `Position: ${formatDriveTime(currentMediaTimeRef.current)}${
          mediaDurationRef.current > 0 ? " / " + formatDriveTime(mediaDurationRef.current) : ""
        }`,
        `Version: ${APP_VERSION}`
      ]);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(statsTimer);
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
      if (host) host.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile, isHidden, supported]);

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
      setHoverTimeText(formatDriveTime(ratio * (mediaDurationRef.current || 0)));
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

  // YouTube keyboard shortcuts (same as DriveVideoPlayer)
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

  // Canvas single-click (play/pause) & double-click (skip -10s / +10s / fullscreen)
  const handleCanvasClick = (e) => {
    if (settingsOpen) {
      setSettingsOpen(false);
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
    lastTapTimeRef.current = now;
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
            This browser has no WebCodecs VideoDecoder. Use the Standard or Drive player.
          </div>
          {onSwitchToStandard && (
            <button type="button" className="yt-stop-btn" onClick={onSwitchToStandard}>
              🎬 Standard
            </button>
          )}
        </div>
      </div>
    );
  }

  const playedPct = duration > 0 ? Math.max(0, Math.min(100, (displayTime / duration) * 100)) : 0;
  const syncLabelTxt = (syncOffsetMs > 0 ? "+" : "") + syncOffsetMs + "ms";

  return (
    <div
      ref={playerBoxRef}
      className={`yt-drive-player yt-webcodecs-player ${isPaused ? "paused" : ""} ${
        controlsHidden && !isPaused && !settingsOpen && !isDraggingSeek ? "controls-hidden" : ""
      } ${isPseudoFullscreen ? "pseudo-fullscreen" : ""}`}
      onMouseMove={showControlsTemporarily}
      onTouchStart={showControlsTemporarily}
      onMouseLeave={() => {
        if (!isPaused && !settingsOpen && !isDraggingSeek) setControlsHidden(true);
      }}
    >
      <PlayerTopBar
        tag="⚡ WEBCODECS"
        title={displayChannelName}
        isBuffering={isBuffering}
        bufferedAheadSec={bufferedAheadSec}
        fps={fps}
        statusText={statusText}
      />

      <div className="yt-canvas-ClickArea" ref={canvasHostRef} onClick={handleCanvasClick} />

      {isBuffering && !isPaused && <BufferingOverlay bufferedAheadSec={bufferedAheadSec} />}

      <PlayerBezel type={bezelType} bezelKey={bezelKey} />
      <SkipIndicators leftLabel={skipLeftLabel} rightLabel={skipRightLabel} />
      <StatsPanel open={statsOpen} lines={statsLines} onClose={() => setStatsOpen(false)} />

      <DriveSettingsMenu
        menuRef={settingsMenuRef}
        open={settingsOpen}
        playbackSpeed={playbackSpeed}
        quality={quality}
        bufferMode={bufferMode}
        bufferTarget={bufferTargetRef.current}
        syncLabelTxt={syncLabelTxt}
        loopEnabled={loopEnabled}
        statsOpen={statsOpen}
        onSetSpeed={handleSetSpeed}
        onSetQuality={handleSetQuality}
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
          onSwitchToStandard={onSwitchToStandard}
        />
      </div>
    </div>
  );
});

export default WebCodecsPlayer;
