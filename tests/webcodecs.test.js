// WebCodecs Drive mode: server pieces (server/webcodecs-stream.js) and the client's pure helpers
// (src/components/webcodecs/{protocol,scheduler}.js). No ffmpeg, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnnexBSplitter,
  PcmCoalescer,
  buildAtempoChain,
  buildWebCodecsFfmpegArgs,
  frameTimestampUs,
  packAudioMessage,
  packVideoMessage,
  webCodecsVideoParams
} from "../server/webcodecs-stream.js";
import {
  WC_CODEC_BY_QUALITY,
  codecForQuality,
  isWebCodecsSupported,
  parseBinaryMessage,
  pcm16leToFloat32
} from "../src/components/webcodecs/protocol.js";
import {
  bufferedAheadSec,
  findCatchUpKeyframe,
  isPresentationBehind,
  mediaTimeFromStream,
  selectDueFrame
} from "../src/components/webcodecs/scheduler.js";

const SC4 = [0, 0, 0, 1];
const SC3 = [0, 0, 1];
const nal = (type, payload = [0xaa, 0xbb], sc = SC4) => [...sc, type, ...payload];
const aud = (sc = SC4) => nal(0x09, [0xf0], sc);

function concatBytes(...parts) {
  return Buffer.from(parts.flat());
}

test("AnnexBSplitter: splits on AUD, flags IDR AUs, keeps trailing AU for flush()", () => {
  const au1 = concatBytes(aud(), nal(0x67), nal(0x68), nal(0x65, [1, 2, 3])); // SPS PPS IDR
  const au2 = concatBytes(aud(SC3), nal(0x41, [4, 5], SC3)); // non-IDR slice, 3-byte codes
  const au3 = concatBytes(aud(), nal(0x41, [6]));
  const stream = Buffer.concat([au1, au2, au3]);

  const s = new AnnexBSplitter();
  const out = s.push(stream);
  assert.equal(out.length, 2);
  assert.deepEqual(Buffer.from(out[0].data), au1);
  assert.equal(out[0].keyframe, true);
  assert.deepEqual(Buffer.from(out[1].data), au2);
  assert.equal(out[1].keyframe, false);
  const last = s.flush();
  assert.deepEqual(Buffer.from(last.data), au3);
  assert.equal(last.keyframe, false);
  assert.equal(s.flush(), null);
});

test("AnnexBSplitter: byte-at-a-time input gives the same AUs; junk before first AUD dropped", () => {
  const au1 = concatBytes(aud(), nal(0x65, [9, 9, 9]));
  const au2 = concatBytes(aud(), nal(0x41, [7]));
  const stream = Buffer.concat([Buffer.from([0x12, 0x34, 0, 0, 1, 0x41, 0x55]), au1, au2, au1]);
  const s = new AnnexBSplitter();
  const out = [];
  for (const b of stream) out.push(...s.push(Buffer.from([b])));
  const tail = s.flush();
  const aus = [...out, tail];
  assert.equal(aus.length, 3);
  // The 4-byte start code's leading zero lands at the end of the junk / previous AU split point.
  assert.deepEqual(Buffer.from(aus[0].data), au1);
  assert.deepEqual(Buffer.from(aus[1].data), au2);
  assert.deepEqual(Buffer.from(aus[2].data), au1);
  assert.deepEqual(aus.map((a) => a.keyframe), [true, false, true]);
});

test("PcmCoalescer: emits whole samples once minBytes reached, flush drops a lone odd byte", () => {
  const c = new PcmCoalescer(8);
  assert.equal(c.push(Buffer.from([1, 2, 3])), null);
  const out = c.push(Buffer.from([4, 5, 6, 7, 8, 9]));
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(c.length, 1);
  assert.equal(c.flush(), null);
  c.push(Buffer.from([1, 2, 3]));
  assert.deepEqual([...c.flush()], [1, 2]);
});

test("video/audio messages round-trip through the client parser", () => {
  const au = Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x65, 1]);
  const ts = frameTimestampUs(123456789); // > 2^32 µs
  const v = parseBinaryMessage(new Uint8Array(packVideoMessage(au, true, ts)));
  assert.equal(v.kind, "video");
  assert.equal(v.keyframe, true);
  assert.equal(v.timestampUs, ts);
  assert.deepEqual(Buffer.from(v.data), au);

  const delta = parseBinaryMessage(packVideoMessage(au, false, 33333));
  assert.equal(delta.keyframe, false);
  assert.equal(delta.timestampUs, 33333);

  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-32768, 2);
  pcm.writeInt16LE(0, 4);
  const packed = packAudioMessage(pcm);
  // Copy into a fresh ArrayBuffer like a browser WebSocket would deliver.
  const ab = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.length);
  const a = parseBinaryMessage(ab);
  assert.equal(a.kind, "audio");
  assert.deepEqual([...a.samples], [0.5, -1, 0]);

  assert.equal(parseBinaryMessage(new Uint8Array([7, 1, 2])), null);
  assert.equal(parseBinaryMessage(new Uint8Array([4, 1, 0])), null);
});

test("frame timestamps step by 1e6/30 µs", () => {
  assert.equal(frameTimestampUs(0), 0);
  assert.equal(frameTimestampUs(1), 33333);
  assert.equal(frameTimestampUs(30), 1000000);
  assert.equal(frameTimestampUs(3), 100000);
});

