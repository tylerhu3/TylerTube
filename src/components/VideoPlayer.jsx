import React, { useEffect, useRef } from "react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";

function srtToVtt(srtText) {
  const normalized = srtText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${normalized}`;
}

export default function VideoPlayer({
  video,
  onEnded,
  onPrev,
  onNext,
  savedTime = 0,
  onTimeUpdate
}) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const onEndedRef = useRef(onEnded);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const currentVideoIdRef = useRef(video?.id);

  useEffect(() => {
    onEndedRef.current = onEnded;
    onTimeUpdateRef.current = onTimeUpdate;
    currentVideoIdRef.current = video?.id;
  }, [onEnded, onTimeUpdate, video?.id]);

  // Mount Plyr instance on an imperatively created <video> element inside containerRef
  // so Plyr's DOM wrapping/cloning on destroy() never conflicts with React or StrictMode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    const videoEl = document.createElement("video");
    videoEl.playsInline = true;
    videoEl.controls = true;
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
        "fullscreen"
      ],
      settings: ["captions", "quality", "speed", "loop"],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      seekTime: 10,
      keyboard: { focused: true, global: true }
    });

    player.on("ended", () => {
      if (onEndedRef.current) onEndedRef.current();
    });

    player.on("timeupdate", () => {
      if (
        onTimeUpdateRef.current &&
        currentVideoIdRef.current &&
        player.currentTime > 0
      ) {
        onTimeUpdateRef.current(
          currentVideoIdRef.current,
          player.currentTime,
          player.duration
        );
      }
    });

    playerRef.current = player;

    return () => {
      player.destroy();
      container.innerHTML = "";
      playerRef.current = null;
    };
  }, []);

  // Update video source whenever selected video changes
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !video) return;

    let cancelled = false;
    let subtitleBlobUrl = null;
    let handleLoadedMetadata = null;

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
        tracks
      };

      handleLoadedMetadata = () => {
        if (savedTime > 2) {
          player.currentTime = savedTime;
        }
      };

      player.once("loadedmetadata", handleLoadedMetadata);
    }

    applySource();

    return () => {
      cancelled = true;
      if (handleLoadedMetadata) {
        player.off("loadedmetadata", handleLoadedMetadata);
      }
      if (subtitleBlobUrl) {
        URL.revokeObjectURL(subtitleBlobUrl);
      }
    };
  }, [video]);


  const handleRewind = () => {
    playerRef.current?.rewind(10);
  };

  const handleForward = () => {
    playerRef.current?.forward(10);
  };

  return (
    <section className="player-section">
      <div className="video-wrapper" ref={containerRef} />

      <div className="player-bar">
        <div className="video-meta">
          <h2>{video.title}</h2>
          <p>{video.description}</p>
        </div>
        <div className="custom-controls">
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
        </div>
      </div>
    </section>
  );
}

