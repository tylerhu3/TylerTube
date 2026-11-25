// WebSocket /ws/mpeg1?file=&quality=&seek=&speed=&loop=&fps=: ffmpeg → H.264 + PCM binary frames for
// src/components/WebCodecsPlayer.jsx (format: server/webcodecs-stream.js). The path name is
// historical (it used to carry MPEG1 for JSMpeg); kept so the Nginx proxy config needn't change.
// Client and server message formats must change together.
// Returns the WebSocketServer (null without httpServer); terminating its clients kills their ffmpeg.
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import {
  resolveLocalVideoFile,
  probeVideoDuration,
  probeHasAudioStream,
  probeVideoFrameRate
} from "./media-files.js";
import {
  extractYouTubeVideoId,
  formatFfmpegHeaders,
  invalidateYouTubeCache,
  isYouTubeTarget,
  resolveYouTubeStreamUrls,
  spawnYouTubeStream
} from "./youtube.js";
import {
  AnnexBSplitter,
  PcmCoalescer,
  WC_MAX_AHEAD_SEC,
  WC_RESUME_AHEAD_SEC,
  buildWebCodecsFfmpegArgs,
  frameTimestampUs,
  normalizeFpsRequest,
  packAudioMessage,
  packVideoMessage,
  pickSourceFps,
  resolveOutputFps,
  webCodecsVideoParams
} from "./webcodecs-stream.js";

