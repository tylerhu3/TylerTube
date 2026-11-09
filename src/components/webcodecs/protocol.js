// WebCodecs wire format (client side). Server side: server/webcodecs-stream.js.
// Binary frames (first byte = type):
//   4: [4][keyframe u8][timestamp u64 BE, µs from stream start][H.264 Annex-B access unit]
//   2: [2][PCM s16le, mono, 44100 Hz]
// Text frames: the Drive JSON control protocol (server/drive-ws.js). Pure; tested in tests/.
export const WC_MSG_VIDEO = 4;
export const WC_MSG_AUDIO = 2;
export const WC_VIDEO_HEADER_BYTES = 10;
export const WC_AUDIO_RATE = 44100;
export const WC_FPS = 30;
export const WC_FRAME_US = 1e6 / WC_FPS;

// Constrained Baseline at 30 fps: 1080p needs level 4.0 (0x28), everything else fits 3.1 (0x1F).
// The server also sends the string as meta.videoCodec; this is the fallback.
export const WC_CODEC_BY_QUALITY = {
  360: "avc1.42E01F",
  480: "avc1.42E01F",
  720: "avc1.42E01F",
  1080: "avc1.42E028"
};

// Above 30 fps the macroblock rate needs a higher level (720p60 → 3.2, 1080p60 → 4.2).
// Mirrors h264LevelFor() in server/webcodecs-stream.js (tests check they agree).
const WC_HIGH_FPS_CODEC = {
  360: "avc1.42E01F",
  480: "avc1.42E01F",
  720: "avc1.42E020",
  1080: "avc1.42E02A"
};

export function codecForQuality(quality, fps = WC_FPS) {
  const table = Number(fps) > WC_FPS + 0.01 ? WC_HIGH_FPS_CODEC : WC_CODEC_BY_QUALITY;
  return table[quality] || table[720];
}

// Microseconds per frame for a stream's fps (meta/reset `fps`); WC_FRAME_US when unknown.
export function frameDurationUs(fps) {
  const f = Number(fps);
  return f > 0 ? 1e6 / f : WC_FRAME_US;
}

export function isWebCodecsSupported(win = typeof window !== "undefined" ? window : undefined) {
  return Boolean(
    win &&
      typeof win.VideoDecoder === "function" &&
      typeof win.EncodedVideoChunk === "function"
  );
}

// Little-endian s16 → float32 in [-1, 1). Works on unaligned views (payload starts at byte 1).
export function pcm16leToFloat32(bytes) {
  const n = bytes.byteLength >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

// Returns {kind:"video", keyframe, timestampUs, data} | {kind:"audio", samples} | null.
// `data` is a view into `input` (no copy).
export function parseBinaryMessage(input) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null;
  if (!bytes || bytes.byteLength < 1) return null;
  const type = bytes[0];
  if (type === WC_MSG_VIDEO) {
    if (bytes.byteLength <= WC_VIDEO_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, WC_VIDEO_HEADER_BYTES);
    const hi = view.getUint32(2, false);
    const lo = view.getUint32(6, false);
    return {
      kind: "video",
      keyframe: bytes[1] !== 0,
      timestampUs: hi * 4294967296 + lo,
      data: bytes.subarray(WC_VIDEO_HEADER_BYTES)
    };
  }
  if (type === WC_MSG_AUDIO) {
    if (bytes.byteLength < 3) return null;
    return { kind: "audio", samples: pcm16leToFloat32(bytes.subarray(1)) };
  }
  return null;
}
