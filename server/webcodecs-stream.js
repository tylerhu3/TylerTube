// Pure pieces of the WebCodecs stream (/ws/mpeg1, see drive-ws.js):
// ffmpeg args, Annex-B access-unit splitter, PCM coalescer and binary message packing.
// Client side: src/components/webcodecs/protocol.js. Wire formats must change together.
//   [4][keyframe u8][timestamp u64 BE, µs][H.264 Annex-B access unit]
//   [2][PCM s16le, mono, 44100 Hz]
// Unit-tested in tests/webcodecs.test.js (no ffmpeg needed).

export const WC_MSG_VIDEO = 4;
export const WC_MSG_AUDIO = 2;
export const WC_VIDEO_HEADER_BYTES = 10;
export const WC_FPS = 30;
export const WC_FRAME_US = 1e6 / WC_FPS;
export const WC_AUDIO_RATE = 44100;
export const WC_AUDIO_CHANNELS = 1;
// Server-side flow control: stop reading ffmpeg once this much media is in flight to the client.
export const WC_MAX_AHEAD_SEC = 30;
export const WC_RESUME_AHEAD_SEC = 25;

// H.264 Constrained Baseline. Level 3.1 (MaxFS 3600 MBs) covers up to 1280x720;
// 1080p (8160 MBs) needs level 4.0. The codec string is sent to the client in meta/reset.
const WC_QUALITY_TABLE = {
  360: { width: 640, height: 360, bitrate: 700, level: "3.1", codec: "avc1.42E01F" },
  480: { width: 854, height: 480, bitrate: 1100, level: "3.1", codec: "avc1.42E01F" },
  720: { width: 1280, height: 720, bitrate: 2200, level: "3.1", codec: "avc1.42E01F" },
  1080: { width: 1920, height: 1080, bitrate: 4500, level: "4.0", codec: "avc1.42E028" }
};

export function webCodecsVideoParams(quality) {
  return WC_QUALITY_TABLE[quality] || WC_QUALITY_TABLE[720];
}

// atempo accepts 0.5..100 per instance; chain halves for slower speeds.
export function buildAtempoChain(speed) {
  let spd = Number(speed) || 1;
  if (Math.abs(spd - 1) <= 0.01) return [];
  const parts = [];
  while (spd < 0.5) {
    parts.push("atempo=0.5");
    spd /= 0.5;
  }
  parts.push(`atempo=${Number(spd.toFixed(6))}`);
  return parts;
}

// Video → raw H.264 Annex-B on stdout (pipe:1); audio → raw s16le mono 44.1 kHz on fd 3.
// Both outputs start at stream time 0 (fps start_time=0, aresample first_pts=0), so a client can
// place video frame n at n/30 s and audio sample k at k/44100 s on one timeline.
export function buildWebCodecsFfmpegArgs({
  input,
  seek = 0,
  speed = 1,
  quality = 720,
  hasAudio = true
}) {
  const spd = Number(speed) || 1;
  const { width, height, bitrate, level } = webCodecsVideoParams(quality);
  const args = [];
  if (seek > 0) args.push("-ss", Number(seek).toFixed(3));
  const burstReadRate = Math.min(2.5, Math.max(1.3, spd * 1.5));
  args.push(
    "-readrate",
    String(burstReadRate),
    "-readrate_initial_burst",
    "10.0",
    "-fflags",
    "+genpts",
    "-i",
    input
  );

  const vf = [];
  if (Math.abs(spd - 1) > 0.01) vf.push(`setpts=PTS/${spd}`);
  vf.push(
    `fps=${WC_FPS}:start_time=0`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "format=yuv420p"
  );

  args.push(
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-vf",
    vf.join(","),
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-level:v",
    level,
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-bf",
    "0",
    "-g",
    "60",
    "-aud",
    "1",
    "-b:v",
    `${bitrate}k`,
    "-maxrate",
    `${bitrate}k`,
    "-bufsize",
    `${bitrate * 2}k`,
    "-flush_packets",
    "1",
    "-f",
    "h264",
    "pipe:1"
  );

  if (hasAudio) {
    const af = [...buildAtempoChain(spd), `aresample=${WC_AUDIO_RATE}:async=1000:first_pts=0`];
    args.push(
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-af",
      af.join(","),
      "-c:a",
      "pcm_s16le",
      "-ac",
      String(WC_AUDIO_CHANNELS),
      "-ar",
      String(WC_AUDIO_RATE),
      "-flush_packets",
      "1",
      "-f",
      "s16le",
      "pipe:3"
    );
  }
  return args;
}

