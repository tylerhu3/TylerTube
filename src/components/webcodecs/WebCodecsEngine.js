// WebCodecs Drive engine: WebSocket (H.264 + PCM, see protocol.js) → VideoDecoder → canvas,
// PCM → AudioContext. Driven by WebCodecsPlayer.jsx; no React here.
//
// Clock: one timeline. Stream time t (seconds, 0 at each meta/reset) maps video frame
// timestamps and PCM sample positions (sample k = k/44100 s). While audio can play, the
// AudioContext clock *is* the stream clock: PCM chunk at t is scheduled at ctx time anchor + t,
// and video presents the frame due at (ctx.currentTime - outputLatency - anchor + syncOffset).
// Video cannot drift from audio because both read the same clock. While audio is locked or
// absent, a performance.now() clock stands in and audio takes over (re-anchored) once running.
import {
  WC_AUDIO_RATE,
  WC_FRAME_US,
  codecForQuality,
  parseBinaryMessage
} from "./protocol";
import {
  WC_AUDIO_HORIZON_SEC,
  WC_AUDIO_LEAD_SEC,
  WC_CATCHUP_SEC,
  WC_DECODE_AHEAD_SEC,
  WC_MAX_DECODED_FRAMES,
  WC_START_BUFFER_SEC,
  bufferedAheadSec,
  findCatchUpKeyframe,
  isPresentationBehind,
  selectDueFrame
} from "./scheduler";

const PUMP_MS = 50;
const RAF_STALE_MS = 250;
const AUDIO_GAP_VIDEO_SEC = 3;

export class WebCodecsEngine {
  constructor({ url, canvas, callbacks = {} }) {
    this.url = url;
    this.canvas = canvas;
    this.ctx2d = canvas.getContext("2d", { alpha: false });
    this.cb = callbacks;
    this.destroyed = false;

    // Settings
    this.volume = 1;
    this.muted = false;
    this.syncOffsetSec = 0;
    this.rebufferTargetSec = 2;

    // Stream state (reset on meta/reset)
    this.codec = codecForQuality(720);
    this.hasAudio = true;
    this.awaitingReset = false;
    this.serverEnded = false;
    this.playbackEnded = false;
    this.flushRequested = false;
    this.needKeyframe = true;
    this.encoded = [];
    this.frames = [];
    this.lastReceivedVideoUs = -1;
    this.newestDecodedUs = -1;
    this.firstKeyUs = -1;
    this.audioSamplesReceived = 0;
    this.pendingAudio = []; // { startSec, samples, durSec, buffer? }; [0, schedIdx) scheduled
    this.schedIdx = 0;
    this.sources = new Set();
    this.presentedSinceReset = false;
    this.hadFirstStart = false;

    // Clock
    this.paused = false;
    this.running = false;
    this.clockMode = "perf";
    this.anchorCtx = 0;
    this.perfBaseSec = 0;
    this.perfStartMs = 0;
    this.frozenSec = 0;
    this.buffering = true;
    this.audioGap = false;
    this.startTargetSec = WC_START_BUFFER_SEC; // rebufferTargetSec after an underrun

    // Stats
    this.stats = {
      decodedFrames: 0,
      presentedFrames: 0,
      droppedFrames: 0,
      skippedBeforeKey: 0,
      catchUps: 0,
      decodeErrors: 0,
      underruns: 0,
      avOffsetMs: 0,
      fpsWindow: 0,
      fps: 0,
      fpsWindowStart: performance.now()
    };

    this.decoder = null;
    this.decoderGen = 0;
    this.lastRafMs = 0;
    this.rafId = 0;
    this.pumpId = 0;

    this.setupAudio();
    this.connect();
    this.rafLoop = this.rafLoop.bind(this);
    this.rafId = requestAnimationFrame(this.rafLoop);
    this.pumpId = setInterval(() => this.pump(), PUMP_MS);
  }

  // ---------- setup ----------

