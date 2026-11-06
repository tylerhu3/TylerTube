import fs from "node:fs";
const buf = fs.readFileSync(process.argv[2]);
const pes = {}; // pid -> {cur:[], list:[]}
for (let o = 0; o + 188 <= buf.length; o += 188) {
  if (buf[o] !== 0x47) { console.log("sync lost at", o); break; }
  const pusi = (buf[o+1] & 0x40) !== 0; const pid = ((buf[o+1] & 0x1f) << 8) | buf[o+2];
  const afc = (buf[o+3] >> 4) & 3; let p = o + 4;
  if (afc === 2) continue; if (afc === 3) p += 1 + buf[p];
  if (pid !== 0x100 && pid !== 0x101) continue;
  const s = pes[pid] ||= { cur: null, list: [] };
  if (pusi) { if (s.cur) s.list.push(s.cur);
    const flags = buf[p+7], hlen = buf[p+8]; let pts = null;
    if (flags & 0x80) { const b = buf.subarray(p+9); pts = (((b[0]>>1)&7)*2**30 + (b[1]<<22) + ((b[2]>>1)<<15) + (b[3]<<7) + (b[4]>>1)) / 90000; }
    s.cur = { pts, chunks: [buf.subarray(p + 9 + hlen, o + 188)] };
  } else if (s.cur) s.cur.chunks.push(buf.subarray(p, o + 188));
}
for (const [pid, s] of Object.entries(pes)) {
  const isAudio = s.list.length && Buffer.concat(s.list[0].chunks)[0] === 0xff;
  const hist = {}; let noPts = 0, gaps = [];
  let prev = null;
  for (const pk of s.list) {
    const d = Buffer.concat(pk.chunks); let n = 0;
    if (isAudio) { for (let i = 0; i + 1 < d.length; i++) if (d[i] === 0xff && (d[i+1] & 0xfe) === 0xfc) { n++; i += 400; } }
    else { for (let i = 0; i + 3 < d.length; i++) if (d[i]===0 && d[i+1]===0 && d[i+2]===1 && d[i+3]===0) n++; }
    hist[n] = (hist[n]||0) + 1; if (pk.pts === null) noPts++;
    if (prev !== null && pk.pts !== null) { const dt = pk.pts - prev; const exp = isAudio ? 1152/44100 : 1/30; if (Math.abs(dt - exp) > 0.002) gaps.push([+prev.toFixed(3), +dt.toFixed(4)]); }
    if (pk.pts !== null) prev = pk.pts;
  }
  console.log(`pid ${pid} ${isAudio ? "audio" : "video"}: ${s.list.length} PES, frames-per-PES ${JSON.stringify(hist)}, no-PTS ${noPts}, irregular PTS steps ${gaps.length}`, gaps.slice(0, 8));
}
