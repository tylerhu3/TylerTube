import { spawnSync } from "node:child_process";
const [src, drv, dur] = [process.argv[2], process.argv[3], +process.argv[4] || 185];
const run = (args) => spawnSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 2e9 }).stdout;
const AR = 8000, W = 16, H = 9;
const audio = (f) => { const b = run(["-i", f, "-t", String(dur), "-vn", "-ac", "1", "-af", `aresample=${AR}:first_pts=0`, "-f", "s16le", "-"]); return new Int16Array(b.buffer, b.byteOffset, b.length >> 1); };
const video = (f) => run(["-i", f, "-t", String(dur), "-an", "-vf", `fps=30:start_time=0,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]);
const [aS, aD, vS, vD] = [audio(src), audio(drv), video(src), video(drv)];
const F = W * H;
// audio offset: lag (s) such that drv[t] ~ src[t - lag]... we report how late Drive is vs source
function aOff(t) { const n = 4 * AR, c0 = Math.round(t * AR); let best = -Infinity, bl = 0;
  for (let lag = -AR; lag <= AR; lag += 1) { let s = 0, ea = 0, eb = 0; const st = 8; // coarse
    if (lag % 4) continue;
    for (let i = 0; i < n; i += st) { const a = aD[c0 + i], b = aS[c0 + i - lag]; if (a === undefined || b === undefined) continue; s += a * b; ea += a * a; eb += b * b; }
    const r = s / Math.sqrt(ea * eb + 1); if (r > best) { best = r; bl = lag; } }
  // refine
  for (let lag = bl - 4; lag <= bl + 4; lag++) { let s = 0, ea = 0, eb = 0; for (let i = 0; i < n; i += 2) { const a = aD[c0 + i], b = aS[c0 + i - lag]; if (a === undefined || b === undefined) continue; s += a * b; ea += a * a; eb += b * b; } const r = s / Math.sqrt(ea * eb + 1); if (r > best) { best = r; bl = lag; } }
  return [bl / AR * 1000, best]; }
function vOff(t) { const n = 120, f0 = Math.round(t * 30); let best = Infinity, bl = 0;
  for (let lag = -30; lag <= 30; lag++) { let s = 0, cnt = 0; for (let k = 0; k < n; k++) { const i = f0 + k, j = f0 + k - lag; if (j < 0 || (i + 1) * F > vD.length || (j + 1) * F > vS.length) continue; for (let p = 0; p < F; p++) s += Math.abs(vD[i * F + p] - vS[j * F + p]); cnt++; } const m = s / (cnt * F || 1); if (m < best) { best = m; bl = lag; } }
  return [bl / 30 * 1000, best]; }
console.log("t(s)  audioShift(ms)  videoShift(ms)  video-audio(ms)   [+ = picture late vs sound]  (corr / frame diff)");
for (let t = 5; t + 6 < dur; t += 10) { const [ao, ac] = aOff(t); const [vo, vd] = vOff(t);
  console.log(`${String(t).padStart(4)}  ${ao.toFixed(1).padStart(9)}  ${vo.toFixed(0).padStart(12)}  ${(vo - ao).toFixed(0).padStart(12)}        (${ac.toFixed(2)} / ${vd.toFixed(1)})`); }
