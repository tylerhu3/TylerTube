// WebSocket /ws/mpeg1?file=&quality=&seek=&speed=&loop=: ffmpeg → MPEG1 for the JSMpeg Drive player.
// Client side: src/components/DriveVideoPlayer.jsx. Message formats must change together.
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { resolveLocalVideoFile, probeVideoDuration } from "./media-files.js";

export function attachDriveWebSocketServer(httpServer, videosDir) {
  if (!httpServer) return;

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

  wss.on("connection", (ws, req) => {
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
    let pauseHoldTimer = null;
    let drainInterval = null;
    let wsClosed = false;

    const localFile = resolveLocalVideoFile(rawTarget, videosDir);
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

    const duration = probeVideoDuration(localFile);
    if (duration > 0 && currentSeek >= duration - 0.5) {
      currentSeek = 0;
    }

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
      if (activeFfmpeg) {
        const proc = activeFfmpeg;
        activeFfmpeg = null;
        try {
          proc.stdout.removeAllListeners("data");
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
      loop: loopEnabled
    });

    function doStream(streamUrl, isReset) {
      killActiveFfmpeg();
      if (wsClosed) return;

      const scale = qualMap[currentQuality] || "1280:720";
      const bitrate = scale.endsWith("360")
        ? "600k"
        : scale.endsWith("480")
          ? "900k"
          : scale.endsWith("720")
            ? "1600k"
            : "2600k";
      const spd = currentSpeed;

      if (isReset) {
        sendJson({
          type: "reset",
          seekTime: currentSeek,
          duration,
          speed: spd,
          quality: currentQuality,
          paused: isPaused,
          loop: loopEnabled
        });
      } else {
        sendJson({ type: "status", message: "Starting MPEG1 stream..." });
      }

      try {
        const inputArgs = [];
        if (currentSeek > 0) {
          inputArgs.push("-ss", currentSeek.toFixed(3));
        }
        // Buffer-ahead readrate: transcode at up to 1.6x playback speed so the client
        // can build a healthy jitter buffer against spotty or high-latency connections.
        // Initial burst: 10s of audio/video for instant startup headroom.
        const burstReadRate = Math.min(2.5, Math.max(1.3, (parseFloat(spd) || 1.0) * 1.5));
        inputArgs.push(
          "-readrate",
          String(burstReadRate),
          "-readrate_initial_burst",
          "10.0",
          "-fflags",
          "+genpts",
          "-i",
          streamUrl
        );

        const vfParts = [];
        if (Math.abs(spd - 1.0) > 0.01) {
          vfParts.push(`setpts=PTS/${spd}`);
        }
        vfParts.push("fps=30", `scale=${scale}`);

        const afParts = [];
        if (Math.abs(spd - 1.0) > 0.01) {
          afParts.push(`atempo=${spd}`);
        }
        afParts.push("aresample=async=1");

        const ffmpeg = spawn(
          "ffmpeg",
          [
            ...inputArgs,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "mpeg1video",
            "-q:v",
            "5",
            "-b:v",
            bitrate,
            "-bf",
            "0",
            "-vf",
            vfParts.join(","),
            "-c:a",
            "mp2",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-af",
            afParts.join(","),
            "-pes_payload_size",
            "0",
            "-f",
            "mpegts",
            "-muxdelay",
            "0.001",
            "-muxpreload",
            "0",
            "-"
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );

        activeFfmpeg = ffmpeg;
        let bytesSentSinceSpawn = 0;
        const MAX_WS_BUFFER = 2 * 1024 * 1024; // 2MB backpressure limit
        let isStdoutPaused = false;

        ffmpeg.stdout.on("data", (chunk) => {
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          if (ws.readyState === 1) {
            ws.send(chunk);
            bytesSentSinceSpawn += chunk.length;

            // WebSocket backpressure: pause ffmpeg if client connection cannot keep up
            if (ws.bufferedAmount > MAX_WS_BUFFER && !isStdoutPaused) {
              isStdoutPaused = true;
              try {
                ffmpeg.stdout.pause();
              } catch {
                // Ignore
              }
            }

            // If seeking while paused, allow enough packets for 1 decoded preview frame then SIGSTOP
            if (
              isPaused &&
              bytesSentSinceSpawn >= 96 * 1024 &&
              !pauseHoldTimer
            ) {
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
          }
        });

        drainInterval = setInterval(() => {
          if (wsClosed || activeFfmpeg !== ffmpeg) {
            if (drainInterval) clearInterval(drainInterval);
            drainInterval = null;
            return;
          }
          if (isStdoutPaused && ws.bufferedAmount < 512 * 1024) {
            isStdoutPaused = false;
            try {
              ffmpeg.stdout.resume();
            } catch {
              // Ignore
            }
          }
        }, 50);

        ffmpeg.stderr.on("data", () => {});

        ffmpeg.on("close", (code) => {
          if (drainInterval) {
            clearInterval(drainInterval);
            drainInterval = null;
          }
          if (wsClosed || activeFfmpeg !== ffmpeg) return;
          activeFfmpeg = null;
          if (code === 0) {
            if (loopEnabled) {
              currentSeek = 0;
              doStream(streamUrl, true);
            } else {
              currentSeek = duration > 0 ? duration : 0;
              isPaused = true;
              sendJson({ type: "ended", duration });
            }
            return;
          }
          if (code !== 0 && code !== null) {
            sendJson({
              type: "status",
              message: `Stream ended (code ${code})`
            });
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

    doStream(localFile, false);

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
        } else {
          if (duration > 0 && currentSeek >= duration - 0.5) {
            currentSeek = 0;
          }
          doStream(localFile, true);
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
        doStream(localFile, true);
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
        doStream(localFile, true);
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
        doStream(localFile, true);
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
}
