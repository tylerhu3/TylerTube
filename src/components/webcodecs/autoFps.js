// "Auto" frame-rate controller for the WebCodecs player (pure; tested in tests/webcodecs.test.js).
// WebCodecsPlayer feeds it one health sample per second (WebCodecsEngine.takeHealthSample());
// it walks a ladder of output rates (index 0 = source rate, capped at 60 by the server):
//   - step down after `badWindows` consecutive bad seconds (late/dropped frames, decode backlog,
//     underruns/catch-ups, or the stream arriving slower than real time with little buffered);
//   - step up after `upAfterSec` of healthy seconds; a step up that fails within
//     `failedUpWindowSec` doubles that wait (up to `maxUpAfterSec`) so it doesn't flap.
// Samples taken while paused/buffering/hidden, or shortly after a stream (re)start, are ignored.

export const AUTO_FPS_TUNING = {
  warmupSec: 4,
  badWindows: 3,
  upAfterSec: 30,
  maxUpAfterSec: 480,
  failedUpWindowSec: 90,
  minFramesForRatio: 8,
  lateRatioBad: 0.12,
  lateRatioGood: 0.03,
  decodeQueueBad: 12,
  decodeQueueGood: 4,
  lowAheadSec: 4,
  slowArrivalRate: 0.9,
  healthyAheadSec: 8,
  fastArrivalRate: 1.15
};

// Lowest rate Auto will go to; halving below this is not offered.
export const AUTO_FPS_FLOOR = 12;

// Output rates Auto walks through, highest first. `cap` is meta.fpsCap (what "source" resolves
// to). Halving keeps an even cadence (60 → 30 → 15, 59.94 → 29.97, 24 → 12, 50 → 25 → 12.5).
export function autoFpsLadder(cap) {
  const top = Number(cap) > 0 ? Number(cap) : 30;
  const ladder = [top];
  let f = top;
  while (f / 2 >= AUTO_FPS_FLOOR - 1e-9) {
    f /= 2;
    ladder.push(Math.round(f * 1e6) / 1e6);
  }
  return ladder;
}

// sample: { active, dtSec, presented, late, decodeQueue, aheadSec, arrivalRate, underruns,
//           catchUps, ended }
// → "skip" | "bad" | "good" | "neutral"
export function classifyHealthSample(sample, t = AUTO_FPS_TUNING) {
  if (!sample || !sample.active || !(sample.dtSec > 0)) return "skip";
  const shown = (sample.presented || 0) + (sample.late || 0);
  const lateRatio = shown >= t.minFramesForRatio ? (sample.late || 0) / shown : 0;
  const ahead = Number(sample.aheadSec) || 0;
  const rate = Number.isFinite(sample.arrivalRate) ? sample.arrivalRate : 1;
  const queue = sample.decodeQueue || 0;
  // Server finished sending: arrival rate is 0 by design, the buffer just drains.
  const starving = !sample.ended && ahead < t.lowAheadSec && rate < t.slowArrivalRate;
  if (
    (sample.underruns || 0) > 0 ||
    (sample.catchUps || 0) > 0 ||
    lateRatio > t.lateRatioBad ||
    queue > t.decodeQueueBad ||
    starving
  ) {
    return "bad";
  }
  const headroom = sample.ended || ahead >= t.healthyAheadSec || rate >= t.fastArrivalRate;
  if (lateRatio <= t.lateRatioGood && queue <= t.decodeQueueGood && headroom) return "good";
  return "neutral";
}

export function createAutoFpsState(t = AUTO_FPS_TUNING) {
  return {
    level: 0,
    badStreak: 0,
    goodSec: 0,
    activeSec: 0, // active seconds since the last level change / stream restart
    upAfterSec: t.upAfterSec,
    lastAction: null
  };
}

// Call after any stream restart (seek, quality, speed, fps): the first seconds are warm-up.
export function restartAutoFpsWarmup(state) {
  return { ...state, badStreak: 0, activeSec: 0 };
}

// Returns { state, action: "down" | "up" | null, verdict }. levels = ladder length.
export function stepAutoFps(state, sample, levels, t = AUTO_FPS_TUNING) {
  const verdict = classifyHealthSample(sample, t);
  const s = { ...state, level: Math.max(0, Math.min(Math.max(0, levels - 1), state.level)) };
  if (verdict === "skip") return { state: s, action: null, verdict };

  s.activeSec += sample.dtSec;
  // A step up that survived the failure window was fine: back to the normal wait.
  if (s.lastAction === "up" && s.activeSec >= t.failedUpWindowSec) {
    s.lastAction = null;
    s.upAfterSec = t.upAfterSec;
  }
  if (s.activeSec <= t.warmupSec) return { state: s, action: null, verdict };

  if (verdict === "bad") {
    s.badStreak += 1;
    s.goodSec = 0;
  } else if (verdict === "good") {
    s.badStreak = 0;
    s.goodSec += sample.dtSec;
  } else {
    s.badStreak = 0;
  }

  if (s.badStreak >= t.badWindows && s.level < levels - 1) {
    if (s.lastAction === "up" && s.activeSec < t.failedUpWindowSec) {
      s.upAfterSec = Math.min(t.maxUpAfterSec, s.upAfterSec * 2);
    }
    return { state: changeLevel(s, s.level + 1, "down"), action: "down", verdict };
  }
  if (s.goodSec >= s.upAfterSec && s.level > 0) {
    return { state: changeLevel(s, s.level - 1, "up"), action: "up", verdict };
  }
  return { state: s, action: null, verdict };
}

function changeLevel(s, level, action) {
  return { ...s, level, badStreak: 0, goodSec: 0, activeSec: 0, lastAction: action };
}
