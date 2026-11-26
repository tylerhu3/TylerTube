// Background audio: one hidden <audio> playing the video's MP4 URL directly, so sound
// keeps going while the page is hidden (iOS interrupts the engine's AudioContext and throttles
// timers there). Owned by WebCodecsPlayer.jsx; rules in backgroundHandoff.js.
//
// iOS only lets an element start unmuted playback outside a gesture if it was played once inside
// one, so unlock() (muted play → pause → unmute) must run from a user gesture. The element is
// kept across files (setSource) so that unlock persists.
//
// The MP4 is only attached in start(): preload="none" and the unlock plays a tiny silent WAV, so
// the browser never downloads the video alongside the stream unless a handoff actually happens.
import { clampVolume } from "./backgroundHandoff";

const TIME_REPORT_MS = 1000;
const HAVE_METADATA = 1;

// 8 kHz mono 8-bit WAV, 0.01 s of silence (~100 bytes as a data: URI).
function silentWavDataUri() {
  const samples = 80;
  const bytes = [];
  const str = (t) => {
    for (let i = 0; i < t.length; i += 1) bytes.push(t.charCodeAt(i));
  };
  const u32 = (n) => bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  const u16 = (n) => bytes.push(n & 255, (n >> 8) & 255);
  str("RIFF");
  u32(36 + samples);
  str("WAVEfmt ");
  u32(16);
  u16(1); // PCM
  u16(1); // mono
  u32(8000);
  u32(8000); // byte rate
  u16(1); // block align
  u16(8); // bits per sample
  str("data");
  u32(samples);
  for (let i = 0; i < samples; i += 1) bytes.push(128);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

let silentWav = "";

export class BackgroundAudio {
  static isSupported() {
    return typeof document !== "undefined" && typeof document.createElement === "function";
  }

  constructor(callbacks = {}) {
    this.cb = callbacks; // onTime(sec), onEnded(), onPausedExternally(sec), onPlayExternally(), onError()
    this.unlockState = "none"; // none | pending | ok
    this.active = false; // true from start() until stop() (or a failed start)
    this.ignorePlay = false; // the next "play" event is ours (start/unlock)
    this.starting = false; // start() pending: its promise reports errors, not onError
    this.startToken = 0;
    this.lastTimeReport = 0;
    this.src = ""; // wanted media URL (setSource)
    this.loadedSrc = ""; // what the element currently holds: "", "silent" or a media URL
    this.metaListener = null; // pending "loadedmetadata" seek from start()

    const el = document.createElement("audio");
    el.preload = "none";
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    this.el = el;

    this.listeners = [];
    const on = (name, fn) => {
      el.addEventListener(name, fn);
      this.listeners.push([name, fn]);
    };
    on("timeupdate", () => {
      if (!this.active) return;
      const now = Date.now();
      if (now - this.lastTimeReport < TIME_REPORT_MS) return;
      this.lastTimeReport = now;
      this.cb.onTime?.(el.currentTime);
    });
    on("pause", () => {
      // Reaching the end also fires "pause" (then "ended"); stop() clears `active` first.
      if (!this.active || el.ended) return;
      this.cb.onPausedExternally?.(el.currentTime);
    });
    on("play", () => {
      if (this.ignorePlay) {
        this.ignorePlay = false;
        return;
      }
      if (this.active) this.cb.onPlayExternally?.();
    });
    on("ended", () => {
      if (this.active) this.cb.onEnded?.();
    });
    on("error", () => {
      if (this.active && !this.starting) this.cb.onError?.();
    });
  }

  get isActive() {
    return this.active;
  }

  get isUnlocked() {
    return this.unlockState === "ok";
  }

  get currentTime() {
    return this.el ? this.el.currentTime || 0 : 0;
  }

  get duration() {
    const d = this.el ? this.el.duration : 0;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  // Only remembers the URL; start() attaches it (no download until a handoff).
  setSource(url) {
    if (!this.el || !url || this.src === url) return;
    if (this.active) this.stop();
    this.clearMetaListener();
    this.src = url;
  }

  clearMetaListener() {
    if (this.metaListener && this.el) this.el.removeEventListener("loadedmetadata", this.metaListener);
    this.metaListener = null;
  }

  // Call from a user gesture. Idempotent; a failure leaves it "none" so the next gesture retries.
  // Plays the silent WAV (not the MP4) so the unlock doesn't make the browser buffer the video.
  unlock() {
    const el = this.el;
    if (!el || this.unlockState !== "none" || this.active) return;
    this.unlockState = "pending";
    if (this.loadedSrc !== "silent") {
      // Also after a failed start(): never unlock by playing (and so buffering) the MP4.
      if (!silentWav) silentWav = silentWavDataUri();
      el.src = silentWav;
      this.loadedSrc = "silent";
    }
    el.muted = true;
    this.ignorePlay = true;
    let p;
    try {
      p = el.play();
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p)
      .then(() => {
        if (!this.active) {
          el.pause();
          el.muted = false;
        }
        this.unlockState = "ok";
      })
      .catch(() => {
        if (this.active) return; // start() took over the element (and set muted itself)
        this.ignorePlay = false;
        el.muted = false;
        this.unlockState = "none";
      });
  }

  // Must be called synchronously from the event handler (visibilitychange). Resolves false on
  // NotAllowedError, an unsupported source or an error event; the element is then stopped.
  start({ timeSec = 0, rate = 1, volume = 1, muted = false, loop = false } = {}) {
    const el = this.el;
    if (!el || !this.src) return Promise.resolve(false);
    const token = ++this.startToken;
    const t = Math.max(0, Number(timeSec) || 0);
    this.clearMetaListener();
    if (this.loadedSrc !== this.src) {
      el.src = this.src; // first handoff for this file: only now does the browser fetch it
      this.loadedSrc = this.src;
      try {
        el.load();
      } catch {
        // Ignore
      }
    }
    try {
      el.currentTime = t;
    } catch {
      // Ignored before metadata on some browsers; set again below.
    }
    if (el.readyState < HAVE_METADATA) {
      const onMeta = () => {
        if (this.metaListener === onMeta) this.metaListener = null;
        try {
          el.currentTime = t;
        } catch {
          // Ignore
        }
      };
      this.metaListener = onMeta;
      el.addEventListener("loadedmetadata", onMeta, { once: true });
    }
    const r = Number(rate) > 0 ? Number(rate) : 1;
    el.defaultPlaybackRate = r;
    el.playbackRate = r;
    el.volume = clampVolume(volume);
    el.muted = Boolean(muted);
    el.loop = Boolean(loop);
    this.active = true;
    this.lastTimeReport = Date.now();
    this.ignorePlay = true;
    this.starting = true;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (token === this.startToken) this.starting = false;
        el.removeEventListener("error", onError);
        const current = token === this.startToken && this.active;
        if (!ok && current) {
          this.active = false;
          this.ignorePlay = false;
          el.pause();
        }
        resolve(ok && current);
      };
      const onError = () => finish(false);
      el.addEventListener("error", onError);
      let p;
      try {
        p = el.play();
      } catch (err) {
        p = Promise.reject(err);
      }
      Promise.resolve(p).then(
        () => finish(true),
        (err) => {
          // A NotAllowedError means the unlock didn't take: retry it on the next gesture.
          if (err && err.name === "NotAllowedError") this.unlockState = "none";
          finish(false);
        }
      );
    });
  }

  // Pauses and returns the element's position (seconds).
  stop() {
    const el = this.el;
    if (!el) return 0;
    const t = el.currentTime || 0;
    this.clearMetaListener();
    this.active = false;
    this.ignorePlay = false;
    this.starting = false;
    this.startToken += 1;
    if (!el.paused) el.pause();
    return t;
  }

  destroy() {
    const el = this.el;
    if (!el) return;
    this.stop();
    for (const [name, fn] of this.listeners) el.removeEventListener(name, fn);
    this.listeners = [];
    el.removeAttribute("src");
    this.loadedSrc = "";
    try {
      el.load();
    } catch {
      // Ignore
    }
    el.remove();
    this.el = null;
    this.cb = {};
  }
}
