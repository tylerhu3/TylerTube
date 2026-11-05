import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle
} from "react";
import { APP_VERSION } from "../version";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const QUALITY_OPTIONS = [360, 480, 720, 1080];

export function formatDriveTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const sStr = s < 10 ? "0" + s : "" + s;
  if (h > 0) {
    const mStr = m < 10 ? "0" + m : "" + m;
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

const BUFFER_OPTIONS = [
  { label: "1s (Fast)", target: 1.0 },
  { label: "2s (Normal)", target: 2.0 },
  { label: "5s (Mobile / Deep)", target: 5.0 }
];

function ensureJSMpegPatched() {
  const JSMpeg = typeof window !== "undefined" ? window.JSMpeg : null;
  if (!JSMpeg) return null;
  if (JSMpeg.__tylertubePatchedV3) return JSMpeg;

  // 1. BitBuffer patch: never discard unread bytes on EVICT overflow; expand buffer instead
  if (JSMpeg.BitBuffer) {
    JSMpeg.BitBuffer.prototype.evict = function (neededBytes) {
      const readBytes = this.index >> 3;
      if (readBytes > 0) {
        if (this.bytes.copyWithin) {
          this.bytes.copyWithin(0, readBytes, this.byteLength);
        } else {
          this.bytes.set(this.bytes.subarray(readBytes, this.byteLength), 0);
        }
        this.byteLength -= readBytes;
        this.index -= readBytes << 3;
      }
    };

    JSMpeg.BitBuffer.prototype.write = function (buffers) {
      const isArray = typeof buffers[0] === "object";
      let totalBytes = 0;
      if (isArray) {
        for (let i = 0; i < buffers.length; i++) totalBytes += buffers[i].byteLength;
      } else {
        totalBytes = buffers.byteLength;
      }
      const available = this.bytes.length - this.byteLength;
      if (totalBytes > available) {
        if (this.mode === JSMpeg.BitBuffer.MODE.EXPAND) {
          const newSize = Math.max(2 * this.bytes.length, this.bytes.length + totalBytes);
          this.resize(newSize);
        } else {
          this.evict(totalBytes);
          // If still insufficient space after evicting read bytes, expand rather than wiping unread data
          if (totalBytes > this.bytes.length - this.byteLength) {
            const newSize = Math.max(
              this.bytes.length * 2,
              this.byteLength + totalBytes + 1024 * 1024
            );
            this.resize(newSize);
          }
        }
      }
      if (isArray) {
        for (let i = 0; i < buffers.length; i++) this.appendSingleBuffer(buffers[i]);
      } else {
        this.appendSingleBuffer(buffers);
      }
      return totalBytes;
    };
  }

  // 2. Safe WebSocket destroy + JSON control message handling + paused seek preview
  if (JSMpeg.Source && JSMpeg.Source.WebSocket) {
    JSMpeg.Source.WebSocket.prototype.destroy = function () {
      clearTimeout(this.reconnectTimeoutId);
      this.shouldAttemptReconnect = false;
      if (this.socket) {
        try {
          this.socket.onclose = null;
          this.socket.onmessage = null;
          this.socket.onerror = null;
          this.socket.onopen = null;
          this.socket.close();
        } catch {
          // Ignore close errors
        }
        this.socket = null;
      }
    };

    const origOnMessage = JSMpeg.Source.WebSocket.prototype.onMessage;
    JSMpeg.Source.WebSocket.prototype.onMessage = function (ev) {
      if (!ev) return;
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (this.options && this.options.onControlMessage) {
            this.options.onControlMessage(msg);
          }
        } catch {
          // Ignore invalid JSON
        }
        return;
      }
      const res = origOnMessage.call(this, ev);
      const p = this.options && this.options.__player;
      if (p && p.__isPaused && p.needsPausedPreview && p.video) {
        if (p.video.decode()) {
          p.needsPausedPreview = false;
        }
      }
      return res;
    };
  }

  // 3. Track exact MPEG-TS 90kHz PTS per frame in Video & Audio decoders (never purge PTS queue on false)
  function patchDecoderPts(DecoderClass) {
    if (!DecoderClass || !DecoderClass.prototype || DecoderClass.__ptsPatched) {
      return;
    }
    const origWrite = DecoderClass.prototype.write;
    const origDecode = DecoderClass.prototype.decode;

    DecoderClass.prototype.write = function (pts, buffers) {
      if (!this.ptsQueue) {
        this.ptsQueue = [];
        this.lastWritePts = -1;
      }
      if (typeof pts === "number" && pts > 0 && pts !== this.lastWritePts) {
        this.lastWritePts = pts;
        this.ptsQueue.push(pts);
        if (this.__onPtsObserved) {
          this.__onPtsObserved(pts);
        }
      }
      return origWrite.call(this, pts, buffers);
    };

    DecoderClass.prototype.decode = function () {
      const ok = origDecode.call(this);
      if (ok) {
        if (this.ptsQueue && this.ptsQueue.length > 0) {
          this.decodedTime = this.ptsQueue.shift();
        }
      }
      return ok;
    };

    DecoderClass.__ptsPatched = true;
  }

  if (JSMpeg.Decoder) {
    patchDecoderPts(JSMpeg.Decoder.MPEG1Video);
    patchDecoderPts(JSMpeg.Decoder.MPEG1VideoWASM);
    patchDecoderPts(JSMpeg.Decoder.MP2Audio);
    patchDecoderPts(JSMpeg.Decoder.MP2AudioWASM);
  }

  // 4. Hardware-clock WebAudio output with suspended-context protection & clean resync
  if (JSMpeg.AudioOutput && JSMpeg.AudioOutput.WebAudio) {
    const WA = JSMpeg.AudioOutput.WebAudio;
    WA.prototype.play = function (sampleRate, left, right) {
      if (!this.enabled || this.__isPaused) return;
      if (this.context && this.context.state !== "running") {
        if (this.context.resume) {
          this.context.resume().catch(() => {});
        }
        const wNow = JSMpeg.Now();
        if (this.wallclockStartTime < wNow) this.wallclockStartTime = wNow;
        this.wallclockStartTime += left.length / sampleRate;
        return;
      }
      this.unlocked = true;
      this.gain.gain.value = this.__isMuted ? 0 : this.volume;
      const buffer = this.context.createBuffer(2, left.length, sampleRate);
      buffer.getChannelData(0).set(left);
      buffer.getChannelData(1).set(right);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.destination);
      const now = this.context.currentTime;
      const duration = buffer.duration;
      if (this.startTime < now) {
        this.startTime = now + 0.04;
        this.wallclockStartTime = JSMpeg.Now() + 0.04;
      }
      source.start(this.startTime);
      this.startTime += duration;
      this.wallclockStartTime += duration;
    };

    WA.prototype.getEnqueuedTime = function () {
      if (this.context && this.context.state === "running") {
        const hwLatency =
          (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
        return (
          Math.max(this.startTime - this.context.currentTime, 0) + hwLatency
        );
      }
      return Math.max(this.wallclockStartTime - JSMpeg.Now(), 0);
    };

    WA.prototype.resetEnqueuedTime = function () {
      if (this.context) {
        try {
          this.gain.disconnect();
          this.gain = this.context.createGain();
          this.gain.gain.value = this.__isMuted ? 0 : this.volume;
          this.destination = this.gain;
          this.gain.connect(this.context.destination);
        } catch {
          // Ignore gain reconnect errors
        }
        this.startTime = this.context.currentTime + 0.04;
      }
      this.wallclockStartTime = JSMpeg.Now() + 0.04;
    };
  }

  // 5. Intelligent Jitter Buffer + Smooth A/V Sync + Underrun Detection
  if (JSMpeg.Player) {
    const origStartLoading = JSMpeg.Player.prototype.startLoading;
    JSMpeg.Player.prototype.startLoading = function () {
      if (this.__destroyed) return;
      const res = origStartLoading.call(this);
      if (this.source && this.source.options) {
        this.source.options.__player = this;
      }
      if (this.video && this.__onPtsObserved) {
        this.video.__onPtsObserved = this.__onPtsObserved;
      }
      if (this.audio && this.__onPtsObserved) {
        this.audio.__onPtsObserved = this.__onPtsObserved;
      }
      if (this.audioOut) {
        this.audioOut.__isPaused = Boolean(this.__isPaused || this.__isBuffering);
        this.audioOut.__isMuted = Boolean(this.__isMuted);
      }
      return res;
    };

    JSMpeg.Player.prototype.destroy = function () {
      this.__destroyed = true;
      this.pause();
      if (this.source) {
        try {
          this.source.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.video) {
        try {
          this.video.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.renderer) {
        try {
          this.renderer.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.audio) {
        try {
          this.audio.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.audioOut) {
        try {
          this.audioOut.destroy();
        } catch {
          // Ignore
        }
      }
    };

    JSMpeg.Player.prototype.updateForStreaming = function () {
      if (this.__destroyed) return;

      // 1. Calculate how much decoded/queued media is buffered ahead
      const vLatest = this.video ? this.video.lastWritePts : -1;
      const aLatest = this.audio ? this.audio.lastWritePts : -1;
      const latestWritePts = Math.max(vLatest, aLatest);

      const vDecoded = this.video ? this.video.decodedTime : 0;
      const aDecoded = this.audio ? this.audio.decodedTime : 0;
      const currentPts = aDecoded > 0 ? aDecoded : vDecoded;

      let bufferedAhead = 0;
      if (latestWritePts > 0 && currentPts > 0 && latestWritePts >= currentPts) {
        bufferedAhead = latestWritePts - currentPts;
      }
      this.__bufferedAhead = bufferedAhead;

      if (this.__onBufferStats) {
        this.__onBufferStats(bufferedAhead, latestWritePts);
      }

      // 2. Check if user paused
      if (this.__isPaused) {
        if (this.needsPausedPreview && this.video) {
          if (this.video.decode()) {
            this.needsPausedPreview = false;
          }
        }
        return;
      }

      const now = JSMpeg.Now();
      const targetBuffer = this.__bufferingTarget || 2.0;
      const dur = this.__mediaDuration || 0;
      const curMedia = this.__currentMediaTime || 0;
      const isNearEnd = dur > 0 && curMedia >= dur - 1.2;
      const effectiveTarget = isNearEnd ? Math.max(0.3, dur - curMedia) : targetBuffer;

      // 3. Handle Buffering State (initial connect, seek, or network starvation)
      if (this.__isBuffering) {
        if (this.needsPausedPreview && this.video) {
          if (this.video.decode()) {
            this.needsPausedPreview = false;
          }
        }

        const waitElapsed = this.__bufferingStartTime ? Date.now() - this.__bufferingStartTime : 0;
        const reachedTarget = bufferedAhead >= effectiveTarget;
        const timedOut = waitElapsed >= 3000 && (bufferedAhead >= 0.4 || isNearEnd);

        if (reachedTarget || timedOut) {
          this.__isBuffering = false;
          if (this.audioOut) {
            this.audioOut.__isPaused = false;
            this.audioOut.resetEnqueuedTime();
          }
          if (this.__onBufferingStateChange) {
            this.__onBufferingStateChange(false, bufferedAhead);
          }
          this.lastVideoWallTime = now;
        } else {
          // Still buffering: hold WebAudio and do not advance video
          if (this.audioOut) {
            this.audioOut.__isPaused = true;
          }
          if (this.__onBufferingStateChange) {
            this.__onBufferingStateChange(true, bufferedAhead);
          }
          return;
        }
      }

      // 4. Decode audio frames into WebAudio with controlled lookahead (~0.45s)
      // This prevents dumping huge amounts into WebAudio while preserving the compressed buffer
      if (this.audio && this.audioOut) {
        const TARGET_AUDIO_AHEAD = 0.45;
        let loopCount = 0;
        while (
          this.audioOut.enqueuedTime < TARGET_AUDIO_AHEAD &&
          loopCount < 16
        ) {
          const decoded = this.audio.decode();
          if (!decoded) break;
          loopCount++;
        }
        this.audioOut.enabled = true;
      }

      if (!this.video) return;

      // 5. Starvation / buffer underrun detection during active playback
      const hasQueuedVideo = Boolean(this.video.ptsQueue && this.video.ptsQueue.length > 0);
      const isStarved =
        !isNearEnd &&
        bufferedAhead < 0.2 &&
        !hasQueuedVideo &&
        (!this.audio || !this.audio.ptsQueue || this.audio.ptsQueue.length === 0);

      if (isStarved) {
        this.__isBuffering = true;
        this.__bufferingStartTime = Date.now();
        this.__bufferingTarget = Math.max(targetBuffer, 2.2);
        if (this.audioOut) {
          this.audioOut.__isPaused = true;
          this.audioOut.resetEnqueuedTime();
        }
        if (this.__onBufferingStateChange) {
          this.__onBufferingStateChange(true, bufferedAhead);
        }
        return;
      }

      // 6. Video decoding synchronized to audible sound coming from speakers
      const hasAudioClock =
        this.audio &&
        this.audio.canPlay &&
        this.audio.decodedTime > 0 &&
        (!this.audioOut ||
          !this.audioOut.context ||
          this.audioOut.context.state === "running");

      if (!hasAudioClock) {
        const frameDur = 1 / (this.video.frameRate || 30);
        if (
          !this.lastVideoWallTime ||
          now - this.lastVideoWallTime >= frameDur - 0.004
        ) {
          if (this.video.decode()) {
            this.lastVideoWallTime = now;
          }
        }
        return;
      }

      const offset = this.syncOffset || 0;
      const audibleAudioPts = Math.max(
        0,
        this.audio.decodedTime - (this.audioOut ? this.audioOut.enqueuedTime : 0)
      );
      const targetAudioPts = audibleAudioPts + offset;

      let videoPts = this.video.decodedTime;
      const frameStep = 1 / (this.video.frameRate || 30);
      let nextVideoPts =
        this.video.ptsQueue && this.video.ptsQueue.length > 0
          ? this.video.ptsQueue[0]
          : videoPts > 0
            ? videoPts + frameStep
            : 0;

      // Initial frame or large PTS discontinuity
      if (videoPts === 0 || Math.abs(nextVideoPts - targetAudioPts) > 3.0) {
        this.video.decode();
        return;
      }

      const tolerance = 0.5 * frameStep;
      const lag = targetAudioPts - nextVideoPts;
      const maxCatchupFrames = lag > 0.25 ? 8 : 3;
      let decodedCount = 0;

      while (
        decodedCount < maxCatchupFrames &&
        nextVideoPts <= targetAudioPts + tolerance
      ) {
        if (!this.video.decode()) break;
        decodedCount++;
        videoPts = this.video.decodedTime;
        nextVideoPts =
          this.video.ptsQueue && this.video.ptsQueue.length > 0
            ? this.video.ptsQueue[0]
            : videoPts + frameStep;
      }
    };
  }

  JSMpeg.__tylertubePatchedV3 = true;
  return JSMpeg;
}

function flushPlayerBuffers(player) {
  if (!player) return;
  player.__bufferedAhead = 0;
  if (player.demuxer) {
    player.demuxer.leftoverBytes = null;
    player.demuxer.bits = null;
    player.demuxer.pidsToStreamIds = {};
    for (const sid in player.demuxer.pesPacketInfo) {
      const info = player.demuxer.pesPacketInfo[sid];
      if (info) {
        info.currentLength = 0;
        info.totalLength = 0;
        info.pts = 0;
        info.buffers = [];
      }
    }
  }
  if (player.video) {
    if (player.video.decoder) {
      player.video.destroy();
      player.video.decoder = null;
      player.video.hasSequenceHeader = false;
    } else if (player.video.bits) {
      player.video.bits.index = 0;
      player.video.bits.byteLength = 0;
    }
    player.video.ptsQueue = [];
    player.video.lastWritePts = -1;
    player.video.decodedTime = 0;
    player.video.startTime = -1;
  }
  if (player.audio) {
    if (player.audio.decoder) {
      player.audio.destroy();
      player.audio.decoder = null;
    } else if (player.audio.bits) {
      player.audio.bits.index = 0;
      player.audio.bits.byteLength = 0;
    }
    player.audio.ptsQueue = [];
    player.audio.lastWritePts = -1;
    player.audio.decodedTime = 0;
    player.audio.startTime = -1;
  }
  if (player.audioOut) {
    player.audioOut.resetEnqueuedTime();
  }
}

const DriveVideoPlayer = forwardRef(function DriveVideoPlayer(
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
  const playerBoxRef = useRef(null);
  const canvasHostRef = useRef(null);
  const progressWrapRef = useRef(null);
  const settingsMenuRef = useRef(null);
  const settingsBtnRef = useRef(null);
  const playerRef = useRef(null);

  // Mutable playback tracking refs for high-frequency decode callbacks
  const firstStreamPtsRef = useRef(null);
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
  const isBufferingRef = useRef(true);

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
  const [statusText, setStatusText] = useState("Starting local video...");
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
    const p = playerRef.current;
    if (
      p &&
      p.source &&
      p.source.socket &&
      p.source.socket.readyState === 1
    ) {
      try {
        p.source.socket.send(JSON.stringify(payload));
        return true;
      } catch {
        // Ignore send errors
      }
    }
    return false;
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setControlsHidden(false);
    if (controlsHideTimerRef.current) {
      clearTimeout(controlsHideTimerRef.current);
    }
    if (
      !isPausedRef.current &&
      !isDraggingSeekRef.current
    ) {
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
      skipLeftTimerRef.current = setTimeout(() => {
        setSkipLeftLabel("");
      }, 650);
    } else {
      setSkipRightLabel(label || "10s »");
      if (skipRightTimerRef.current) clearTimeout(skipRightTimerRef.current);
      skipRightTimerRef.current = setTimeout(() => {
        setSkipRightLabel("");
      }, 650);
    }
  }, []);

  const tryUnlockAudio = useCallback(() => {
    const p = playerRef.current;
    if (
      p &&
      p.audioOut &&
      p.audioOut.context &&
      p.audioOut.context.state !== "running"
    ) {
      p.audioOut.context
        .resume()
        .then(() => {
          if (playerRef.current && playerRef.current.audioOut) {
            playerRef.current.audioOut.resetEnqueuedTime();
          }
        })
        .catch(() => {});
    }
  }, []);

  const seekTo = useCallback(
    (targetSec) => {
      const p = playerRef.current;
      if (!p) return;
      const dur = mediaDurationRef.current > 0 ? mediaDurationRef.current : 0;
      let clamped = Number(targetSec) || 0;
      if (dur > 0) {
        clamped = Math.max(0, Math.min(dur - 0.1, clamped));
      } else {
        clamped = Math.max(0, clamped);
      }
      isEndedRef.current = false;
      setIsEnded(false);
      isBufferingRef.current = true;
      setIsBuffering(true);
      seekBaseTimeRef.current = clamped;
      currentMediaTimeRef.current = clamped;
      firstStreamPtsRef.current = null;
      setDisplayTime(clamped);

      if (p) {
        p.__isBuffering = true;
        p.__bufferingStartTime = Date.now();
        p.__bufferingTarget = bufferTargetRef.current;
        p.__currentMediaTime = clamped;
        p.needsPausedPreview = true;
        if (p.audioOut) {
          p.audioOut.__isPaused = true;
          p.audioOut.resetEnqueuedTime();
        }
      }
      showControlsTemporarily();
      sendWsCommand({ type: "seek", time: clamped });

      if (videoIdRef.current && onTimeUpdateRef.current) {
        onTimeUpdateRef.current(videoIdRef.current, clamped, dur, {
          force: true
        });
      }
    },
    [sendWsCommand, showControlsTemporarily]
  );

  const skipBy = useCallback(
    (deltaSec) => {
      if (!playerRef.current) return;
      const dur = mediaDurationRef.current;
      let target = currentMediaTimeRef.current + deltaSec;
      if (dur > 0) {
        target = Math.max(0, Math.min(dur - 0.1, target));
      } else {
        target = Math.max(0, target);
      }
      const label =
        (deltaSec < 0 ? "« " : "") +
        Math.abs(deltaSec) +
        "s" +
        (deltaSec > 0 ? " »" : "");
      triggerSkipIndicator(deltaSec, label);
      seekTo(target);
    },
    [seekTo, triggerSkipIndicator]
  );

  const togglePlayPause = useCallback(
    (withBezel = true) => {
      const p = playerRef.current;
      if (!p) return;
      tryUnlockAudio();

      if (isEndedRef.current) {
        isEndedRef.current = false;
        isPausedRef.current = false;
        p.__isPaused = false;
        if (p.audioOut) p.audioOut.__isPaused = false;
        setIsEnded(false);
        setIsPaused(false);
        seekTo(0);
        sendWsCommand({ type: "resume" });
        if (withBezel) triggerBezel("play");
        showControlsTemporarily();
        return;
      }

      const nextPaused = !isPausedRef.current;
      isPausedRef.current = nextPaused;
      p.__isPaused = nextPaused;
      if (p.audioOut) {
        p.audioOut.__isPaused = nextPaused;
        p.audioOut.resetEnqueuedTime();
      }
      setIsPaused(nextPaused);

      if (nextPaused) {
        sendWsCommand({ type: "pause" });
        if (withBezel) triggerBezel("pause");
      } else {
        sendWsCommand({ type: "resume" });
        if (withBezel) triggerBezel("play");
      }
      showControlsTemporarily();
    },
    [
      seekTo,
      sendWsCommand,
      showControlsTemporarily,
      triggerBezel,
      tryUnlockAudio
    ]
  );

  const applyVolumeToPlayer = useCallback((vol, muted) => {
    const effVol = muted ? 0 : vol;
    setVolumePct(Math.round(effVol * 100));
    setIsMuted(muted || effVol === 0);
    const p = playerRef.current;
    if (p) {
      p.volume = effVol;
      p.__isMuted = muted || effVol === 0;
      if (p.audioOut) {
        p.audioOut.__isMuted = muted || effVol === 0;
        if (p.audioOut.gain) {
          p.audioOut.gain.gain.value = effVol;
        }
      }
    }
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
      applyVolumeToPlayer(clamped, isMutedRef.current);
      tryUnlockAudio();
    },
    [applyVolumeToPlayer, tryUnlockAudio]
  );

  const handleToggleMute = useCallback(
    (withBezel = false) => {
      if (isMutedRef.current) {
        isMutedRef.current = false;
        curVolRef.current =
          prevVolBeforeMuteRef.current > 0.05
            ? prevVolBeforeMuteRef.current
            : 0.5;
        if (withBezel) triggerBezel("unmute");
      } else {
        prevVolBeforeMuteRef.current = curVolRef.current;
        isMutedRef.current = true;
        if (withBezel) triggerBezel("mute");
      }
      applyVolumeToPlayer(curVolRef.current, isMutedRef.current);
      tryUnlockAudio();
    },
    [applyVolumeToPlayer, triggerBezel, tryUnlockAudio]
  );

  const handleSetSpeed = useCallback(
    (spd) => {
      playbackSpeedRef.current = spd;
      setPlaybackSpeed(spd);
      seekBaseTimeRef.current = currentMediaTimeRef.current;
      firstStreamPtsRef.current = null;
      sendWsCommand({
        type: "speed",
        speed: spd,
        currentTime: currentMediaTimeRef.current
      });
    },
    [sendWsCommand]
  );

  const handleSetQuality = useCallback(
    (q) => {
      currentQualityRef.current = q;
      setQuality(q);
      seekBaseTimeRef.current = currentMediaTimeRef.current;
      firstStreamPtsRef.current = null;
      sendWsCommand({
        type: "quality",
        quality: q,
        currentTime: currentMediaTimeRef.current
      });
    },
    [sendWsCommand]
  );

  const handleToggleLoop = useCallback(() => {
    const next = !loopEnabledRef.current;
    loopEnabledRef.current = next;
    setLoopEnabled(next);
    sendWsCommand({ type: "loop", loop: next });
  }, [sendWsCommand]);

  const handleAdjustSync = useCallback((deltaSec) => {
    const next = Math.round((syncOffsetRef.current + deltaSec) * 10) / 10;
    syncOffsetRef.current = next;
    setSyncOffsetMs(Math.round(next * 1000));
    if (playerRef.current) {
      playerRef.current.syncOffset = next;
    }
  }, []);

  const handleResetSync = useCallback(() => {
    syncOffsetRef.current = 0;
    setSyncOffsetMs(0);
    if (playerRef.current) {
      playerRef.current.syncOffset = 0;
      if (playerRef.current.audioOut) {
        playerRef.current.audioOut.resetEnqueuedTime();
      }
    }
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    const box = playerBoxRef.current;
    if (!box) return;
    const isNativeFs = Boolean(
      document.fullscreenElement || document.webkitFullscreenElement
    );
    if (isNativeFs || isPseudoFullscreen) {
      if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (
        document.webkitExitFullscreen &&
        document.webkitFullscreenElement
      ) {
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

  // Expose seekTo / skipBy to parent VideoPlayer so external buttons (-10s, +10s, Start Over) work in Drive mode
  useImperativeHandle(
    ref,
    () => ({
      seekTo,
      skipBy,
      togglePlayPause
    }),
    [seekTo, skipBy, togglePlayPause]
  );

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(
        document.fullscreenElement || document.webkitFullscreenElement
      );
      setIsFullscreen(active || isPseudoFullscreen);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, [isPseudoFullscreen]);

  // Close settings menu when clicking outside
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

  // Unlock WebAudio context on user interaction
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

  // Main JSMpeg stream lifecycle when video / visibility changes
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || isHidden || !targetFile) {
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // Ignore
        }
        playerRef.current = null;
      }
      if (host) host.innerHTML = "";
      return;
    }

    const JSMpeg = ensureJSMpegPatched();
    if (!JSMpeg || !JSMpeg.Player) {
      setStatusText("Error: jsmpeg.min.js not loaded");
      return;
    }

    let cancelled = false;
    let fpsCount = 0;
    let lastFpsTime = Date.now();
    let lastReportedSecond = -1;

    // Clean up previous player
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        // Ignore
      }
      playerRef.current = null;
    }
    host.innerHTML = "";

    const nc = document.createElement("canvas");
    nc.width = 1280;
    nc.height = 720;
    nc.className = "yt-drive-canvas";
    host.appendChild(nc);

    const startSeek =
      Number(initialSavedTimeRef.current) > 0
        ? Number(initialSavedTimeRef.current)
        : 0;

    isPausedRef.current = false;
    isEndedRef.current = false;
    isBufferingRef.current = true;
    firstStreamPtsRef.current = null;
    seekBaseTimeRef.current = startSeek;
    currentMediaTimeRef.current = startSeek;
    mediaDurationRef.current = 0;

    setIsPaused(false);
    setIsEnded(false);
    setIsBuffering(true);
    setBufferedAheadSec(0);
    setBufferedPct(0);
    setDisplayTime(startSeek);
    setDuration(0);
    setFps(0);
    setStatusText("Starting local video...");
    showControlsTemporarily();

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      `${wsProtocol}//${window.location.host}/ws/mpeg1?file=${encodeURIComponent(
        targetFile
      )}&channel=${encodeURIComponent(targetFile)}` +
      `&quality=${currentQualityRef.current}` +
      `&speed=${playbackSpeedRef.current}` +
      `&seek=${startSeek.toFixed(2)}` +
      `&loop=${loopEnabledRef.current ? "1" : "0"}`;

    const player = new JSMpeg.Player(wsUrl, {
      canvas: nc,
      audio: true,
      streaming: true,
      videoBufferSize: 16 * 1024 * 1024,
      audioBufferSize: 4 * 1024 * 1024,
      maxAudioLag: 2.0,
      pauseWhenHidden: false,
      preserveDrawingBuffer: true,
      onControlMessage: (msg) => {
        if (cancelled || !msg) return;
        if (msg.type === "meta") {
          const dur = parseFloat(msg.duration) || 0;
          const sk = parseFloat(msg.seekTime) || 0;
          const spd = parseFloat(msg.speed) || 1;
          const q = parseInt(msg.quality, 10) || 720;
          mediaDurationRef.current = dur;
          seekBaseTimeRef.current = sk;
          currentMediaTimeRef.current = sk;
          playbackSpeedRef.current = spd;
          currentQualityRef.current = q;
          loopEnabledRef.current = Boolean(msg.loop);
          if (playerRef.current) {
            playerRef.current.__mediaDuration = dur;
            playerRef.current.__currentMediaTime = sk;
          }
          setDuration(dur);
          setDisplayTime(sk);
          setPlaybackSpeed(spd);
          setQuality(q);
          setLoopEnabled(Boolean(msg.loop));
        } else if (msg.type === "reset") {
          flushPlayerBuffers(playerRef.current);
          firstStreamPtsRef.current = null;
          isBufferingRef.current = true;
          setIsBuffering(true);
          const sk = parseFloat(msg.seekTime) || 0;
          seekBaseTimeRef.current = sk;
          currentMediaTimeRef.current = sk;
          if (playerRef.current) {
            playerRef.current.__isBuffering = true;
            playerRef.current.__bufferingStartTime = Date.now();
            playerRef.current.__bufferingTarget = bufferTargetRef.current;
            playerRef.current.__currentMediaTime = sk;
          }
          if (msg.duration) {
            mediaDurationRef.current =
              parseFloat(msg.duration) || mediaDurationRef.current;
            setDuration(mediaDurationRef.current);
            if (playerRef.current) {
              playerRef.current.__mediaDuration = mediaDurationRef.current;
            }
          }
          if (msg.speed) {
            playbackSpeedRef.current =
              parseFloat(msg.speed) || playbackSpeedRef.current;
            setPlaybackSpeed(playbackSpeedRef.current);
          }
          if (msg.quality) {
            currentQualityRef.current =
              parseInt(msg.quality, 10) || currentQualityRef.current;
            setQuality(currentQualityRef.current);
          }
          if (isPausedRef.current && playerRef.current) {
            playerRef.current.needsPausedPreview = true;
          }
          if (!isDraggingSeekRef.current) {
            setDisplayTime(sk);
          }
        } else if (msg.type === "ended") {
          isEndedRef.current = true;
          isPausedRef.current = true;
          isBufferingRef.current = false;
          setIsBuffering(false);
          if (playerRef.current) {
            playerRef.current.__isBuffering = false;
            playerRef.current.__isPaused = true;
            if (playerRef.current.audioOut) {
              playerRef.current.audioOut.__isPaused = true;
              playerRef.current.audioOut.resetEnqueuedTime();
            }
          }
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
          if (onEndedRef.current) {
            onEndedRef.current();
          }
        } else if (msg.message) {
          setStatusText(msg.message);
        }
      },
      onVideoDecode: () => {
        const p = playerRef.current;
        if (cancelled || !p) return;
        fpsCount++;

        p.__mediaDuration = mediaDurationRef.current;
        p.__currentMediaTime = currentMediaTimeRef.current;

        const vPts = p.video ? p.video.decodedTime : 0;
        const aPts =
          p.audio && p.audio.decodedTime > 0 ? p.audio.currentTime : vPts;
        const activePts = aPts > 0 ? aPts : vPts;

        if (firstStreamPtsRef.current === null && activePts > 0) {
          firstStreamPtsRef.current = activePts;
        }

        if (
          firstStreamPtsRef.current !== null &&
          activePts >= firstStreamPtsRef.current
        ) {
          const elapsed = activePts - firstStreamPtsRef.current;
          const computed =
            seekBaseTimeRef.current + elapsed * playbackSpeedRef.current;
          const dur = mediaDurationRef.current;
          const clamped = dur > 0 ? Math.min(dur, computed) : computed;
          currentMediaTimeRef.current = clamped;
          p.__currentMediaTime = clamped;

          if (!isDraggingSeekRef.current) {
            setDisplayTime(clamped);
          }

          // Report progress back to TylerTube once per second
          const wholeSec = Math.floor(clamped);
          if (
            wholeSec > 0 &&
            wholeSec !== lastReportedSecond &&
            videoIdRef.current &&
            onTimeUpdateRef.current
          ) {
            lastReportedSecond = wholeSec;
            onTimeUpdateRef.current(videoIdRef.current, clamped, dur, {
              force: false
            });
          }
        }

        const now = Date.now();
        if (now - lastFpsTime >= 1000) {
          const currentFps = fpsCount;
          setFps(currentFps);
          fpsCount = 0;
          lastFpsTime = now;

          const audioLocked = Boolean(
            p.audioOut &&
              p.audioOut.context &&
              p.audioOut.context.state !== "running"
          );
          let driftMs = 0;
          if (
            p.audio &&
            p.video &&
            p.audio.decodedTime > 0 &&
            p.video.decodedTime > 0
          ) {
            const audibleAudioPts = Math.max(
              0,
              p.audio.decodedTime - (p.audioOut ? p.audioOut.enqueuedTime : 0)
            );
            driftMs = Math.round(
              (p.video.decodedTime -
                (audibleAudioPts + (p.syncOffset || 0))) *
                1000
            );
          }

          const bufSec = p.__bufferedAhead || 0;
          if (isBufferingRef.current) {
            setStatusText(`Buffering... (${bufSec.toFixed(1)}s)`);
          } else if (audioLocked) {
            setStatusText("Tap anywhere to unmute");
          } else if (
            p.audio &&
            p.video &&
            p.audio.decodedTime > 0 &&
            p.video.decodedTime > 0
          ) {
            setStatusText(
              `Playing (Δ ${driftMs > 0 ? "+" : ""}${driftMs}ms)`
            );
          } else {
            setStatusText("Playing");
          }

          const audioQueueMs = p.audioOut
            ? Math.round(p.audioOut.enqueuedTime * 1000)
            : 0;
          setStatsLines([
            `Source: ${displayChannelName} (VOD)`,
            `Resolution: ${nc.width}x${nc.height} @ ${currentFps} fps`,
            `Quality / Speed: ${currentQualityRef.current}p / ${playbackSpeedRef.current}x`,
            `Buffer Health: ${bufSec.toFixed(1)}s (Target: ${bufferTargetRef.current}s)`,
            `Buffer Status: ${isBufferingRef.current ? "Buffering (Waiting for data)" : "Healthy"}`,
            `A/V Drift: ${driftMs > 0 ? "+" : ""}${driftMs} ms (Sync: ${Math.round(
              syncOffsetRef.current * 1000
            )} ms)`,
            `Audio Queue: ${audioQueueMs} ms (${
              audioLocked ? "locked" : "running"
            })`,
            `Position: ${formatDriveTime(currentMediaTimeRef.current)}${
              mediaDurationRef.current > 0
                ? " / " + formatDriveTime(mediaDurationRef.current)
                : ""
            }`,
            `Version: ${APP_VERSION}`
          ]);
        }
      }
    });

    player.__isBuffering = true;
    player.__bufferingStartTime = Date.now();
    player.__bufferingTarget = bufferTargetRef.current;
    player.__mediaDuration = 0;
    player.__currentMediaTime = startSeek;

    player.__onBufferingStateChange = (buffering, bufSec) => {
      isBufferingRef.current = buffering;
      setIsBuffering(buffering);
      setBufferedAheadSec(Math.max(0, bufSec || 0));
    };

    player.__onBufferStats = (bufSec, latestPts) => {
      const dur = mediaDurationRef.current;
      setBufferedAheadSec(Math.max(0, bufSec || 0));
      if (firstStreamPtsRef.current !== null && dur > 0 && latestPts > 0) {
        const elapsed = latestPts - firstStreamPtsRef.current;
        const bufferedEnd =
          seekBaseTimeRef.current + elapsed * playbackSpeedRef.current;
        const pct = Math.max(0, Math.min(100, (bufferedEnd / dur) * 100));
        setBufferedPct(pct);
      }
    };

    player.__onPtsObserved = (pts) => {
      if (firstStreamPtsRef.current === null && pts > 0) {
        firstStreamPtsRef.current = pts;
      }
    };
    player.__isPaused = false;
    player.__isMuted = isMutedRef.current;
    player.syncOffset = syncOffsetRef.current;
    if (player.source && player.source.options) {
      player.source.options.__player = player;
    }
    if (player.video) {
      player.video.__onPtsObserved = player.__onPtsObserved;
    }
    if (player.audio) {
      player.audio.__onPtsObserved = player.__onPtsObserved;
    }

    playerRef.current = player;
    applyVolumeToPlayer(curVolRef.current, isMutedRef.current);
    tryUnlockAudio();

    return () => {
      cancelled = true;
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // Ignore
        }
        playerRef.current = null;
      }
      if (host) {
        host.innerHTML = "";
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile, isHidden]);

  // Seek bar scrubbing handlers
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
      const pct = ratio * 100;
      setHoverPct(pct);
      const t = ratio * (mediaDurationRef.current || 0);
      setHoverTimeText(formatDriveTime(t));
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
      const ratio = getRatioFromClientX(e.clientX);
      seekTo(ratio * (mediaDurationRef.current || 0));
    };
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWinMouseMove);
      window.removeEventListener("mouseup", onWinMouseUp);
    };
  }, [isDraggingSeek, getRatioFromClientX, seekTo, updateSeekHoverFromClientX]);

  // YouTube Keyboard Shortcuts when DriveVideoPlayer is active
  useEffect(() => {
    if (isHidden) return;
    const onKeyDown = (e) => {
      if (!playerRef.current) return;
      const tag = e.target?.tagName?.toLowerCase() || "";
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      ) {
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
      } else if (
        mediaDurationRef.current > 0 &&
        e.key >= "0" &&
        e.key <= "9"
      ) {
        e.preventDefault();
        const pct = parseInt(e.key, 10) / 10;
        seekTo(mediaDurationRef.current * pct);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isHidden,
    isPseudoFullscreen,
    togglePlayPause,
    skipBy,
    handleSetVolume,
    handleToggleFullscreen,
    seekTo
  ]);

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
      if (clickToggleTimerRef.current) {
        clearTimeout(clickToggleTimerRef.current);
      }
      lastTapTimeRef.current = 0;
      if (relX < 0.3) {
        skipBy(-10);
      } else if (relX > 0.7) {
        skipBy(10);
      } else {
        handleToggleFullscreen();
      }
      return;
    }
    lastTapTimeRef.current = now;
    clickToggleTimerRef.current = setTimeout(() => {
      togglePlayPause(true);
    }, 220);
  };

  const playedPct =
    duration > 0
      ? Math.max(0, Math.min(100, (displayTime / duration) * 100))
      : 0;
  const syncLabelTxt =
    (syncOffsetMs > 0 ? "+" : "") + syncOffsetMs + "ms";

  return (
    <div
      ref={playerBoxRef}
      className={`yt-drive-player ${isPaused ? "paused" : ""} ${
        controlsHidden && !isPaused && !settingsOpen && !isDraggingSeek
          ? "controls-hidden"
          : ""
      } ${isPseudoFullscreen ? "pseudo-fullscreen" : ""}`}
      onMouseMove={showControlsTemporarily}
      onTouchStart={showControlsTemporarily}
      onMouseLeave={() => {
        if (!isPaused && !settingsOpen && !isDraggingSeek) {
          setControlsHidden(true);
        }
      }}
    >
      {/* Top Gradient Info Bar */}
      <div className="yt-top-bar">
        <div className="yt-top-left">
          <span className="yt-drive-tag">🚗 DRIVE</span>
          <span className="yt-ch-title" title={displayChannelName}>
            {displayChannelName}
          </span>
          {isBuffering ? (
            <span className="yt-fps-pill yt-buffering-pill">
              Buffering {bufferedAheadSec.toFixed(1)}s
            </span>
          ) : (
            <span className="yt-fps-pill">{fps} FPS</span>
          )}
          <span className="yt-sub-status">
            {isBuffering ? "Buffering..." : statusText}
          </span>
        </div>
      </div>

      {/* Video Canvas Host */}
      <div
        className="yt-canvas-ClickArea"
        ref={canvasHostRef}
        onClick={handleCanvasClick}
      />

      {/* Centered Buffering Spinner Overlay */}
      {isBuffering && !isPaused && (
        <div className="yt-buffering-overlay">
          <div className="yt-buffering-spinner" />
          <div className="yt-buffering-text">
            Buffering... {bufferedAheadSec > 0 ? `(${bufferedAheadSec.toFixed(1)}s)` : ""}
          </div>
        </div>
      )}

      {/* Center Bezel Feedback Animation */}
      {bezelType && (
        <div key={bezelKey} className="yt-bezel animate">
          <svg viewBox="0 0 24 24">
            {bezelType === "play" && <path d="M8 5v14l11-7z" />}
            {bezelType === "pause" && (
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            )}
            {bezelType === "mute" && (
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            )}
            {bezelType === "unmute" && (
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            )}
          </svg>
        </div>
      )}

      {/* Side Skip Indicators */}
      <div className={`yt-skip-ind left ${skipLeftLabel ? "show" : ""}`}>
        {skipLeftLabel || "« 10s"}
      </div>
      <div className={`yt-skip-ind right ${skipRightLabel ? "show" : ""}`}>
        {skipRightLabel || "10s »"}
      </div>

      {/* Stats for Nerds Panel */}
      <div className={`yt-stats ${statsOpen ? "open" : ""}`}>
        <div className="yt-stats-hdr">
          <span>Stats for nerds</span>
          <span
            className="yt-stats-close"
            onClick={() => setStatsOpen(false)}
            role="button"
            tabIndex={0}
          >
            ✕
          </span>
        </div>
        <div className="yt-stats-body">
          {statsLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      {/* Settings Popup Menu */}
      <div
        ref={settingsMenuRef}
        className={`yt-settings-menu ${settingsOpen ? "open" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="yt-menu-section">
          <div className="yt-menu-label">
            <span>Playback Speed</span>
            <span>{playbackSpeed}x</span>
          </div>
          <div className="yt-chip-row">
            {SPEED_OPTIONS.map((spd) => (
              <button
                key={spd}
                type="button"
                className={`yt-chip ${playbackSpeed === spd ? "active" : ""}`}
                onClick={() => handleSetSpeed(spd)}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        <div className="yt-menu-section">
          <div className="yt-menu-label">
            <span>Quality</span>
            <span>
              {quality}p{quality >= 720 ? " HD" : ""}
            </span>
          </div>
          <div className="yt-chip-row">
            {QUALITY_OPTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className={`yt-chip ${quality === q ? "active" : ""}`}
                onClick={() => handleSetQuality(q)}
              >
                {q}p
              </button>
            ))}
          </div>
        </div>

        <div className="yt-menu-section">
          <div className="yt-menu-label">
            <span>Buffer Headroom</span>
            <span>
              {bufferMode === "fast"
                ? "1s (Fast)"
                : bufferMode === "deep"
                  ? "5s (Mobile / Deep)"
                  : "2s (Normal)"}
            </span>
          </div>
          <div className="yt-chip-row">
            {BUFFER_OPTIONS.map((opt) => (
              <button
                key={opt.target}
                type="button"
                className={`yt-chip ${
                  bufferTargetRef.current === opt.target ? "active" : ""
                }`}
                onClick={() => {
                  bufferTargetRef.current = opt.target;
                  setBufferMode(
                    opt.target === 1.0
                      ? "fast"
                      : opt.target === 5.0
                        ? "deep"
                        : "normal"
                  );
                  if (playerRef.current) {
                    playerRef.current.__bufferingTarget = opt.target;
                  }
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="yt-menu-section">
          <div className="yt-menu-label">
            <span>A/V Sync Offset</span>
            <span>{syncLabelTxt}</span>
          </div>
          <div className="yt-chip-row">
            <button
              type="button"
              className="yt-chip"
              onClick={() => handleAdjustSync(-0.1)}
            >
              -100ms
            </button>
            <button
              type="button"
              className="yt-chip"
              onClick={handleResetSync}
            >
              Reset
            </button>
            <button
              type="button"
              className="yt-chip"
              onClick={() => handleAdjustSync(0.1)}
            >
              +100ms
            </button>
          </div>
        </div>

        <div
          className="yt-menu-toggle"
          onClick={handleToggleLoop}
          role="button"
          tabIndex={0}
        >
          <span>Loop Video</span>
          <div className={`yt-switch ${loopEnabled ? "on" : ""}`} />
        </div>

        <div
          className="yt-menu-toggle"
          onClick={() => setStatsOpen((prev) => !prev)}
          role="button"
          tabIndex={0}
        >
          <span>Stats for nerds</span>
          <div className={`yt-switch ${statsOpen ? "on" : ""}`} />
        </div>

        <div className="yt-menu-version">
          <span>TylerTube</span>
          <span>{APP_VERSION}</span>
        </div>
      </div>

      {/* Bottom Controls & Seek Bar */}
      <div className="yt-bottom" onClick={(e) => e.stopPropagation()}>
        {/* Seek Bar */}
        <div
          ref={progressWrapRef}
          className={`yt-progress-wrap ${isDraggingSeek ? "dragging" : ""}`}
          onMouseEnter={() => setIsHoveringSeek(true)}
          onMouseLeave={() => {
            setIsHoveringSeek(false);
            if (!isDraggingSeekRef.current) setHoverPct(0);
          }}
          onMouseMove={(e) => {
            const ratio = updateSeekHoverFromClientX(e.clientX);
            if (isDraggingSeekRef.current && mediaDurationRef.current > 0) {
              const t = ratio * mediaDurationRef.current;
              dragSeekTimeRef.current = t;
              setDisplayTime(t);
            }
          }}
          onMouseDown={(e) => {
            if (mediaDurationRef.current <= 0) return;
            e.preventDefault();
            isDraggingSeekRef.current = true;
            setIsDraggingSeek(true);
            const ratio = updateSeekHoverFromClientX(e.clientX);
            const t = ratio * mediaDurationRef.current;
            dragSeekTimeRef.current = t;
            setDisplayTime(t);
          }}
          onTouchStart={(e) => {
            if (mediaDurationRef.current <= 0 || !e.touches.length) return;
            isDraggingSeekRef.current = true;
            setIsDraggingSeek(true);
            const ratio = updateSeekHoverFromClientX(e.touches[0].clientX);
            const t = ratio * mediaDurationRef.current;
            dragSeekTimeRef.current = t;
            setDisplayTime(t);
          }}
          onTouchMove={(e) => {
            if (!isDraggingSeekRef.current || !e.touches.length) return;
            const ratio = updateSeekHoverFromClientX(e.touches[0].clientX);
            const t = ratio * mediaDurationRef.current;
            dragSeekTimeRef.current = t;
            setDisplayTime(t);
          }}
          onTouchEnd={() => {
            if (!isDraggingSeekRef.current) return;
            isDraggingSeekRef.current = false;
            setIsDraggingSeek(false);
            setHoverPct(0);
            seekTo(dragSeekTimeRef.current);
          }}
        >
          {(isHoveringSeek || isDraggingSeek) && (
            <div
              className="yt-hover-time"
              style={{
                left: `${Math.max(6, Math.min(94, hoverPct))}%`,
                display: "block"
              }}
            >
              {hoverTimeText}
            </div>
          )}
          <div className="yt-progress-track">
            <div
              className="yt-progress-buffered"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="yt-progress-hover"
              style={{ width: `${hoverPct}%` }}
            />
            <div
              className="yt-progress-played"
              style={{ width: `${playedPct}%` }}
            />
            <div
              className="yt-scrubber"
              style={{ left: `${playedPct}%` }}
            />
          </div>
        </div>

        {/* Control Buttons Row */}
        <div className="yt-bar">
          <div className="yt-left">
            {/* Play / Pause */}
            <button
              type="button"
              className="yt-btn"
              onClick={() => togglePlayPause(true)}
              title="Play/Pause (k)"
            >
              <svg viewBox="0 0 24 24">
                {isEnded ? (
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                ) : isPaused ? (
                  <path d="M8 5v14l11-7z" />
                ) : (
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                )}
              </svg>
            </button>

            {/* Rewind 10s */}
            <button
              type="button"
              className="yt-btn"
              onClick={() => skipBy(-10)}
              title="Rewind 10 seconds (j)"
            >
              <svg viewBox="0 0 24 24">
                <path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
              </svg>
            </button>

            {/* Forward 10s */}
            <button
              type="button"
              className="yt-btn"
              onClick={() => skipBy(10)}
              title="Forward 10 seconds (l)"
            >
              <svg viewBox="0 0 24 24">
                <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
              </svg>
            </button>

            {/* Volume Mute + Slider */}
            <div className="yt-vol-wrap">
              <button
                type="button"
                className="yt-btn"
                onClick={() => handleToggleMute(false)}
                title="Mute/Unmute"
              >
                <svg viewBox="0 0 24 24">
                  {isMuted || volumePct === 0 ? (
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  ) : volumePct < 50 ? (
                    <path d="M7 9v6h4l5 5V4l-5 5H7zm9.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                  ) : (
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  )}
                </svg>
              </button>
              <input
                type="range"
                className="yt-vol-slider"
                min="0"
                max="100"
                value={volumePct}
                onChange={(e) => handleSetVolume(Number(e.target.value) / 100)}
                title="Volume"
                aria-label="Drive player volume"
              />
            </div>

            {/* Time Display */}
            <span className="yt-time">
              {formatDriveTime(displayTime)}
              {duration > 0 ? ` / ${formatDriveTime(duration)}` : ""}
            </span>
          </div>

          <div className="yt-right">
            {/* Quick A/V Sync Offset Buttons */}
            <div className="yt-sync-group">
              <button
                type="button"
                className="yt-pill-btn"
                onClick={() => handleAdjustSync(-0.1)}
                title="Delay video (-100ms)"
              >
                -0.1s
              </button>
              <button
                type="button"
                className="yt-pill-btn"
                onClick={handleResetSync}
                title="Reset A/V sync offset"
              >
                Sync: {syncLabelTxt}
              </button>
              <button
                type="button"
                className="yt-pill-btn"
                onClick={() => handleAdjustSync(0.1)}
                title="Advance video (+100ms)"
              >
                +0.1s
              </button>
            </div>

            {/* Settings (Gear) */}
            <button
              ref={settingsBtnRef}
              type="button"
              className="yt-btn"
              onClick={(e) => {
                e.stopPropagation();
                setSettingsOpen((prev) => !prev);
                showControlsTemporarily();
              }}
              title="Settings"
            >
              {quality >= 720 && <span className="yt-hd-badge">HD</span>}
              <svg viewBox="0 0 24 24">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>

            {/* Theater Mode */}
            {onToggleTheater && (
              <button
                type="button"
                className="yt-btn"
                onClick={onToggleTheater}
                title="Theater mode (t)"
              >
                <svg viewBox="0 0 24 24">
                  <path d="M19 6H5c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H5V8h14v8z" />
                </svg>
              </button>
            )}

            {/* Fullscreen */}
            <button
              type="button"
              className="yt-btn"
              onClick={handleToggleFullscreen}
              title="Full screen (f)"
            >
              <svg viewBox="0 0 24 24">
                {isFullscreen ? (
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                ) : (
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                )}
              </svg>
            </button>

            {/* Switch to Standard Player */}
            {onSwitchToStandard && (
              <button
                type="button"
                className="yt-stop-btn"
                onClick={onSwitchToStandard}
                title="Switch back to Standard Player (D)"
              >
                🎬 Standard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default DriveVideoPlayer;