// Splits an Annex-B byte stream into access units, using AUD NALs (type 9) as boundaries.
// push(chunk) returns the AUs completed so far; flush() returns the trailing AU (or null).
// Each AU: { data: Buffer, keyframe: boolean } where keyframe = contains an IDR slice (type 5).
export class AnnexBSplitter {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.scanPos = 0;
    this.auOpen = false; // saw the AUD that starts pending
    this.hasIdr = false;
  }

  push(chunk) {
    const out = [];
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const buf = this.pending;
    let i = this.scanPos;
    let cutBase = 0;
    // Need buf[i..i+3] (start code + NAL header byte).
    while (i + 3 < buf.length) {
      if (buf[i + 2] > 1) {
        i += 3;
        continue;
      }
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) {
        i += 1;
        continue;
      }
      const nalType = buf[i + 3] & 0x1f;
      if (nalType === 9) {
        const cut = i > cutBase && buf[i - 1] === 0 ? i - 1 : i;
        // Bytes before the very first AUD can't form a complete AU; they are dropped.
        if (this.auOpen && cut > cutBase) {
          out.push({ data: buf.subarray(cutBase, cut), keyframe: this.hasIdr });
        }
        cutBase = cut;
        this.auOpen = true;
        this.hasIdr = false;
      } else if (nalType === 5) {
        this.hasIdr = true;
      }
      i += 4;
    }
    // Keep the unfinished AU; rescan from where the loop stopped (≤3 bytes overlap).
    this.pending = buf.subarray(cutBase);
    this.scanPos = Math.max(0, i - cutBase);
    if (!this.auOpen) {
      // Still haven't seen an AUD: keep only a tail that might hold a split 4-byte start code.
      const keep = Math.min(this.pending.length, 4);
      this.pending = this.pending.subarray(this.pending.length - keep);
      this.scanPos = 0;
    }
    return out;
  }

  flush() {
    const buf = this.pending;
    const keyframe = this.hasIdr;
    const open = this.auOpen;
    this.pending = Buffer.alloc(0);
    this.scanPos = 0;
    this.auOpen = false;
    this.hasIdr = false;
    // The scan loop stops ≤3 bytes before the end, which can't hold a NAL header, so hasIdr
    // is already complete here.
    if (!open || buf.length <= 4) return null;
    return { data: buf, keyframe };
  }
}

// Collects s16le bytes and releases whole samples in chunks of at least minBytes.
export class PcmCoalescer {
  constructor(minBytes = 4096) {
    this.minBytes = Math.max(2, minBytes & ~1);
    this.parts = [];
    this.length = 0;
  }

  push(chunk) {
    this.parts.push(chunk);
    this.length += chunk.length;
    if (this.length < this.minBytes) return null;
    return this.take(false);
  }

  flush() {
    if (this.length >= 2) return this.take(true);
    this.parts = [];
    this.length = 0;
    return null;
  }

  take(final) {
    const all = Buffer.concat(this.parts, this.length);
    const even = all.length & ~1;
    const out = all.subarray(0, even);
    const rest = final ? Buffer.alloc(0) : all.subarray(even);
    this.parts = rest.length ? [Buffer.from(rest)] : [];
    this.length = rest.length;
    return out.length ? out : null;
  }
}

export function packVideoMessage(au, keyframe, timestampUs) {
  const header = Buffer.alloc(WC_VIDEO_HEADER_BYTES);
  header[0] = WC_MSG_VIDEO;
  header[1] = keyframe ? 1 : 0;
  header.writeBigUInt64BE(BigInt(Math.max(0, Math.round(timestampUs))), 2);
  return Buffer.concat([header, au]);
}

export function packAudioMessage(pcm) {
  return Buffer.concat([Buffer.from([WC_MSG_AUDIO]), pcm]);
}

export function frameTimestampUs(frameIndex) {
  return Math.round(frameIndex * WC_FRAME_US);
}