export function attachDriveWebSocketServer(httpServer, videosDir) {
  if (!httpServer) return null;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const [rawPathname] = req.url.split("?");
    if (rawPathname !== "/ws/mpeg1") {
      // Leave other WebSocket upgrades (such as Vite HMR) untouched
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws, req) => {
    const [, rawQuery = ""] = (req.url || "").split("?");
    const params = new URLSearchParams(rawQuery);
    const rawTarget =
      params.get("file") ||
      params.get("channel") ||
      params.get("url") ||
      "";
    const initialQuality = parseInt(params.get("quality") || "720", 10) || 720;
    const initialSeek =
      parseFloat(params.get("seek") || params.get("start") || "0") || 0;
    const initialSpeed = parseFloat(params.get("speed") || "1") || 1;
    const initialLoop =
      params.get("loop") === "1" || params.get("loop") === "true";
    // "source" (default) or a number; the output rate is resolved per stream (resolveOutputFps).
    let requestedFps = normalizeFpsRequest(params.get("fps"));

    const qualMap = {
      360: "640:360",
      480: "854:480",
      720: "1280:720",
      1080: "1920:1080"
    };
    let currentQuality = qualMap[initialQuality] ? initialQuality : 720;
    let currentSpeed = Math.max(0.25, Math.min(2.0, initialSpeed));
    let currentSeek = Math.max(0, initialSeek);
    let loopEnabled = Boolean(initialLoop);
    let isPaused = false;
    let activeFfmpeg = null;
    let activeYtDlp = null;
    let pauseHoldTimer = null;
    let drainInterval = null;
    let wsClosed = false;
    let streamSeq = 0;

    const isYouTube = isYouTubeTarget(rawTarget);
    const youtubeId = isYouTube ? extractYouTubeVideoId(rawTarget) : null;
    let localFile = null;
    let duration = 0;
    let hasAudio = true;
    let sourceFps = 30;

    if (isYouTube) {
      try {
        const resolved = await resolveYouTubeStreamUrls(youtubeId, currentQuality);
        if (wsClosed) return;
        duration = resolved.duration || 0;
        hasAudio = resolved.hasAudio;
        if (resolved.fps > 0) sourceFps = resolved.fps;
      } catch {
        if (wsClosed) return;
        // Proceed with duration = 0 if probe failed
      }
    } else {
      localFile = resolveLocalVideoFile(rawTarget, videosDir);
      if (!localFile) {
        try {
          ws.send(
            JSON.stringify({ type: "error", message: "Video file not found" })
          );
          ws.close();
        } catch {
          // Ignore
        }
        return;
      }

      duration = probeVideoDuration(localFile);
      hasAudio = probeHasAudioStream(localFile);
      const probedRate = probeVideoFrameRate(localFile);
      sourceFps = pickSourceFps(probedRate.avg, probedRate.r);
    }

    if (duration > 0 && currentSeek >= duration - 0.5) {
      currentSeek = 0;
    }
    const streamSource = isYouTube ? `yt:${youtubeId}` : localFile;
    const outputFps = () =>
      resolveOutputFps({ requested: requestedFps, sourceFps, speed: currentSpeed });
    // Stream info sent with every meta/reset. fps = output rate of this stream (frame n is at
    // n/fps s); fpsCap = what "source" resolves to at the current speed; sourceFps 0 = unknown.
    const webCodecsInfo = () => {
      const { fps, cap } = outputFps();
      return {
        transport: "webcodecs",
        videoCodec: webCodecsVideoParams(currentQuality, fps).codec,
        hasAudio,
        fps,
        fpsCap: cap,
        sourceFps,
        requestedFps
      };
    };

    function sendJson(payload) {
      if (!wsClosed && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          // Ignore send errors
        }
      }
    }

    function killActiveFfmpeg() {
      if (drainInterval) {
        clearInterval(drainInterval);
        drainInterval = null;
      }
      if (pauseHoldTimer) {
        clearTimeout(pauseHoldTimer);
        pauseHoldTimer = null;
      }
      if (activeYtDlp) {
        const ytdl = activeYtDlp;
        activeYtDlp = null;
        try {
          ytdl.stdout?.removeAllListeners();
          ytdl.stdout?.destroy();
        } catch {
          // Ignore
        }
        try {
          ytdl.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
      if (activeFfmpeg) {
        const proc = activeFfmpeg;
        activeFfmpeg = null;
        try {
          proc.stdout.removeAllListeners("data");
          if (proc.stdio[3]) proc.stdio[3].removeAllListeners("data");
        } catch {
          // Ignore
        }
        try {
          proc.removeAllListeners("close");
        } catch {
          // Ignore
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
    }

    sendJson({
      type: "meta",
      isLive: false,
      duration,
      seekTime: currentSeek,
      speed: currentSpeed,
      quality: currentQuality,
      loop: loopEnabled,
      ...webCodecsInfo()
    });

    function doStream(streamUrl, isReset) {
      const mySeq = ++streamSeq;
      killActiveFfmpeg();
      if (wsClosed) return;
      doStreamWebCodecs(streamUrl, isReset, { mySeq });
    }

    // WebCodecs variant of doStream: H.264 Annex-B (stdout) + PCM (fd 3) → binary frames.
    // Loop is client-driven here: the client may hold up to WC_MAX_AHEAD_SEC unplayed, so on
    // ffmpeg exit we always send "ended" and the client seeks to 0 when it really reaches the end.
    async function doStreamWebCodecs(
      streamUrl,
      isReset,
      { mySeq = streamSeq, forceRefresh = false, retriedRefresh = false } = {}
    ) {
      const spd = currentSpeed;
      let ytStreams = null;
      if (isYouTube) {
        try {
          ytStreams = await resolveYouTubeStreamUrls(youtubeId, currentQuality, {
            forceRefresh
          });
        } catch {
          ytStreams = null;
        }
        if (wsClosed || mySeq !== streamSeq) return;
        if (ytStreams) {
          if (ytStreams.duration > 0) duration = ytStreams.duration;
          hasAudio = ytStreams.hasAudio;
          if (ytStreams.fps > 0) sourceFps = ytStreams.fps;
        }
      }

      const fps = outputFps().fps;
      if (isReset || retriedRefresh) {
        sendJson({
          type: "reset",
          seekTime: currentSeek,
          duration,
          speed: spd,
          quality: currentQuality,
          paused: isPaused,
          loop: loopEnabled,
          ...webCodecsInfo()
        });
      } else {
        sendJson({ type: "status", message: "Starting WebCodecs stream..." });
      }

      try {
        let ffmpeg;
        if (isYouTube && ytStreams && ytStreams.videoUrl) {
          const args = buildWebCodecsFfmpegArgs({
            input: ytStreams.videoUrl,
            audioInput: ytStreams.audioUrl,
            httpHeaders: formatFfmpegHeaders(ytStreams.headers),
            isNetwork: true,
            seek: currentSeek,
            speed: spd,
            quality: currentQuality,
            fps,
            hasAudio
          });
          ffmpeg = spawn("ffmpeg", args, {
            stdio: hasAudio
              ? ["ignore", "pipe", "pipe", "pipe"]
              : ["ignore", "pipe", "pipe"]
          });
        } else if (isYouTube) {
          activeYtDlp = spawnYouTubeStream({
            videoId: youtubeId,
            seek: currentSeek,
            quality: currentQuality
          });
          const args = buildWebCodecsFfmpegArgs({
            input: "pipe:0",
            seek: 0,
            speed: spd,
            quality: currentQuality,
            fps,
            hasAudio: true
          });
          ffmpeg = spawn("ffmpeg", args, {
            stdio: ["pipe", "pipe", "pipe", "pipe"]
          });
          activeYtDlp.stdout.pipe(ffmpeg.stdin);
          activeYtDlp.on("error", (err) => {
            sendJson({ type: "error", message: `YouTube stream error: ${err.message}` });
          });
        } else {
          const args = buildWebCodecsFfmpegArgs({
            input: streamUrl,
            seek: currentSeek,
            speed: spd,
            quality: currentQuality,
            fps,
            hasAudio
          });
          ffmpeg = spawn("ffmpeg", args, {
            stdio: hasAudio
              ? ["ignore", "pipe", "pipe", "pipe"]
              : ["ignore", "pipe", "pipe"]
          });
        }
        activeFfmpeg = ffmpeg;

        const audioPipe = hasAudio ? ffmpeg.stdio[3] : null;
        const splitter = new AnnexBSplitter();
        const pcm = new PcmCoalescer(4096);
        const MAX_WS_BUFFER = 2 * 1024 * 1024;
        let frameIndex = 0;
        let keyframeSent = false;
        let producedMedia = false;
        let socketPaused = false; // ws.bufferedAmount backpressure
        let flowPaused = false; // too far ahead of the client's playback
        let playedSec = 0; // wall-clock playback estimate (excludes paused time)
        let lastTick = 0;

        const setPipesPaused = (paused) => {
          for (const pipe of [ffmpeg.stdout, audioPipe]) {
            if (!pipe) continue;
            try {
              if (paused) pipe.pause();
              else pipe.resume();
            } catch {
              // Ignore
            }
          }
        };
        const updatePipes = () => setPipesPaused(socketPaused || flowPaused);

        const sendBinary = (buf) => {
          if (wsClosed || activeFfmpeg !== ffmpeg || ws.readyState !== 1) return;
          ws.send(buf, { binary: true, compress: false });
          if (ws.bufferedAmount > MAX_WS_BUFFER && !socketPaused) {
            socketPaused = true;
            updatePipes();
          }
        };

        const sendAccessUnit = (au) => {
          producedMedia = true;
          sendBinary(packVideoMessage(au.data, au.keyframe, frameTimestampUs(frameIndex, fps)));
          frameIndex += 1;
          if (au.keyframe) keyframeSent = true;
          if (!lastTick) lastTick = Date.now();
          const aheadSec = frameIndex / fps - playedSec;
          if (!flowPaused && aheadSec > WC_MAX_AHEAD_SEC) {
            flowPaused = true;
            updatePipes();
          }
          // Seeking while paused: let one decodable frame through, then hold ffmpeg.
          if (isPaused && keyframeSent && !pauseHoldTimer) {
            pauseHoldTimer = setTimeout(() => {
              pauseHoldTimer = null;
              if (isPaused && activeFfmpeg === ffmpeg) {
                try {
                  ffmpeg.kill("SIGSTOP");
                } catch {
                  // Ignore
                }
              }
            }, 30);
          }
        };

        ffmpeg.stdout.on("data", (chunk) => {
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          for (const au of splitter.push(chunk)) sendAccessUnit(au);
        });

        if (audioPipe) {
          audioPipe.on("data", (chunk) => {
            if (wsClosed || activeFfmpeg !== ffmpeg) return;
            const out = pcm.push(chunk);
            if (out) {
              producedMedia = true;
              sendBinary(packAudioMessage(out));
            }
          });
          audioPipe.on("error", () => {});
        }

        drainInterval = setInterval(() => {
          if (wsClosed || activeFfmpeg !== ffmpeg) {
            if (drainInterval) clearInterval(drainInterval);
            drainInterval = null;
            return;
          }
          const now = Date.now();
          if (lastTick) {
            if (!isPaused) playedSec += (now - lastTick) / 1000;
            lastTick = now;
          }
          let changed = false;
          if (socketPaused && ws.bufferedAmount < 512 * 1024) {
            socketPaused = false;
            changed = true;
          }
          if (flowPaused && frameIndex / fps - playedSec < WC_RESUME_AHEAD_SEC) {
            flowPaused = false;
            changed = true;
          }
          if (changed) updatePipes();
        }, 50);

        ffmpeg.stderr.on("data", () => {});

        ffmpeg.on("close", (code) => {
          if (drainInterval) {
            clearInterval(drainInterval);
            drainInterval = null;
          }
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          if (code === 0) {
            const lastAu = splitter.flush();
            if (lastAu) sendAccessUnit(lastAu);
            const lastPcm = pcm.flush();
            if (lastPcm) sendBinary(packAudioMessage(lastPcm));
            activeFfmpeg = null;
            if (pauseHoldTimer) {
              clearTimeout(pauseHoldTimer);
              pauseHoldTimer = null;
            }
            currentSeek = duration > 0 ? duration : 0;
            isPaused = true;
            sendJson({ type: "ended", duration, loop: loopEnabled });
            return;
          }
          activeFfmpeg = null;
          // Cached YouTube CDN URLs can expire (HTTP 403); refresh once before giving up.
          if (
            isYouTube &&
            ytStreams &&
            ytStreams.videoUrl &&
            !producedMedia &&
            !retriedRefresh &&
            mySeq === streamSeq
          ) {
            invalidateYouTubeCache(youtubeId);
            doStreamWebCodecs(streamUrl, isReset, {
              mySeq,
              forceRefresh: true,
              retriedRefresh: true
            });
            return;
          }
          if (code !== null) {
            sendJson({ type: "status", message: `Stream ended (code ${code})` });
          }
          try {
            ws.close();
          } catch {
            // Ignore
          }
        });

        ffmpeg.on("error", (err) => {
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          sendJson({
            type: "error",
            message: (err?.message || "ffmpeg error").slice(0, 100)
          });
        });
      } catch (err) {
        sendJson({
          type: "error",
          message: (err?.message || "spawn error").slice(0, 100)
        });
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }
    }

    doStream(streamSource, false);

    ws.on("message", (raw) => {
      if (wsClosed) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || !msg.type) return;

      if (msg.type === "pause") {
        isPaused = true;
        if (pauseHoldTimer) {
          clearTimeout(pauseHoldTimer);
          pauseHoldTimer = null;
        }
        if (activeFfmpeg) {
          try {
            activeFfmpeg.kill("SIGSTOP");
          } catch {
            // Ignore
          }
        }
        if (activeYtDlp) {
          try {
            activeYtDlp.kill("SIGSTOP");
          } catch {
            // Ignore
          }
        }
      } else if (msg.type === "resume") {
        isPaused = false;
        if (pauseHoldTimer) {
          clearTimeout(pauseHoldTimer);
          pauseHoldTimer = null;
        }
        if (activeFfmpeg) {
          try {
            activeFfmpeg.kill("SIGCONT");
          } catch {
            // Ignore
          }
          if (activeYtDlp) {
            try {
              activeYtDlp.kill("SIGCONT");
            } catch {
              // Ignore
            }
          }
        } else {
          if (duration > 0 && currentSeek >= duration - 0.5) {
            currentSeek = 0;
          }
          doStream(streamSource, true);
        }
      } else if (msg.type === "seek") {
        let target = parseFloat(msg.time);
        if (!Number.isFinite(target)) return;
        if (duration > 0) {
          target = Math.max(0, Math.min(duration - 0.1, target));
        } else {
          target = Math.max(0, target);
        }
        currentSeek = target;
        doStream(streamSource, true);
      } else if (msg.type === "speed") {
        const spd = parseFloat(msg.speed);
        if (!Number.isFinite(spd)) return;
        currentSpeed = Math.max(0.25, Math.min(2.0, spd));
        if (Number.isFinite(msg.currentTime)) {
          currentSeek =
            duration > 0
              ? Math.max(0, Math.min(duration - 0.1, parseFloat(msg.currentTime)))
              : Math.max(0, parseFloat(msg.currentTime));
        }
        doStream(streamSource, true);
      } else if (msg.type === "quality") {
        const q = parseInt(msg.quality, 10);
        if (!qualMap[q]) return;
        currentQuality = q;
        if (Number.isFinite(msg.currentTime)) {
          currentSeek =
            duration > 0
              ? Math.max(0, Math.min(duration - 0.1, parseFloat(msg.currentTime)))
              : Math.max(0, parseFloat(msg.currentTime));
        }
        doStream(streamSource, true);
      } else if (msg.type === "fps") {
        // "source" | number; restarts encoding at currentTime like "quality".
        if (msg.fps !== "source" && !Number.isFinite(Number(msg.fps))) return;
        requestedFps = normalizeFpsRequest(msg.fps);
        if (Number.isFinite(msg.currentTime)) {
          currentSeek =
            duration > 0
              ? Math.max(0, Math.min(duration - 0.1, parseFloat(msg.currentTime)))
              : Math.max(0, parseFloat(msg.currentTime));
        }
        doStream(streamSource, true);
      } else if (msg.type === "loop") {
        loopEnabled = Boolean(msg.loop);
      }
    });

    ws.on("close", () => {
      wsClosed = true;
      killActiveFfmpeg();
    });

    ws.on("error", () => {
      wsClosed = true;
      killActiveFfmpeg();
    });
  });

  return wss;
}
