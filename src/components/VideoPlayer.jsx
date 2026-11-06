import React, { useEffect, useRef, useState } from "react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import WebCodecsPlayer from "./WebCodecsPlayer";
import { isWebCodecsSupported } from "./webcodecs/protocol";
import { nextVolumeBoost } from "../utils/audioBoost";

function srtToVtt(srtText) {
  const normalized = srtText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${normalized}`;
}

const SIZE_PRESETS = [
  { label: "S", width: 320, title: "Small (320px)" },
  { label: "M", width: 440, title: "Medium (440px)" },
  { label: "L", width: 600, title: "Large (600px)" },
  { label: "XL", width: 780, title: "Extra Large (780px)" }
];

const MIN_WIDTH = 280;
const MAX_WIDTH = 1000;

function clampWidth(w) {
  const maxViewport =
    typeof window !== "undefined" ? Math.max(MIN_WIDTH, window.innerWidth - 32) : MAX_WIDTH;
  return Math.round(Math.min(Math.min(MAX_WIDTH, maxViewport), Math.max(MIN_WIDTH, w)));
}

function getDownloadFilename(video) {
  if (!video?.src) return "video.mp4";
  try {
    const cleanSrc = video.src.split("?")[0];
    const lastSegment = cleanSrc.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // Fallback to title
  }
  return `${video.title || "video"}.mp4`;
}

function getDownloadUrl(video) {
  if (!video?.src) return "";
  return `${video.src}${video.src.includes("?") ? "&" : "?"}download=1`;
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function syncPlyrProgressUI(player) {
  if (!player || !player.media) return;
  const triggerSync = () => {
    if (!player.media || player.media.seeking) return;
    player.media.dispatchEvent(new Event("timeupdate"));
  };
  if (player.media.seeking) {
    player.media.addEventListener("seeked", triggerSync, { once: true });
  } else {
    triggerSync();
  }
}

export default function VideoPlayer({
  video,
  onEnded,
  onPrev,
  onNext,
  savedTime = 0,
  savedProgress,
  onTimeUpdate,
  onResetProgress,
  isFavorited = false,
  onToggleFavorite,
  isHidden = false,
  isSidePlayer = false,
  onToggleSidePlayer,
  sidePlayerPrefs = { width: 440, side: "right", vertical: "bottom" },
  onUpdateSidePlayerPrefs,
  viewMode = "desktop",
  playerMode = "standard",
  onTogglePlayerMode,
  onToggleTheater
}) {
  // WebCodecs mode hides Plyr and shows the canvas player (exposes seekTo/skipBy).
  const isWebCodecsMode = playerMode === "webcodecs";
  const isCanvasMode = isWebCodecsMode;
  const webCodecsSupported = isWebCodecsSupported();
  // Exact last position reported by whichever player is active ({ videoId, time }). Both
  // players save to the same watch-progress store; this hands the precise (sub-second)
  // position across a Standard ⇄ WebCodecs switch.
  const positionRef = useRef({ videoId: null, time: 0 });
  const isCanvasModeRef = useRef(isCanvasMode);
  const recordPlyrProgressRef = useRef(null);
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const canvasPlayerRef = useRef(null);
  const sectionRef = useRef(null);
  const onEndedRef = useRef(onEnded);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const currentVideoIdRef = useRef(video?.id);
  const loadedVideoIdRef = useRef(null);
  const isReadyToRecordRef = useRef(false);
  const isRestoringSeekRef = useRef(false);
  const savedTimeRef = useRef(savedTime);
  const savedProgressRef = useRef(savedProgress);
  const [resumedBannerTime, setResumedBannerTime] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const dragStateRef = useRef(null);
  // Standard-player volume boost (>100%): Plyr's <video> → MediaElementSource → GainNode.
  // The graph is built lazily on the first boost so unboosted playback never touches Web
  // Audio. Plyr swaps in a new <video> on each source change, so the source node is
  // re-created per element; once routed, audio only plays while the AudioContext runs.
  const [volumeBoost, setVolumeBoost] = useState(1);
  const volumeBoostRef = useRef(1);
  const boostGraphRef = useRef(null); // { ctx, gain, media, source }

  // Once built, the graph is permanent (an element can't be un-routed), so all Plyr audio
  // depends on the context running: resume it from any non-running state ("suspended", or
  // Safari's "interrupted" after a call/Siri), both here and whenever it changes mid-playback.
  const resumeBoostContext = (ctx) => {
    if (ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
  };

  const syncBoostGraph = (create = false) => {
    const media = playerRef.current?.media;
    let graph = boostGraphRef.current;
    if (!graph) {
      const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      if (!create || !Ctx || !media) return;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      graph = boostGraphRef.current = { ctx, gain, media: null, source: null };
      ctx.onstatechange = () => {
        const current = playerRef.current?.media;
        if (current && !current.paused) resumeBoostContext(ctx);
      };
    }
    if (media && graph.media !== media) {
      try {
        // Connect the new element before dropping the old one, so a failure here leaves the
        // previous routing intact instead of a half-disconnected graph.
        const source = graph.ctx.createMediaElementSource(media);
        source.connect(graph.gain);
        try {
          graph.source?.disconnect();
        } catch {
          // Already disconnected
        }
        graph.source = source;
        graph.media = media;
      } catch {
        // Element can't be routed; it plays at native volume without the boost
      }
    }
    graph.gain.gain.value = volumeBoostRef.current;
    resumeBoostContext(graph.ctx);
  };

  const handleCycleBoost = () => {
    const next = nextVolumeBoost(volumeBoostRef.current);
    volumeBoostRef.current = next;
    setVolumeBoost(next);
    syncBoostGraph(next > 1);
  };

  useEffect(() => {
    onEndedRef.current = onEnded;
    onTimeUpdateRef.current = onTimeUpdate;
    currentVideoIdRef.current = video?.id;
    savedTimeRef.current = savedTime;
    savedProgressRef.current = savedProgress;
  }, [onEnded, onTimeUpdate, video?.id, savedTime, savedProgress]);

  // Mount Plyr instance on an imperatively created <video> element inside containerRef
  // so Plyr's DOM wrapping/cloning on destroy() never conflicts with React or StrictMode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    const videoEl = document.createElement("video");
    videoEl.playsInline = true;
    videoEl.controls = true;
    videoEl.preload = "metadata";
    container.appendChild(videoEl);

    const player = new Plyr(videoEl, {
      controls: [
        "play-large",
        "rewind",
        "play",
        "fast-forward",
        "progress",
        "current-time",
        "duration",
        "mute",
        "volume",
        "captions",
        "settings",
        "pip",
        "airplay",
        "download",
        "fullscreen"
      ],
      settings: ["captions", "quality", "speed", "loop"],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      seekTime: 10,
      keyboard: { focused: true, global: true }
    });

    const recordProgress = (options = {}) => {
      if (
        isCanvasModeRef.current ||
        !isReadyToRecordRef.current ||
        isRestoringSeekRef.current ||
        !onTimeUpdateRef.current ||
        !loadedVideoIdRef.current ||
        loadedVideoIdRef.current !== currentVideoIdRef.current
      ) {
        return;
      }

      const currentTime = Number(player.currentTime);
      const duration = Number(player.duration);
      if (!Number.isFinite(currentTime) || currentTime < 0) return;

      // During normal playback timeupdate, ignore 0s before actual progress unless forced (e.g., manual seek to 0)
      if (!options.force && currentTime <= 0) return;

      positionRef.current = { videoId: loadedVideoIdRef.current, time: currentTime };
      onTimeUpdateRef.current(
        loadedVideoIdRef.current,
        currentTime,
        duration,
        options
      );
    };

    player.on("play", () => {
      syncBoostGraph(); // resume the AudioContext / route a fresh <video> if boost is active
      if (isRestoringSeekRef.current) return;
      recordProgress({ force: true, played: true });
    });

    player.on("ended", () => {
      recordProgress({ force: true, completed: true });
      if (onEndedRef.current) onEndedRef.current();
    });

    player.on("timeupdate", () => {
      recordProgress({ force: false });
    });

    player.on("seeked", () => {
      if (isRestoringSeekRef.current) return;
      if (player.paused) {
        syncPlyrProgressUI(player);
      }
      recordProgress({ force: true });
    });

    player.on("pause", () => {
      if (player.ended || isRestoringSeekRef.current) return;
      recordProgress({ force: true });
    });

    const handleVisibilityOrUnload = () => {
      recordProgress({ force: true });
    };

    window.addEventListener("beforeunload", handleVisibilityOrUnload);
    window.addEventListener("pagehide", handleVisibilityOrUnload);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        handleVisibilityOrUnload();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    playerRef.current = player;
    recordPlyrProgressRef.current = recordProgress;

    return () => {
      handleVisibilityOrUnload();
      window.removeEventListener("beforeunload", handleVisibilityOrUnload);
      window.removeEventListener("pagehide", handleVisibilityOrUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      player.destroy();
      container.innerHTML = "";
      playerRef.current = null;
      boostGraphRef.current?.ctx.close().catch(() => {});
      boostGraphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update video source whenever selected video changes
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !video) return;

    // Flush progress of the previous video before switching source
    // Skipped in WebCodecs mode: the hidden Plyr's position is stale, and the canvas player
    // already saved the real one on unmount.
    if (
      !isCanvasModeRef.current &&
      isReadyToRecordRef.current &&
      !isRestoringSeekRef.current &&
      loadedVideoIdRef.current &&
      loadedVideoIdRef.current !== video.id &&
      onTimeUpdateRef.current &&
      player.currentTime > 0
    ) {
      onTimeUpdateRef.current(
        loadedVideoIdRef.current,
        player.currentTime,
        player.duration,
        { force: true }
      );
    }

    isReadyToRecordRef.current = false;
    isRestoringSeekRef.current = false;
    loadedVideoIdRef.current = null;

    const initialSavedTime = Number(savedTimeRef.current) || 0;
    const initialCompleted = Boolean(savedProgressRef.current?.completed);
    setResumedBannerTime(initialSavedTime > 0 ? initialSavedTime : 0);

    let cancelled = false;
    let subtitleBlobUrl = null;
    let activeMediaEl = null;
    let restoreHandler = null;
    let seekDoneHandler = null;
    let fallbackTimer = null;

    async function applySource() {
      const tracks = [];

      if (video.subtitleSrc) {
        if (video.subtitleSrc.toLowerCase().endsWith(".srt")) {
          try {
            const res = await fetch(video.subtitleSrc);
            if (res.ok) {
              const srtText = await res.text();
              const vttBlob = new Blob([srtToVtt(srtText)], {
                type: "text/vtt"
              });
              subtitleBlobUrl = URL.createObjectURL(vttBlob);
              tracks.push({
                kind: "captions",
                label: "English",
                srclang: "en",
                src: subtitleBlobUrl,
                default: false
              });
            }
          } catch {
            // Ignore subtitle fetch errors
          }
        } else {
          tracks.push({
            kind: "captions",
            label: "English",
            srclang: "en",
            src: video.subtitleSrc,
            default: false
          });
        }
      }

      if (cancelled) return;

      player.source = {
        type: "video",
        title: video.title,
        sources: [{ src: video.src, type: "video/mp4" }],
        poster: video.poster || undefined,
        tracks,
        urls: {
          download: getDownloadUrl(video)
        }
      };

      loadedVideoIdRef.current = video.id;
      syncBoostGraph(); // Plyr made a new <video>; re-route it if boost is active
      activeMediaEl = player.media;
      if (activeMediaEl) {
        activeMediaEl.preload = "metadata";
      }

      let hasRestored = false;

      restoreHandler = () => {
        if (cancelled || hasRestored) return;
        const media = player.media;
        if (!media || !(media.readyState >= 1)) return;

        const duration = Number(player.duration || media.duration || 0);
        if (!Number.isFinite(duration) || duration <= 0) return;

        hasRestored = true;
        if (activeMediaEl && restoreHandler) {
          activeMediaEl.removeEventListener("loadedmetadata", restoreHandler);
          activeMediaEl.removeEventListener("canplay", restoreHandler);
        }

        // Record discovered duration even if starting at 0
        if (onTimeUpdateRef.current && initialSavedTime <= 0) {
          onTimeUpdateRef.current(video.id, 0, duration, {
            force: true,
            metadataOnly: true
          });
        }

        // If previously watched but not right at the very end, seek to saved time
        const isAtVeryEnd = duration > 2 && initialSavedTime >= duration - 1.5;
        const targetTime =
          initialSavedTime > 0 && !initialCompleted && !isAtVeryEnd
            ? Math.min(initialSavedTime, Math.max(0, duration - 0.5))
            : 0;

        if (targetTime > 0) {
          isRestoringSeekRef.current = true;

          const finishRestore = () => {
            if (cancelled) return;
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              fallbackTimer = null;
            }
            if (activeMediaEl && seekDoneHandler) {
              activeMediaEl.removeEventListener("seeked", seekDoneHandler);
            }
            isRestoringSeekRef.current = false;
            isReadyToRecordRef.current = true;
            syncPlyrProgressUI(player);
          };

          seekDoneHandler = () => {
            finishRestore();
          };

          media.addEventListener("seeked", seekDoneHandler, { once: true });
          fallbackTimer = setTimeout(finishRestore, 400);

          try {
            player.currentTime = targetTime;
            if (Math.abs(media.currentTime - targetTime) > 0.5) {
              media.currentTime = targetTime;
            }
          } catch {
            finishRestore();
          }
        } else {
          isReadyToRecordRef.current = true;
          syncPlyrProgressUI(player);
        }
      };

      if (activeMediaEl) {
        activeMediaEl.addEventListener("loadedmetadata", restoreHandler);
        activeMediaEl.addEventListener("canplay", restoreHandler);
        if (activeMediaEl.readyState >= 1) {
          restoreHandler();
        }
      } else {
        isReadyToRecordRef.current = true;
      }
    }

    applySource();

    return () => {
      cancelled = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      if (activeMediaEl && restoreHandler) {
        activeMediaEl.removeEventListener("loadedmetadata", restoreHandler);
        activeMediaEl.removeEventListener("canplay", restoreHandler);
      }
      if (activeMediaEl && seekDoneHandler) {
        activeMediaEl.removeEventListener("seeked", seekDoneHandler);
      }
      if (subtitleBlobUrl) {
        URL.revokeObjectURL(subtitleBlobUrl);
      }
    };
  }, [video]);

  const handleRestartFromBeginning = () => {
    if (isCanvasMode && canvasPlayerRef.current) {
      canvasPlayerRef.current.seekTo(0);
    }
    const player = playerRef.current;
    if (player && player.media) {
      player.currentTime = 0;
      player.media.currentTime = 0;
      syncPlyrProgressUI(player);
    }
    setResumedBannerTime(0);
    if (video?.id && onResetProgress) {
      onResetProgress(video.id);
    }
  };

  const handleJumpToSavedTime = (targetTime) => {
    if (isCanvasMode && canvasPlayerRef.current && targetTime > 0) {
      canvasPlayerRef.current.seekTo(targetTime);
      return;
    }
    const player = playerRef.current;
    if (!player || !player.media || !(targetTime > 0)) return;
    const duration = Number(player.duration || player.media.duration || 0);
    const clamped =
      duration > 0 ? Math.min(targetTime, Math.max(0, duration - 0.5)) : targetTime;
    player.currentTime = clamped;
    player.media.currentTime = clamped;
    syncPlyrProgressUI(player);
    if (video?.id && onTimeUpdateRef.current) {
      onTimeUpdateRef.current(video.id, clamped, duration, { force: true });
    }
  };

  const handleRewind = () => {
    if (isCanvasMode && canvasPlayerRef.current) {
      canvasPlayerRef.current.skipBy(-10);
      return;
    }
    playerRef.current?.rewind(10);
  };

  const handleForward = () => {
    if (isCanvasMode && canvasPlayerRef.current) {
      canvasPlayerRef.current.skipBy(10);
      return;
    }
    playerRef.current?.forward(10);
  };

  const isMobileView = viewMode === "mobile";
  const rawWidth = clampWidth(sidePlayerPrefs?.width || 440);
  const width = isMobileView ? Math.min(rawWidth, 340) : rawWidth;
  const side = sidePlayerPrefs?.side === "left" ? "left" : "right";
  const vertical = sidePlayerPrefs?.vertical === "top" ? "top" : "bottom";
  const offsetX = isMobileView
    ? 12
    : typeof sidePlayerPrefs?.offsetX === "number"
      ? sidePlayerPrefs.offsetX
      : 24;
  const offsetY = isMobileView
    ? vertical === "top"
      ? 64
      : 72
    : typeof sidePlayerPrefs?.offsetY === "number"
      ? sidePlayerPrefs.offsetY
      : vertical === "top"
        ? 76
        : 24;

  // Pointer-captured drag-to-resize handler
  const handleResizePointerDown = (edge) => (e) => {
    if (!isSidePlayer) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsInteracting(true);
    dragStateRef.current = {
      type: "resize",
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: width,
      startOffsetX: offsetX,
      side
    };
  };

  const handleResizePointerMove = (e) => {
    const state = dragStateRef.current;
    if (!state || state.type !== "resize") return;

    const dx = e.clientX - state.startX;
    // If dragging the left handle, moving left (-dx) widens the player.
    // If dragging the right handle, moving right (+dx) widens the player.
    const deltaWidth = state.edge.includes("left") ? -dx : dx;
    const nextWidth = clampWidth(state.startWidth + deltaWidth);

    onUpdateSidePlayerPrefs?.({ width: nextWidth });
  };

  const handlePointerEnd = (e) => {
    if (dragStateRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if not captured
      }
      dragStateRef.current = null;
      setIsInteracting(false);
    }
  };

  // Drag header to reposition floating player
  const handleMovePointerDown = (e) => {
    if (!isSidePlayer) return;
    if (e.target.closest("button") || e.target.closest("input")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsInteracting(true);
    const rect = sectionRef.current?.getBoundingClientRect();
    dragStateRef.current = {
      type: "move",
      startX: e.clientX,
      startY: e.clientY,
      rectLeft: rect ? rect.left : 0,
      rectTop: rect ? rect.top : 0,
      rectWidth: rect ? rect.width : width,
      rectHeight: rect ? rect.height : 300
    };
  };

  const handleMovePointerMove = (e) => {
    const state = dragStateRef.current;
    if (!state || state.type !== "move") return;

    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const newLeft = Math.max(
      12,
      Math.min(vw - state.rectWidth - 12, state.rectLeft + dx)
    );
    const newTop = Math.max(
      68,
      Math.min(vh - state.rectHeight - 12, state.rectTop + dy)
    );

    const centerX = newLeft + state.rectWidth / 2;
    const centerY = newTop + state.rectHeight / 2;

    const nextSide = centerX < vw / 2 ? "left" : "right";
    const nextVertical = centerY < vh / 2 ? "top" : "bottom";

    const nextOffsetX =
      nextSide === "left"
        ? Math.round(newLeft)
        : Math.round(vw - (newLeft + state.rectWidth));
    const nextOffsetY =
      nextVertical === "top"
        ? Math.round(newTop)
        : Math.round(vh - (newTop + state.rectHeight));

    onUpdateSidePlayerPrefs?.({
      side: nextSide,
      vertical: nextVertical,
      offsetX: Math.max(12, nextOffsetX),
      offsetY: Math.max(12, nextOffsetY)
    });
  };

  const handleSwitchSide = () => {
    const nextSide = side === "right" ? "left" : "right";
    onUpdateSidePlayerPrefs?.({
      side: nextSide,
      offsetX: 24
    });
  };

  const handleSwitchVertical = () => {
    const nextVertical = vertical === "bottom" ? "top" : "bottom";
    onUpdateSidePlayerPrefs?.({
      vertical: nextVertical,
      offsetY: nextVertical === "top" ? 76 : 24
    });
  };

  useEffect(() => {
    if (isHidden && playerRef.current && !playerRef.current.paused) {
      playerRef.current.pause();
    }
  }, [isHidden]);

  // Standard ⇄ WebCodecs handoff. Into WebCodecs: save Plyr's exact position, then mute its
  // progress reporting (a hidden, idle Plyr must not overwrite the canvas player's progress).
  // Back to Standard: the canvas player saved its exact position on unmount (its effect
  // cleanup runs before this effect); seek the paused Plyr there.
  useEffect(() => {
    const wasCanvas = isCanvasModeRef.current;
    if (wasCanvas === isCanvasMode) return;
    const player = playerRef.current;
    if (isCanvasMode) {
      recordPlyrProgressRef.current?.({ force: true });
      isCanvasModeRef.current = true;
      if (player && !player.paused) player.pause();
      return;
    }
    isCanvasModeRef.current = false;
    const pos = positionRef.current;
    const media = player?.media;
    if (
      !player ||
      !media ||
      !video ||
      pos.videoId !== video.id ||
      loadedVideoIdRef.current !== video.id ||
      !isReadyToRecordRef.current ||
      !(media.readyState >= 1)
    ) {
      return;
    }
    const duration = Number(player.duration || media.duration || 0);
    const target =
      duration > 0 ? Math.min(Math.max(0, pos.time), Math.max(0, duration - 0.5)) : pos.time;
    if (Math.abs(media.currentTime - target) < 0.05) return;
    isRestoringSeekRef.current = true;
    const done = () => {
      isRestoringSeekRef.current = false;
      syncPlyrProgressUI(player);
    };
    media.addEventListener("seeked", done, { once: true });
    setTimeout(() => {
      if (isRestoringSeekRef.current) done();
    }, 400);
    try {
      player.currentTime = target;
      if (Math.abs(media.currentTime - target) > 0.5) media.currentTime = target;
    } catch {
      done();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCanvasMode]);

  // Canvas player reports go through here so positionRef stays exact.
  const handleCanvasTimeUpdate = (videoId, time, duration, options) => {
    positionRef.current = { videoId, time };
    onTimeUpdate?.(videoId, time, duration, options);
  };
  // Where the canvas player should start. Called from its stream effect, which runs before
  // this component's effects, so on a Standard → WebCodecs switch Plyr is still live here.
  // null → the canvas player falls back to its own savedTime prop.
  const getCanvasStartTime = () => {
    if (!video) return null;
    const player = playerRef.current;
    if (
      !isCanvasModeRef.current &&
      player &&
      loadedVideoIdRef.current === video.id &&
      isReadyToRecordRef.current &&
      Number(player.currentTime) > 0
    ) {
      return Number(player.currentTime);
    }
    const pos = positionRef.current;
    return pos.videoId === video.id && pos.time > 0 ? pos.time : null;
  };

  const floatingStyle = isSidePlayer
    ? {
      width: `${width}px`,
      [side]: `${offsetX}px`,
      [vertical]: `${offsetY}px`
    }
    : isHidden
      ? { display: "none" }
      : undefined;

  return (
    <section
      ref={sectionRef}
      className={`player-section ${isSidePlayer ? "floating-player" : ""} ${isSidePlayer ? `dock-${side} dock-${vertical}` : ""
        } ${isInteracting ? "is-interacting" : ""} ${isHidden ? "player-hidden" : ""}`}
      style={floatingStyle}
    >
      {isSidePlayer && (
        <>
          {/* Drag-to-resize handles on edges and corners */}
          <div
            className="resize-handle resize-handle-left"
            onPointerDown={handleResizePointerDown("left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to resize player"
          />
          <div
            className="resize-handle resize-handle-right"
            onPointerDown={handleResizePointerDown("right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-tl"
            onPointerDown={handleResizePointerDown("top-left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-tr"
            onPointerDown={handleResizePointerDown("top-right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-bl"
            onPointerDown={handleResizePointerDown("bottom-left")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />
          <div
            className="resize-handle resize-handle-corner-br"
            onPointerDown={handleResizePointerDown("bottom-right")}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag corner to resize player"
          />

          {/* Floating toolbar header (draggable to move + quick size & side controls) */}
          <div
            className="floating-toolbar"
            onPointerDown={handleMovePointerDown}
            onPointerMove={handleMovePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            title="Drag to move floating player"
          >
            <div className="floating-toolbar-left">
              <span className="drag-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <button
                type="button"
                className="floating-tool-btn"
                onClick={handleSwitchSide}
                title={`Push to ${side === "right" ? "Left" : "Right"} Side`}
              >
                {side === "right" ? "⬅ Left" : "Right ➡"}
              </button>
              <button
                type="button"
                className="floating-tool-btn"
                onClick={handleSwitchVertical}
                title={`Dock to ${vertical === "bottom" ? "Top" : "Bottom"}`}
              >
                {vertical === "bottom" ? "⬆ Top" : "⬇ Bottom"}
              </button>
            </div>

            <div className="floating-size-controls" aria-label="Player size">
              {SIZE_PRESETS.map((preset) => {
                const isActive = Math.abs(width - preset.width) < 30;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`floating-size-btn ${isActive ? "active" : ""}`}
                    onClick={() =>
                      onUpdateSidePlayerPrefs?.({ width: preset.width })
                    }
                    title={preset.title}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <input
                type="range"
                className="floating-size-slider"
                min={MIN_WIDTH}
                max={820}
                value={Math.min(820, width)}
                onChange={(e) =>
                  onUpdateSidePlayerPrefs?.({ width: Number(e.target.value) })
                }
                title={`Resize player (${width}px)`}
                aria-label="Resize side player width"
              />
            </div>

            <button
              type="button"
              className="floating-close-btn"
              onClick={onToggleSidePlayer}
              title="Restore Full Player (S)"
              aria-label="Restore Full Player"
            >
              ⤢ Expand
            </button>
          </div>
        </>
      )}

      <div
        className="video-wrapper"
        ref={containerRef}
        style={isCanvasMode ? { display: "none" } : undefined}
      />

      {isWebCodecsMode && (
        <div className="video-wrapper drive-mode-wrapper">
          <WebCodecsPlayer
            ref={canvasPlayerRef}
            video={video}
            savedTime={savedTime}
            getStartTime={getCanvasStartTime}
            onTimeUpdate={handleCanvasTimeUpdate}
            onEnded={onEnded}
            isHidden={isHidden}
            onToggleTheater={onToggleTheater}
            onSwitchToStandard={onTogglePlayerMode}
          />
        </div>
      )}

      <div className="player-bar">
        <div className="video-meta">
          <h2 title={video?.title}>{video?.title}</h2>
          <div className="video-meta-subrow">
            <p>{video?.description}</p>
            {(savedTime > 0 || resumedBannerTime > 0) && (
              <div className="watch-resume-badge">
                <span className="watch-resume-text">
                  {savedProgress?.completed
                    ? "✓ Watched"
                    : `Last watched: ${formatTimestamp(savedTime || resumedBannerTime)}${savedProgress?.duration > 0
                      ? ` / ${formatTimestamp(savedProgress.duration)}`
                      : ""
                    }`}
                </span>
                {savedProgress?.completed && resumedBannerTime > 0 && (
                  <button
                    type="button"
                    className="watch-resume-action"
                    onClick={() => handleJumpToSavedTime(resumedBannerTime)}
                    title="Jump to last position"
                  >
                    Jump to {formatTimestamp(resumedBannerTime)}
                  </button>
                )}
                <button
                  type="button"
                  className="watch-resume-action"
                  onClick={handleRestartFromBeginning}
                  title="Reset watch progress and start from 00:00"
                >
                  ↺ Start Over
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="custom-controls">
          {onTogglePlayerMode && (
            <button
              type="button"
              className={`ctrl-btn webcodecs-switch-btn ${isWebCodecsMode ? "active" : ""}`}
              onClick={onTogglePlayerMode}
              disabled={!webCodecsSupported && !isWebCodecsMode}
              title={
                !webCodecsSupported
                  ? "WebCodecs player unavailable: this browser has no VideoDecoder"
                  : isWebCodecsMode
                    ? "Switch to Standard Video Player (D)"
                    : "Switch to WebCodecs Video Player (D)"
              }
            >
              {isWebCodecsMode ? "🎬 Standard Player" : "⚡ WebCodecs Player"}
            </button>
          )}
          <button
            type="button"
            className="ctrl-btn"
            onClick={onPrev}
            title="Previous Video"
          >
            ⏮ Prev
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={handleRewind}
            title="Rewind 10s"
          >
            ↺ -10s
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={handleForward}
            title="Forward 10s"
          >
            +10s ↻
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={onNext}
            title="Next Video"
          >
            Next ⏭
          </button>
          {!isWebCodecsMode && (
            <button
              type="button"
              className={`ctrl-btn ${volumeBoost > 1 ? "active" : ""}`}
              onClick={handleCycleBoost}
              title="Volume boost: multiplies the player volume (cycles 100% → 150% → 200% → 300%)"
            >
              🔊 Boost {Math.round(volumeBoost * 100)}%
            </button>
          )}
          {video?.id && onToggleFavorite && (
            <button
              type="button"
              className={`ctrl-btn fav-ctrl-btn ${isFavorited ? "active" : ""}`}
              onClick={() => onToggleFavorite(video.id)}
              title={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
            >
              {isFavorited ? "♥ Favorited" : "♡ Favorite"}
            </button>
          )}
          {video?.src && (
            <a
              href={getDownloadUrl(video)}
              download={getDownloadFilename(video)}
              className="ctrl-btn download-btn"
              title={`Download ${video?.title || "video"}`}
            >
              ⬇ Download
            </a>
          )}
          <button
            type="button"
            className={`ctrl-btn side-toggle-ctrl ${isSidePlayer ? "active" : ""}`}
            onClick={onToggleSidePlayer}
            title={
              isSidePlayer
                ? "Restore player to top (S)"
                : "Push player to side while browsing library (S)"
            }
          >
            {isSidePlayer ? "⤢ Restore" : "⧉ Push to Side"}
          </button>
        </div>
      </div>
    </section>
  );
}