  setupAudio() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      // 44.1 kHz context: PCM buffers play without per-buffer resampling seams.
      this.audioCtx = new Ctor({ sampleRate: WC_AUDIO_RATE });
    } catch {
      try {
        this.audioCtx = new Ctor();
      } catch {
        this.audioCtx = null;
      }
    }
    if (!this.audioCtx) return;
    this.gain = this.audioCtx.createGain();
    this.gain.connect(this.audioCtx.destination);
    this.applyGain();
    this.audioCtx.onstatechange = () => this.pump();
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.cb.onError?.(err?.message || "WebSocket error");
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (this.destroyed) return;
      if (typeof ev.data === "string") {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && msg.type) this.handleControl(msg);
        return;
      }
      this.handleBinary(ev.data);
    };
    ws.onclose = () => {
      if (!this.destroyed) this.cb.onStatus?.("Disconnected");
    };
    ws.onerror = () => {
      if (!this.destroyed) this.cb.onStatus?.("Connection error");
    };
    this.ws = ws;
  }

  createDecoder() {
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch {
        // Ignore
      }
    }
    const gen = ++this.decoderGen;
    const decoder = new window.VideoDecoder({
      output: (frame) => this.onDecodedFrame(frame, gen),
      error: (err) => this.onDecoderError(err, gen)
    });
    decoder.configure({ codec: this.codec, optimizeForLatency: true });
    decoder.ondequeue = () => this.feedDecoder();
    this.decoder = decoder;
    this.needKeyframe = true;
    this.flushRequested = false;
  }

  // ---------- incoming messages ----------

  handleControl(msg) {
    if (this.unsupportedServer) return;
    if (msg.type === "meta" && msg.transport !== "webcodecs") {
      // An older Drive server ignores codec=webcodecs and streams MPEG-TS.
      this.unsupportedServer = true;
      this.cb.onError?.("Drive server has no WebCodecs support (restart npm run server)");
      this.cb.onControl?.(msg);
      return;
    }
    if (msg.type === "meta" || msg.type === "reset") {
      this.startNewStream(msg);
    } else if (msg.type === "ended") {
      this.serverEnded = true;
    }
    this.cb.onControl?.(msg);
  }

  startNewStream(msg) {
    this.awaitingReset = false;
    this.flushMedia();
    this.serverEnded = false;
    this.playbackEnded = false;
    if (typeof msg.hasAudio === "boolean") this.hasAudio = msg.hasAudio;
    const q = parseInt(msg.quality, 10);
    this.codec = msg.videoCodec || codecForQuality(q);
    this.frozenSec = 0;
    this.running = false;
    this.hadFirstStart = false;
    this.presentedSinceReset = false;
    this.audioGap = false;
    this.startTargetSec = WC_START_BUFFER_SEC;
    this.errorsSinceReset = 0;
    this.setBuffering(!this.paused);
    try {
      this.createDecoder();
    } catch (err) {
      this.decoder = null;
      this.cb.onError?.(`VideoDecoder: ${err?.message || err}`);
    }
  }

  handleBinary(data) {
    if (this.awaitingReset || this.unsupportedServer) return;
    const msg = parseBinaryMessage(data);
    if (!msg) return;
    if (msg.kind === "video") {
      if (this.needKeyframe) {
        if (!msg.keyframe) {
          this.stats.skippedBeforeKey += 1;
          return;
        }
        this.needKeyframe = false;
        if (this.firstKeyUs < 0) this.firstKeyUs = msg.timestampUs;
      }
      this.encoded.push({
        timestampUs: msg.timestampUs,
        keyframe: msg.keyframe,
        data: msg.data
      });
      this.lastReceivedVideoUs = Math.max(this.lastReceivedVideoUs, msg.timestampUs);
      this.feedDecoder();
    } else if (msg.kind === "audio") {
      const n = msg.samples.length;
      if (!n) return;
      this.pendingAudio.push({
        startSec: this.audioSamplesReceived / WC_AUDIO_RATE,
        samples: msg.samples,
        durSec: n / WC_AUDIO_RATE,
        buffer: null
      });
      this.audioSamplesReceived += n;
      this.scheduleAudio();
    }
  }

  // ---------- decoding ----------

  feedDecoder() {
    const d = this.decoder;
    if (!d || d.state !== "configured") return;
    const clockUs = this.getStreamTime() * 1e6;
    while (this.encoded.length) {
      if (this.frames.length + d.decodeQueueSize >= WC_MAX_DECODED_FRAMES) break;
      const next = this.encoded[0];
      if (next.timestampUs - clockUs > WC_DECODE_AHEAD_SEC * 1e6 && this.frames.length > 0) break;
      this.encoded.shift();
      try {
        d.decode(
          new window.EncodedVideoChunk({
            type: next.keyframe ? "key" : "delta",
            timestamp: next.timestampUs,
            data: next.data
          })
        );
      } catch (err) {
        this.onDecoderError(err, this.decoderGen);
        return;
      }
    }
    if (this.serverEnded && !this.encoded.length && !this.flushRequested) {
      this.flushRequested = true;
      d.flush().catch(() => {});
    }
  }

  onDecodedFrame(frame, gen) {
    if (gen !== this.decoderGen || this.destroyed || this.awaitingReset) {
      frame.close();
      return;
    }
    this.stats.decodedFrames += 1;
    this.newestDecodedUs = Math.max(this.newestDecodedUs, frame.timestamp);
    const list = this.frames;
    if (!list.length || list[list.length - 1].timestamp <= frame.timestamp) {
      list.push(frame);
    } else {
      let i = list.length - 1;
      while (i > 0 && list[i - 1].timestamp > frame.timestamp) i--;
      list.splice(i, 0, frame);
    }
    while (list.length > WC_MAX_DECODED_FRAMES) {
      list.shift().close();
      this.stats.droppedFrames += 1;
    }
  }

  onDecoderError(err, gen) {
    if (gen !== this.decoderGen || this.destroyed) return;
    this.stats.decodeErrors += 1;
    this.errorsSinceReset = (this.errorsSinceReset || 0) + 1;
    const text = (err?.message || String(err)).slice(0, 80);
    if (this.errorsSinceReset > 3) {
      // e.g. NotSupportedError for this codec/level: stop retrying until the next reset.
      try {
        this.decoder.close();
      } catch {
        // Ignore
      }
      this.decoder = null;
      this.cb.onError?.(`VideoDecoder failed (${this.codec}): ${text}`);
      return;
    }
    this.cb.onStatus?.(`Decoder error: ${text}`);
    // Recover: new decoder, wait for the next keyframe in the queue.
    try {
      this.createDecoder();
    } catch {
      this.decoder = null;
      return;
    }
    const k = this.encoded.findIndex((c) => c.keyframe);
    if (k >= 0) {
      this.stats.droppedFrames += k;
      this.encoded.splice(0, k);
      this.needKeyframe = false;
    } else {
      this.stats.droppedFrames += this.encoded.length;
      this.encoded = [];
    }
  }

  closeFrames() {
    for (const f of this.frames) {
      try {
        f.close();
      } catch {
        // Ignore
      }
    }
    this.frames = [];
  }

  flushMedia() {
    this.stopSources();
    this.closeFrames();
    this.encoded = [];
    this.pendingAudio = [];
    this.schedIdx = 0;
    this.audioSamplesReceived = 0;
    this.lastReceivedVideoUs = -1;
    this.newestDecodedUs = -1;
    this.firstKeyUs = -1;
    this.needKeyframe = true;
  }

  // ---------- clock ----------

  outputLatency() {
    const c = this.audioCtx;
    if (!c) return 0;
    const ol = Number(c.outputLatency);
    if (Number.isFinite(ol) && ol > 0) return ol;
    const bl = Number(c.baseLatency);
    return Number.isFinite(bl) && bl > 0 ? bl : 0;
  }

  audioRunning() {
    return Boolean(this.audioCtx && this.audioCtx.state === "running");
  }

  audioEndSec() {
    return this.audioSamplesReceived / WC_AUDIO_RATE;
  }

  videoEndSec() {
    return this.lastReceivedVideoUs < 0 ? 0 : (this.lastReceivedVideoUs + WC_FRAME_US) / 1e6;
  }

  // Heard position on the stream timeline (seconds).
  getStreamTime() {
    if (!this.running) return this.frozenSec;
    if (this.clockMode === "audio") {
      return this.audioCtx.currentTime - this.outputLatency() - this.anchorCtx;
    }
    return this.perfBaseSec + (performance.now() - this.perfStartMs) / 1000;
  }

  startClock(atSec) {
    const useAudio =
      this.hasAudio &&
      !this.audioGap &&
      this.audioRunning() &&
      this.audioEndSec() > atSec + 0.02;
    this.running = true;
    if (useAudio) {
      this.clockMode = "audio";
      this.anchorCtx = this.audioCtx.currentTime + WC_AUDIO_LEAD_SEC - atSec;
    } else {
      this.clockMode = "perf";
      this.perfBaseSec = atSec;
      this.perfStartMs = performance.now();
    }
    this.scheduleAudio();
  }

  freezeClock(atSec = this.getStreamTime()) {
    this.frozenSec = Math.max(0, atSec);
    this.running = false;
    this.stopSources();
  }

  stopSources() {
    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // Ignore
      }
    }
    this.sources.clear();
    this.schedIdx = 0;
  }

  // ---------- audio ----------

  applyGain() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  scheduleAudio() {
    if (!this.running || this.clockMode !== "audio" || !this.audioRunning()) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const list = this.pendingAudio;
    let i = this.schedIdx;
    while (i < list.length) {
      const c = list[i];
      const when = this.anchorCtx + c.startSec;
      if (when > now + WC_AUDIO_HORIZON_SEC) break;
      i += 1;
      const earliest = now + 0.005;
      if (when + c.durSec <= earliest) continue; // already past
      const startAt = Math.max(when, earliest);
      const offset = startAt - when;
      if (!c.buffer) {
        c.buffer = ctx.createBuffer(1, c.samples.length, WC_AUDIO_RATE);
        c.buffer.copyToChannel(c.samples, 0);
      }
      const src = ctx.createBufferSource();
      src.buffer = c.buffer;
      src.connect(this.gain);
      src.onended = () => {
        this.sources.delete(src);
        try {
          src.disconnect();
        } catch {
          // Ignore
        }
      };
      try {
        src.start(startAt, offset);
        this.sources.add(src);
      } catch {
        // Ignore
      }
    }
    this.schedIdx = i;
  }

  pruneAudio(clockSec) {
    const list = this.pendingAudio;
    let n = 0;
    while (n < list.length && list[n].startSec + list[n].durSec < clockSec - 0.25) n++;
    if (n) {
      list.splice(0, n);
      this.schedIdx = Math.max(0, this.schedIdx - n);
    }
  }

  // ---------- presentation ----------

  rafLoop() {
    if (this.destroyed) return;
    this.lastRafMs = performance.now();
    this.tick(true);
    this.rafId = requestAnimationFrame(this.rafLoop);
  }

  pump() {
    if (this.destroyed) return;
    // rAF stops in background tabs (and is throttled in hidden panes); keep frames flowing.
    const rafStale = performance.now() - this.lastRafMs > RAF_STALE_MS;
    if (rafStale) this.tick(false);
    else this.updateState();
  }

  drawFrame(frame) {
    const c = this.canvas;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    try {
      this.ctx2d.drawImage(frame, 0, 0, w, h);
    } catch {
      // Ignore
    }
  }

  tick(draw) {
    this.updateState();
    if (this.awaitingReset) return;

    if (!this.running) {
      // Paused / buffering: show the first decoded frame after a reset as a preview.
      if (!this.presentedSinceReset && this.frames.length) {
        const f = this.frames.shift();
        this.drawFrame(f);
        f.close();
        this.presentedSinceReset = true;
      }
      return;
    }

    const heardSec = this.getStreamTime();
    const clockUs = (heardSec + this.syncOffsetSec) * 1e6;

    if (isPresentationBehind(clockUs, this.newestDecodedUs, WC_CATCHUP_SEC)) {
      this.catchUp(clockUs);
    }

    const ts = this.frames.map((f) => f.timestamp);
    const idx = selectDueFrame(ts, clockUs, WC_FRAME_US / 2);
    if (idx >= 0) {
      for (let i = 0; i < idx; i++) this.frames[i].close();
      this.stats.droppedFrames += idx;
      const f = this.frames[idx];
      this.frames.splice(0, idx + 1);
      if (draw) this.drawFrame(f);
      this.stats.avOffsetMs = Math.round((f.timestamp / 1e6 - heardSec) * 1000);
      this.stats.presentedFrames += 1;
      this.stats.fpsWindow += 1;
      this.presentedSinceReset = true;
      f.close();
      this.cb.onFrame?.(Math.max(0, heardSec));
    } else if (!this.frames.length) {
      this.cb.onFrame?.(Math.max(0, heardSec));
    }
    this.feedDecoder();
  }

  catchUp(clockUs) {
    const k = findCatchUpKeyframe(this.encoded, clockUs);
    // Only jump forward; a keyframe we already restarted from would reset the decoder forever.
    if (k < 0 || this.encoded[k].timestampUs <= this.newestDecodedUs) return;
    this.stats.catchUps += 1;
    this.stats.droppedFrames += k + this.frames.length;
    this.encoded.splice(0, k);
    this.closeFrames();
    try {
      const d = this.decoder;
      d.reset();
      d.configure({ codec: this.codec, optimizeForLatency: true });
    } catch {
      this.createDecoder();
      this.needKeyframe = false;
    }
    this.newestDecodedUs = this.encoded.length ? this.encoded[0].timestampUs : -1;
  }

  // Buffering, clock-source switching, starvation and end-of-stream (runs every rAF and pump).
  updateState() {
    if (this.awaitingReset || this.playbackEnded) return;
    const now = performance.now();
    if (now - this.stats.fpsWindowStart >= 1000) {
      this.stats.fps = this.stats.fpsWindow;
      this.stats.fpsWindow = 0;
      this.stats.fpsWindowStart = now;
    }

    const clockSec = this.getStreamTime();
    const videoEnd = this.videoEndSec();
    const audioEnd = this.audioEndSec();
    const videoAhead = Math.max(0, videoEnd - clockSec);
    const audioAhead = Math.max(0, audioEnd - clockSec);
    // Source has a gap/shorter audio while video keeps coming: don't let audio gate playback.
    if (this.hasAudio && !this.serverEnded) {
      if (!this.audioGap && videoAhead > AUDIO_GAP_VIDEO_SEC + this.rebufferTargetSec && audioAhead < 0.1) {
        this.audioGap = true;
      } else if (this.audioGap && audioAhead > 0.5) {
        this.audioGap = false;
      }
    }
    const gateAudio = this.hasAudio && !this.audioGap;
    const ahead = bufferedAheadSec({
      clockSec,
      videoEndSec: videoEnd,
      audioEndSec: audioEnd,
      hasAudio: gateAudio
    });
    this.lastAheadSec = ahead;

    if (this.running) {
      this.pruneAudio(clockSec);
      // Audio locked/interrupted mid-play → continue on the performance clock.
      if (this.clockMode === "audio" && !this.audioRunning()) {
        const t = clockSec;
        this.freezeClock(t);
        this.startClock(t);
      } else if (
        this.clockMode === "perf" &&
        this.hasAudio &&
        !this.audioGap &&
        this.audioRunning() &&
        audioAhead > 0.3
      ) {
        // Audio became available: hand the clock to the AudioContext.
        const t = clockSec;
        this.freezeClock(t);
        this.startClock(t);
      } else if (this.clockMode === "audio" && this.audioGap) {
        const t = clockSec;
        this.freezeClock(t);
        this.startClock(t);
      }

      if (!this.serverEnded) {
        const starvedAudio = gateAudio && clockSec >= audioEnd - 0.01;
        const starvedVideo =
          !this.frames.length && !this.encoded.length && clockSec >= videoEnd;
        if (starvedAudio || starvedVideo) {
          this.stats.underruns += 1;
          this.freezeClock(Math.min(clockSec, starvedAudio ? audioEnd : videoEnd));
          this.startTargetSec = this.rebufferTargetSec;
          this.setBuffering(true);
        }
      } else {
        const endSec = Math.max(videoEnd, this.hasAudio ? audioEnd : 0);
        const decoderIdle = !this.decoder || this.decoder.decodeQueueSize === 0;
        if (
          !this.frames.length &&
          !this.encoded.length &&
          decoderIdle &&
          clockSec >= endSec - 0.02
        ) {
          this.freezeClock(endSec);
          this.playbackEnded = true;
          this.setBuffering(false);
          this.cb.onPlaybackEnded?.();
          return;
        }
      }
      this.scheduleAudio();
      return;
    }

    // Not running: start once enough is buffered (180 ms; the buffer target after an underrun).
    if (this.paused) return;
    const target = this.startTargetSec;
    const haveFrame = this.frames.length > 0 || this.presentedSinceReset;
    if (haveFrame && (ahead >= target || this.serverEnded)) {
      let at = this.frozenSec;
      if (!this.hadFirstStart && this.firstKeyUs > 0) at = Math.max(at, this.firstKeyUs / 1e6);
      this.hadFirstStart = true;
      this.startTargetSec = WC_START_BUFFER_SEC;
      this.setBuffering(false);
      this.startClock(at);
    } else if (!this.buffering) {
      this.setBuffering(true);
    }
  }

  setBuffering(b) {
    if (this.buffering === b) return;
    this.buffering = b;
    this.cb.onBuffering?.(b);
  }

  // ---------- public API ----------

  send(payload) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  // seek/speed/quality: the server answers with "reset"; drop everything until then.
  // After "ended" the server treats itself as paused (it would stop after one preview frame),
  // so a restart while the client is playing also sends "resume".
  sendExpectingReset(payload) {
    const needResume = this.serverEnded && !this.paused;
    if (!this.send(payload)) return false;
    if (needResume) this.send({ type: "resume" });
    this.awaitingReset = true;
    this.freezeClock(0);
    this.flushMedia();
    this.serverEnded = false;
    this.playbackEnded = false;
    this.setBuffering(!this.paused);
    return true;
  }

  // Also tells the server (pause → SIGSTOP ffmpeg), except after "ended": then there is no
  // ffmpeg and a "resume" would restart the stream from 0 while the buffer is still playing.
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.serverEnded) this.send({ type: paused ? "pause" : "resume" });
    if (paused) {
      if (this.running) this.freezeClock();
      this.startTargetSec = WC_START_BUFFER_SEC;
      this.setBuffering(false);
    } else {
      this.unlockAudio();
      this.updateState();
    }
  }

  setVolume(volume, muted) {
    this.volume = volume;
    this.muted = muted;
    this.applyGain();
  }

  setSyncOffset(sec) {
    this.syncOffsetSec = Number(sec) || 0;
  }

  setRebufferTarget(sec) {
    this.rebufferTargetSec = Math.max(WC_START_BUFFER_SEC, Number(sec) || 2);
  }

  isAudioLocked() {
    return Boolean(this.hasAudio && this.audioCtx && this.audioCtx.state !== "running");
  }

  unlockAudio() {
    const c = this.audioCtx;
    if (c && c.state !== "running" && c.state !== "closed") {
      c.resume().then(() => this.pump()).catch(() => {});
    }
  }

  getStats() {
    const d = this.decoder;
    const clockSec = this.getStreamTime();
    let audioQueuedSec = 0;
    if (this.running && this.clockMode === "audio") {
      audioQueuedSec = Math.max(0, this.audioEndSec() - clockSec);
    } else {
      for (let i = 0; i < this.pendingAudio.length; i++) audioQueuedSec += this.pendingAudio[i].durSec;
    }
    return {
      decoderState: d ? d.state : "none",
      codec: this.codec,
      decodeQueueSize: d ? d.decodeQueueSize : 0,
      framesQueued: this.frames.length,
      encodedQueued: this.encoded.length,
      width: this.canvas.width,
      height: this.canvas.height,
      fps: this.stats.fps,
      droppedFrames: this.stats.droppedFrames,
      decodedFrames: this.stats.decodedFrames,
      presentedFrames: this.stats.presentedFrames,
      skippedBeforeKey: this.stats.skippedBeforeKey,
      catchUps: this.stats.catchUps,
      decodeErrors: this.stats.decodeErrors,
      underruns: this.stats.underruns,
      avOffsetMs: this.stats.avOffsetMs,
      clockMode: this.running ? this.clockMode : "stopped",
      audioState: this.hasAudio ? (this.audioCtx ? this.audioCtx.state : "unavailable") : "no audio track",
      audioSources: this.sources.size,
      audioQueuedMs: Math.round(audioQueuedSec * 1000),
      outputLatencyMs: Math.round(this.outputLatency() * 1000),
      bufferedAheadSec: this.lastAheadSec || 0,
      receivedAheadVideoSec: Math.max(0, this.videoEndSec() - clockSec),
      streamTimeSec: clockSec,
      buffering: this.buffering,
      audioGap: this.audioGap
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    clearInterval(this.pumpId);
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
    }
    this.flushMedia();
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch {
        // Ignore
      }
    }
    if (this.audioCtx) {
      this.audioCtx.onstatechange = null;
      this.audioCtx.close().catch(() => {});
    }
  }
}