test("pcm16leToFloat32 handles unaligned views", () => {
  const raw = new Uint8Array([2, 0x00, 0x40, 0xff, 0x7f]);
  assert.deepEqual([...pcm16leToFloat32(raw.subarray(1))], [0.5, 32767 / 32768]);
});

test("codec strings: client fallback table matches the server's per-quality params", () => {
  for (const q of [360, 480, 720, 1080]) {
    assert.equal(codecForQuality(q), webCodecsVideoParams(q).codec);
    assert.equal(WC_CODEC_BY_QUALITY[q], webCodecsVideoParams(q).codec);
  }
  assert.equal(codecForQuality(1080), "avc1.42E028");
  assert.equal(webCodecsVideoParams(1080).level, "4.0");
  assert.equal(codecForQuality(720), "avc1.42E01F");
  assert.equal(codecForQuality(999), "avc1.42E01F");
});

test("isWebCodecsSupported needs VideoDecoder and EncodedVideoChunk", () => {
  assert.equal(isWebCodecsSupported(undefined), false);
  assert.equal(isWebCodecsSupported({}), false);
  assert.equal(isWebCodecsSupported({ VideoDecoder() {} }), false);
  assert.equal(isWebCodecsSupported({ VideoDecoder() {}, EncodedVideoChunk() {} }), true);
});

test("buildAtempoChain splits speeds below 0.5", () => {
  assert.deepEqual(buildAtempoChain(1), []);
  assert.deepEqual(buildAtempoChain(1.5), ["atempo=1.5"]);
  assert.deepEqual(buildAtempoChain(0.25), ["atempo=0.5", "atempo=0.5"]);
  assert.deepEqual(buildAtempoChain(2), ["atempo=2"]);
});

test("buildWebCodecsFfmpegArgs: H.264 baseline Annex-B on pipe:1, PCM on pipe:3", () => {
  const args = buildWebCodecsFfmpegArgs({ input: "/v/a.mp4", seek: 12.5, speed: 1.5, quality: 1080 });
  const at = (flag, from = 0) => args[args.indexOf(flag, from) + 1];
  assert.equal(at("-ss"), "12.500");
  assert.equal(at("-i"), "/v/a.mp4");
  assert.equal(at("-c:v"), "libx264");
  assert.equal(at("-profile:v"), "baseline");
  assert.equal(at("-level:v"), "4.0");
  assert.equal(at("-bf"), "0");
  assert.equal(at("-aud"), "1");
  assert.match(at("-vf"), /^setpts=PTS\/1\.5,fps=30:start_time=0,scale=1920:1080:/);
  assert.ok(args.includes("pipe:1"));
  assert.equal(args[args.indexOf("pipe:1") - 1], "h264");
  assert.equal(at("-af"), "atempo=1.5,aresample=44100:async=1000:first_pts=0");
  assert.equal(at("-ac"), "1");
  assert.equal(at("-ar"), "44100");
  assert.equal(args[args.length - 1], "pipe:3");
  assert.equal(args[args.length - 2], "s16le");

  const noAudio = buildWebCodecsFfmpegArgs({ input: "x", hasAudio: false });
  assert.ok(!noAudio.includes("pipe:3"));
  assert.ok(!noAudio.includes("-ss"));
  assert.equal(noAudio[noAudio.indexOf("-level:v") + 1], "3.1");
});

test("selectDueFrame picks the newest due frame; -1 when all are in the future", () => {
  const ts = [0, 33333, 66667, 100000];
  assert.equal(selectDueFrame(ts, -10000, 0), -1);
  assert.equal(selectDueFrame(ts, 0, 0), 0);
  assert.equal(selectDueFrame(ts, 50000, 0), 1);
  assert.equal(selectDueFrame(ts, 50000, 16667), 2);
  assert.equal(selectDueFrame(ts, 5e6, 0), 3);
  assert.equal(selectDueFrame([], 5e6, 0), -1);
});

test("findCatchUpKeyframe / isPresentationBehind", () => {
  const chunks = [
    { timestampUs: 0, keyframe: true },
    { timestampUs: 1e6, keyframe: false },
    { timestampUs: 2e6, keyframe: true },
    { timestampUs: 3e6, keyframe: false },
    { timestampUs: 4e6, keyframe: true }
  ];
  assert.equal(findCatchUpKeyframe(chunks, 3.5e6), 2);
  assert.equal(findCatchUpKeyframe(chunks, 10e6), 4);
  assert.equal(findCatchUpKeyframe(chunks.slice(1, 2), 10e6), -1);
  assert.equal(isPresentationBehind(5e6, 2e6), true);
  assert.equal(isPresentationBehind(4e6, 2e6), false);
  assert.equal(isPresentationBehind(4e6, -1), false);
});

test("bufferedAheadSec and mediaTimeFromStream", () => {
  assert.equal(bufferedAheadSec({ clockSec: 1, videoEndSec: 3, audioEndSec: 1.5, hasAudio: true }), 0.5);
  assert.equal(bufferedAheadSec({ clockSec: 1, videoEndSec: 3, audioEndSec: 1.5, hasAudio: false }), 2);
  assert.equal(bufferedAheadSec({ clockSec: 5, videoEndSec: 3, audioEndSec: 9, hasAudio: true }), 0);
  assert.equal(mediaTimeFromStream(10, 2, 1.5), 13);
  assert.equal(mediaTimeFromStream(10, -1, 1), 10);
  assert.equal(mediaTimeFromStream(10, 100, 1, 50), 50);
});
