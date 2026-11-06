// Pure presentation/buffering helpers for the WebCodecs engine (no DOM). Tested in tests/.
export const WC_MAX_DECODED_FRAMES = 90;
export const WC_START_BUFFER_SEC = 0.18;
export const WC_CATCHUP_SEC = 2.5;
export const WC_DECODE_AHEAD_SEC = 2.0;
export const WC_AUDIO_LEAD_SEC = 0.05;
export const WC_AUDIO_HORIZON_SEC = 1.0;

// Index of the newest frame due at clockUs (timestamp <= clockUs + toleranceUs), or -1 if the
// oldest queued frame is still in the future. Frames before the returned index are late and
// should be dropped. `timestampsUs` must be ascending.
export function selectDueFrame(timestampsUs, clockUs, toleranceUs = 0) {
  const limit = clockUs + toleranceUs;
  let lo = 0;
  let hi = timestampsUs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestampsUs[mid] <= limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// When decoding has fallen more than WC_CATCHUP_SEC behind the clock: index into the encoded
// queue of the newest keyframe at or before clockUs (decode can restart there), else -1.
export function findCatchUpKeyframe(chunks, clockUs) {
  let idx = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].timestampUs > clockUs) break;
    if (chunks[i].keyframe) idx = i;
  }
  return idx;
}

export function isPresentationBehind(clockUs, newestDecodedUs, thresholdSec = WC_CATCHUP_SEC) {
  return newestDecodedUs >= 0 && clockUs - newestDecodedUs > thresholdSec * 1e6;
}

// Seconds of received media ahead of the clock. With audio, the shorter of the two streams
// limits playback (the audio clock stops when audio runs out).
export function bufferedAheadSec({ clockSec, videoEndSec, audioEndSec, hasAudio }) {
  const v = Math.max(0, videoEndSec - clockSec);
  if (!hasAudio) return v;
  return Math.min(v, Math.max(0, audioEndSec - clockSec));
}

// Media position shown to the user: stream time is output time (speed applied by ffmpeg).
export function mediaTimeFromStream(seekBaseSec, streamSec, speed, durationSec = 0) {
  const t = seekBaseSec + Math.max(0, streamSec) * (speed || 1);
  return durationSec > 0 ? Math.min(durationSec, t) : t;
}
