// Pure rules for handing WebCodecs playback to a hidden <audio> while the page is hidden
// (backgroundAudio.js, wired in WebCodecsPlayer.jsx). No DOM; tested in tests/webcodecs.test.js.

// Within this many seconds of the end there is nothing worth continuing in the background.
export const HANDOFF_END_MARGIN_SEC = 0.5;

// <audio>.volume only accepts [0, 1]; the player's boost above 100% can't follow it.
export function clampVolume(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

// Only touch-first mobile browsers suspend Web Audio while the page is hidden (iOS/iPadOS,
// Android); desktop keeps playing the engine in a background tab, so it never needs the <audio>
// (which would also fetch the MP4 alongside the stream).
export function backgroundHandoffNeeded({ coarsePointer = false, maxTouchPoints = 0, ua = "" } = {}) {
  const agent = String(ua || "");
  const touches = Number(maxTouchPoints) || 0;
  if (/iPhone|iPad|iPod/i.test(agent)) return true;
  // iPadOS Safari reports itself as a Mac; real Macs have no touch points.
  if (/Macintosh/i.test(agent) && touches > 1) return true;
  if (/Android/i.test(agent)) return true;
  // Other phones/tablets: a mobile UA token plus a touch-first pointer.
  return Boolean(coarsePointer) && touches > 0 && /Mobi|Tablet/i.test(agent);
}

// Hand off only when the page went hidden while the player was really playing (and audible:
// a muted player has nothing to continue in the background).
export function shouldHandOff({
  hidden,
  playing,
  ended,
  unlocked,
  supported,
  muted = false,
  timeSec = 0,
  durationSec = 0
}) {
  if (!hidden || !playing || ended || !unlocked || !supported || muted) return false;
  const dur = Number(durationSec);
  if (dur > 0 && Number(timeSec) >= dur - HANDOFF_END_MARGIN_SEC) return false;
  return true;
}

// Where the engine resumes after the handoff: the audio element's time, clamped to the media.
export function resumePosition({ audioTimeSec, durationSec, ended }) {
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 0;
  if (ended && dur > 0) return dur;
  const t = Number(audioTimeSec);
  if (!Number.isFinite(t) || t < 0) return 0;
  return dur > 0 ? Math.min(t, dur) : t;
}
