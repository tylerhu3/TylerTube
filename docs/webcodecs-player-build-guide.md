# Building a WebCodecs Canvas Video Player from Scratch

A self-contained spec for an AI (or human) to rebuild TylerTube's WebCodecs player in a new
project. It covers the server (ffmpeg → WebSocket), the wire protocol, the browser engine
(VideoDecoder → canvas, PCM → AudioContext, audio-clocked A/V sync), the adaptive frame-rate
controller, the UI layer, deployment and the non-obvious pitfalls. Every constant and algorithm
below is the one in production; deviate deliberately. §11 describes how to extend it from
files (VOD) to live streams; that part is a design, not yet implemented.

---

## 1. Why this design

- **No `<video>` element.** Some browsers (Tesla's in-car browser while driving, some kiosk
  modes) pause or block `<video>`. A `<canvas>` fed by `VideoDecoder` plus an `AudioContext` is
  not treated as video, so it keeps playing.
- **Server transcodes on the fly** with ffmpeg into H.264 Constrained Baseline (Annex-B) +
  raw PCM, sent as binary WebSocket frames. The client never parses MP4.
- **The AudioContext is the master clock.** Video frames are presented against audio time, so
  they cannot drift. When audio is locked (no user gesture yet) or absent, a
  `performance.now()` clock stands in and hands over to audio once it runs.
- **Seek / speed / quality / fps changes restart ffmpeg** at a new position; the server tells
  the client with a `reset` message and the client flushes everything.

```
Browser                                            Server (Node)
┌──────────────────────────────────────────┐      ┌───────────────────────────────────┐
│ React UI (controls, seek bar, settings)  │      │ WebSocket /ws/stream?file=…        │
│   │ callbacks ▲   │ API calls ▼          │      │   ├─ ffprobe: duration, audio?, fps│
│ Engine (plain JS class, no React)        │ ◄─── │   ├─ spawn ffmpeg                  │
│   WebSocket ─ parse ─┬─ video queue      │ bin  │   │    stdout  = H.264 Annex-B     │
│                      │   → VideoDecoder  │      │   │    fd 3    = PCM s16le mono    │
│                      │   → frame queue   │      │   ├─ AnnexBSplitter → AU messages │
│                      │   → canvas (rAF)  │ ───► │   ├─ PcmCoalescer   → audio msgs  │
│                      └─ PCM → AudioBuffer│ JSON │   └─ flow control, SIGSTOP pause  │
│                          → AudioContext  │      └───────────────────────────────────┘
└──────────────────────────────────────────┘
```

Recommended file layout (all pure logic in plain `.js` so `node --test` can import it):

| File | Role |
|---|---|
| `server/stream-ws.js` | WebSocket handler: per-connection state, ffmpeg lifecycle, control messages |
| `server/stream-format.js` | Pure: ffmpeg args, H.264 level/codec, `AnnexBSplitter`, `PcmCoalescer`, packing |
| `server/media-files.js` | Path-traversal-safe file resolver + `ffprobe` helpers |
| `client/protocol.js` | Pure: binary parser, PCM→float, codec fallback table, feature check |
| `client/scheduler.js` | Pure: due-frame selection, catch-up, buffered-ahead math, media time |
| `client/autoFps.js` | Pure: adaptive frame-rate state machine |
| `client/Engine.js` | Imperative engine class (socket, decoder, audio, clock, presentation) |
| `client/Player.jsx` | UI component that owns the engine via a ref |

---

## 2. Wire protocol

One WebSocket per playback session. `binaryType = "arraybuffer"`.

### 2.1 Connection URL

```
ws(s)://<host>/ws/stream?file=<urlencoded path>&quality=720&speed=1&seek=12.34&loop=0&fps=source
```

- `quality`: 360 | 480 | 720 | 1080 (default 720)
- `speed`: clamp to [0.25, 2.0]
- `seek`: start position in **media seconds**; if ≥ duration − 0.5, start at 0
- `fps`: `"source"` or a number (clamped to [5, 60])

### 2.2 Binary frames (server → client), first byte = type

```
Video: [0x04][keyframe u8][timestamp u64 big-endian, µs since stream start][H.264 Annex-B access unit]
Audio: [0x02][PCM s16le, mono, 44100 Hz]
```

- Video header is 10 bytes. Timestamp of frame *n* = `round(n * 1e6 / fps)`.
- Audio carries no timestamp: sample *k* of the stream is at `k / 44100` s. The client counts
  samples received since the last `meta`/`reset`.
- Both timelines start at 0 at each (re)start; ffmpeg is configured so this is exact (§3.2).
- Parse the u64 as `hi * 2**32 + lo` from two `getUint32` calls (BigInt not needed).
- Audio payload starts at byte offset 1 → it is **unaligned**; convert with a `DataView`
  (`getInt16(i*2, true) / 32768`), not `new Int16Array(...)`.

### 2.3 JSON text frames

Server → client:

| type | fields | meaning |
|---|---|---|
| `meta` | `isLive:false, duration, seekTime, speed, quality, loop, transport:"webcodecs", videoCodec, hasAudio, fps, fpsCap, sourceFps, requestedFps` | first message on connect |
| `reset` | same stream fields + `paused` | ffmpeg restarted (after seek/speed/quality/fps or resume-after-end); flush everything |
| `ended` | `duration, loop` | ffmpeg finished cleanly; client may still have seconds buffered |
| `status` | `message` | informational text |
| `error` | `message` | fatal (e.g. file not found) |

Client → server:

| type | fields | server action |
|---|---|---|
| `pause` | – | `SIGSTOP` ffmpeg |
| `resume` | – | `SIGCONT` ffmpeg; if ffmpeg already exited (after `ended`), restart (from 0 if at end) with `reset` |
| `seek` | `time` | clamp to [0, duration−0.1], restart → `reset` |
| `speed` | `speed, currentTime` | restart at `currentTime` with new speed → `reset` |
| `quality` | `quality, currentTime` | restart → `reset` |
| `fps` | `fps ("source"\|number), currentTime` | restart → `reset` |
| `loop` | `loop` | store flag only (looping is client-driven) |

Include `transport:"webcodecs"` in `meta` so the client can detect an outdated server and show
an error instead of feeding garbage to the decoder.

---

## 3. Server

### 3.1 Probing (once per connection, `execFileSync` with 5 s timeout)

- Duration: `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 FILE`
- Has audio: `ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 FILE` (non-empty = yes)
- Frame rate: `ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate -of json FILE`
  - Prefer `avg_frame_rate` (real cadence); `r_frame_rate` is a timebase guess (e.g. 60 for VFR 30).
  - Parse `"30000/1001"` → 29.97; accept 1..240, else 0 = unknown.

**File resolution must be path-traversal safe**: decode segments, `path.resolve(videosDir, ...)`,
and require `resolved.startsWith(videosDir + path.sep)` and `isFile()`.

### 3.2 ffmpeg command

Video on stdout (`pipe:1`), audio on fd 3 (`pipe:3`) — spawn with
`stdio: ["ignore", "pipe", "pipe", "pipe"]` (drop the 4th when there's no audio).

```
ffmpeg
  [-ss <seek.toFixed(3)>]                 # input seek (fast, keyframe-accurate is fine: we re-encode)
  -readrate <clamp(speed*1.5, 1.3, 2.5)>  # read a bit faster than real time…
  -readrate_initial_burst 10.0            # …after a 10 s burst for fast startup
  -fflags +genpts
  -i <file>

  # video output
  -map 0:v:0 -an -sn
  -vf "[setpts=PTS/<speed>,]fps=<fpsArg>:start_time=0,scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p"
  -c:v libx264 -profile:v baseline -level:v <level> -preset veryfast -tune zerolatency
  -bf 0 -g <round(fps*2)>                 # no B-frames; keyframe every 2 s
  -aud 1                                  # emit Access Unit Delimiters (the splitter needs them)
  -b:v <kbps>k -maxrate <kbps>k -bufsize <2*kbps>k
  -flush_packets 1 -f h264 pipe:1

  # audio output (only if the file has audio)
  -map 0:a:0 -vn -sn
  -af "[atempo chain,]aresample=44100:async=1000:first_pts=0"
  -c:a pcm_s16le -ac 1 -ar 44100 -flush_packets 1 -f s16le pipe:3
```

Key points:
- `fps=…:start_time=0` and `aresample=…:first_pts=0` make both outputs start at stream time 0,
  so the client can place frame n at n/fps and sample k at k/44100 on **one** timeline.
- Speed is applied by ffmpeg (`setpts` before `fps`, `atempo` for audio). Stream time is
  *output* time; media time = `seekBase + streamTime * speed`.
- `atempo` accepts 0.5..100 per instance: for speed < 0.5 chain `atempo=0.5` repeatedly.
  Skip both filters when |speed−1| ≤ 0.01.
- NTSC fps arg: if `fps*1001` is within 0.05 of a multiple of 1000, emit `"N/1001"` (e.g.
  `30000/1001`) so ffmpeg's frame instants match your `n*1e6/fps` timestamps exactly.

Quality table (bitrates are for 30 fps):

| q | W×H | kbps |
|---|---|---|
| 360 | 640×360 | 700 |
| 480 | 854×480 | 1100 |
| 720 | 1280×720 | 2200 |
| 1080 | 1920×1080 | 4500 |

- Bitrate scaling with fps: `round(base * (fps/30) ** 0.6)` (fps clamped ≥ 5).
- H.264 level from frame size *and* macroblock rate (Table A-1). MBs = ceil(W/16)·ceil(H/16),
  MB/s = MBs·fps. First level with MBs ≤ MaxFS and MB/s ≤ MaxMBPS:

  | level | idc | MaxFS | MaxMBPS |
  |---|---|---|---|
  | 3.1 | 0x1F | 3600 | 108000 |
  | 3.2 | 0x20 | 5120 | 216000 |
  | 4.0 | 0x28 | 8192 | 245760 |
  | 4.2 | 0x2A | 8704 | 522240 |
  | 5.1 | 0x33 | 36864 | 983040 |

  Codec string: `avc1.42E0` + idc as 2 uppercase hex digits (e.g. 720p30 → `avc1.42E01F`,
  1080p30 → `avc1.42E028`, 720p60 → `avc1.42E020`, 1080p60 → `avc1.42E02A`). Send it in
  `meta.videoCodec`; keep a client fallback table that matches (and test that they agree).

Output fps resolution (`requested` = "source" | number):
```
content = sourceFps > 0 ? sourceFps * speed : 0
cap     = content > 0 ? clamp(content, 5, 60) : 30
fps     = requested == "source" ? cap : min(requested, content > 0 ? cap : 60)
fps     = max(5, fps)
```
Never encode above the source content rate (duplicated frames only cost bandwidth).

### 3.3 Annex-B access-unit splitter (stdout → AUs)

ffmpeg's stdout chunks are arbitrary byte slices. Split on AUD NALs (type 9):

- Scan for start codes `00 00 01`; NAL type = `byte[i+3] & 0x1F`. Fast skip: if `buf[i+2] > 1`,
  advance by 3.
- On type 9: the cut point is `i-1` if the byte before is `00` (4-byte start code), else `i`.
  If an AU is open, emit `buf[cutBase..cut]` with `keyframe = sawIdr`. Start a new AU.
- On type 5 (IDR slice): `sawIdr = true`.
- Keep the unfinished tail in `pending`; resume scanning ≤3 bytes before where you stopped so
  a start code split across chunks is found.
- Bytes before the very first AUD are dropped (keep only a 4-byte tail until one is seen).
- `flush()` on ffmpeg exit returns the trailing AU (if > 4 bytes and an AUD opened it).
- Test it with byte-at-a-time input — must produce identical AUs.

### 3.4 PCM coalescer

Accumulate fd-3 chunks; once ≥ 4096 bytes, emit the largest even-length prefix (whole s16
samples), keep the odd byte. `flush()` emits the rest (dropping a lone odd byte).

### 3.5 Per-connection loop

```
on connect:
  resolve file (else send error + close); probe duration/audio/fps
  send meta; start stream (not a reset)

startStream(isReset):
  kill previous ffmpeg (remove listeners first, then SIGKILL)
  if isReset: send reset {seekTime, duration, speed, quality, paused, loop, ...streamInfo}
  spawn ffmpeg; frameIndex = 0
  stdout data → splitter.push → for each AU: send packVideo(au, key, ts(frameIndex++, fps))
  fd3 data    → coalescer.push → send packAudio
  on close(code 0): flush splitter + coalescer, send them; currentSeek = duration;
                    isPaused = true; send ended
  on close(other): send status, close socket
```

Guard every callback with `if (wsClosed || activeFfmpeg !== thisFfmpeg) return;` — stale
processes keep emitting for a moment after a restart.

**Flow control** (two independent pauses; pipes paused if either is set):
1. Socket backpressure: after `ws.send`, if `ws.bufferedAmount > 2 MB` → pause pipes;
   resume when < 512 KB (checked in a 50 ms interval).
2. Playback lead: track `playedSec` (wall clock since first AU, excluding paused time). If
   `frameIndex/fps − playedSec > 30 s` → pause pipes; resume when < 25 s.

Pausing the Node readable streams makes ffmpeg block on its pipe write — natural throttling.

**Pause**: `SIGSTOP` the ffmpeg process; **resume**: `SIGCONT`. Seeking while paused: let one
keyframe through (so the client shows a preview frame), then `SIGSTOP` 30 ms after the first
keyframe is sent.

Send binary frames with `{ binary: true, compress: false }` (enable `perMessageDeflate` on the
server only for the JSON). On socket close/error: kill ffmpeg.

**Loop is client-driven**: the client may hold up to 30 s of unplayed media, so the server
always sends `ended` and the client seeks to 0 when it actually reaches the end.

---

## 4. Client engine (plain JS class)

Constructor: `new Engine({ url, canvas, callbacks })`, callbacks:
`onControl(msg)`, `onFrame(streamSec)`, `onBuffering(bool)`, `onPlaybackEnded()`,
`onStatus(text)`, `onError(text)`.

It creates the AudioContext, opens the socket, starts a `requestAnimationFrame` loop and a
50 ms `setInterval` "pump".

### 4.1 Constants

```js
WC_MAX_DECODED_FRAMES = 90    // decoded VideoFrames + decode queue cap (GPU memory!)
WC_START_BUFFER_SEC   = 0.18  // buffered ahead needed to start (first start / after seek)
WC_CATCHUP_SEC        = 2.5   // decode lagging clock by this much → jump to a keyframe
WC_DECODE_AHEAD_SEC   = 2.0   // don't feed the decoder further ahead than this
WC_AUDIO_LEAD_SEC     = 0.05  // schedule first audio this far in the future
WC_AUDIO_HORIZON_SEC  = 1.0   // schedule AudioBufferSources up to 1 s ahead
PUMP_MS = 50; RAF_STALE_MS = 250; AUDIO_GAP_VIDEO_SEC = 3
AUDIO_CLOCK_DECAY = 0.002; AUDIO_CLOCK_MAX_LEAD_SEC = 0.1
rebufferTargetSec default 2 (user options 1 / 2 / 5)
```

### 4.2 Audio setup

```js
const Ctor = window.AudioContext || window.webkitAudioContext;
try { ctx = new Ctor({ sampleRate: 44100 }); } catch { ctx = new Ctor(); }
gain = ctx.createGain(); gain.connect(ctx.destination);
ctx.onstatechange = () => pump();
```
A 44.1 kHz context avoids per-buffer resampling seams. Gain = `muted ? 0 : volume` (volume
may go to 3.0 = 300% boost). The context starts `suspended` until a user gesture: call
`ctx.resume()` from capture-phase `click`/`touchstart`/`keydown` listeners on `document`.

### 4.3 Stream state (reset on every `meta`/`reset`)

```
encoded[]            { timestampUs, keyframe, data }   (received, not yet decoded)
frames[]             VideoFrame, sorted by timestamp    (decoded, not yet shown)
pendingAudio[]       { startSec, samples:Float32Array, durSec, buffer:AudioBuffer|null }
schedIdx             pendingAudio[0..schedIdx) already scheduled
sources:Set          live AudioBufferSourceNodes
audioSamplesReceived, lastReceivedVideoUs, newestDecodedUs, firstKeyUs
needKeyframe=true, serverEnded, playbackEnded, presentedSinceReset, hadFirstStart
awaitingReset        true between sending seek/etc and receiving reset: DROP all media
streamGen            ++ on every restart (invalidates health samples)
```

`startNewStream(msg)`: flush media (stop sources, `close()` all frames, clear queues),
set `hasAudio`, `streamFps`, `frameUs = 1e6/fps`, `codec = msg.videoCodec || fallback`,
`running = false`, `frozenSec = 0`, buffering = !paused, then create a fresh decoder.

### 4.4 Decoder

```js
const gen = ++decoderGen;
decoder = new VideoDecoder({
  output: (f) => onDecodedFrame(f, gen),
  error:  (e) => onDecoderError(e, gen),
});
decoder.configure({ codec, optimizeForLatency: true });   // no description → Annex-B input
decoder.ondequeue = () => feedDecoder();
needKeyframe = true;
```

- **Incoming video**: while `needKeyframe`, drop delta frames (count them). First key clears it
  and records `firstKeyUs`. Push to `encoded`, update `lastReceivedVideoUs`, `feedDecoder()`.
- **feedDecoder()**: while `encoded` non-empty and decoder `configured`:
  stop if `frames.length + decoder.decodeQueueSize >= 90`; stop if the next chunk is more than
  2 s ahead of the clock *and* we already have frames. Else
  `decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }))`.
  When `serverEnded` and `encoded` is empty, call `decoder.flush()` once (otherwise the last
  few frames never come out).
- **onDecodedFrame**: ignore (and `close()`) if `gen` is stale / destroyed / awaitingReset.
  Insert sorted by timestamp. If > 90 frames, `close()` the oldest.
- **onDecoderError**: ignore stale gen. After > 3 errors since the last reset, give up
  (close, null the decoder, `onError("VideoDecoder failed (codec): …")`). Otherwise recreate the
  decoder and drop `encoded` up to the next keyframe.
- **Every VideoFrame must be `close()`d** — drawn, dropped, flushed or on destroy. Leaks stall
  the decoder (it has a small fixed frame pool).

### 4.5 The clock (the heart of A/V sync)

One timeline: **stream time `t`** in seconds, 0 at each meta/reset.

```js
getStreamTime() {
  if (!running) return frozenSec;
  if (clockMode === "audio") return audioClockNow() - outputLatency() - anchorCtx;
  return perfBaseSec + (performance.now() - perfStartMs) / 1000;
}
outputLatency() = ctx.outputLatency || ctx.baseLatency || 0   // "heard" vs "scheduled"
```

`startClock(atSec)`: use the audio clock if `hasAudio && !audioGap && ctx.state === "running"
&& audioEndSec > atSec + 0.02`:
```js
clockMode = "audio"; acOffset = null;
anchorCtx = audioClockNow() + WC_AUDIO_LEAD_SEC - atSec;   // PCM at stream t plays at ctx time anchorCtx + t
```
otherwise `clockMode = "perf"; perfBaseSec = atSec; perfStartMs = performance.now()`.
Then `scheduleAudio()`.

`freezeClock(at)`: `frozenSec = max(0, at); running = false; stopSources()`.

**Smoothed audio clock.** `AudioContext.currentTime` only advances once per audio device
callback (~10 ms macOS, 20–40+ ms Linux/Android). Read raw, frames due mid-step all fire at the
next step → doubled/dropped frames (judder). Interpolate with `performance.now()`, tracking the
upper envelope of `(currentTime − perf)`:

```js
audioClockNow() {
  const raw = ctx.currentTime, perf = performance.now() / 1000, offRaw = raw - perf;
  let off = acOffset;
  if (off === null) off = offRaw;
  else {
    off -= AUDIO_CLOCK_DECAY * Math.max(0, perf - acLastPerf);       // may sink slowly
    if (offRaw > off || off - offRaw > AUDIO_CLOCK_MAX_LEAD_SEC) off = offRaw; // each step re-raises; snap if audio stalled
  }
  acOffset = off; acLastPerf = perf;
  return perf + off;
}
```

**Clock-source handover** (checked every tick while running): re-anchor via
`t = getStreamTime(); freezeClock(t); startClock(t)` when
- audio mode but `ctx.state !== "running"` (interrupted) → falls to perf;
- perf mode and audio now running with > 0.3 s audio ahead (and no audio gap) → goes to audio;
- audio mode and an audio gap was detected → perf.

### 4.6 Audio scheduling

```js
scheduleAudio() {
  if (!running || clockMode !== "audio" || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (i = schedIdx; i < pendingAudio.length; i++) {
    const c = pendingAudio[i], when = anchorCtx + c.startSec;
    if (when > now + WC_AUDIO_HORIZON_SEC) break;
    const earliest = now + 0.005;
    if (when + c.durSec <= earliest) continue;               // already past
    const startAt = Math.max(when, earliest), offset = startAt - when;
    c.buffer ??= makeMonoBuffer(c.samples);                   // createBuffer(1, n, 44100) + copyToChannel
    const src = ctx.createBufferSource(); src.buffer = c.buffer; src.connect(gain);
    src.onended = () => { sources.delete(src); src.disconnect(); };
    src.start(startAt, offset); sources.add(src);
  }
  schedIdx = i;
}
```
Chunks are scheduled back-to-back at exact sample positions → gapless. `stopSources()` stops
and disconnects all and resets `schedIdx = 0` (so a re-anchor reschedules from the clock).
Prune `pendingAudio` entries ending > 0.25 s before the clock (adjust `schedIdx`).

### 4.7 Presentation (rAF + pump)

- `rafLoop`: record `lastRafMs`, `tick(draw=true)`, re-request.
- `pump` (50 ms interval): if rAF is stale (> 250 ms, i.e. background tab / hidden pane),
  `tick(draw=false)` so frames are consumed and the clock/state keep moving; else just
  `updateState()`.

```js
tick(draw) {
  updateState(); if (awaitingReset) return;
  if (!running) {                             // paused/buffering: show first frame after reset as preview
    if (!presentedSinceReset && frames.length) { drawAndClose(frames.shift()); presentedSinceReset = true; }
    return;
  }
  const heard = getStreamTime();
  const clockUs = (heard + syncOffsetSec) * 1e6;      // user A/V sync nudge
  if (newestDecodedUs >= 0 && clockUs - newestDecodedUs > 2.5e6) catchUp(clockUs);
  const idx = selectDueFrame(frames.map(f => f.timestamp), clockUs, frameUs / 2);
  if (idx >= 0) {
    close frames[0..idx) (count as dropped/late); const f = frames[idx]; frames.splice(0, idx + 1);
    if (draw) drawFrame(f);  f.close();
    stats.avOffsetMs = round((f.timestamp/1e6 - heard) * 1000);
    presentedSinceReset = true; onFrame(max(0, heard));
  } else if (!frames.length) onFrame(max(0, heard));
  feedDecoder();
}
```

- `selectDueFrame(ts, clockUs, tol)`: binary search for the **newest** frame with
  `ts ≤ clockUs + tol`; −1 if the oldest is still in the future. Earlier ones are late → drop.
- `drawFrame`: resize canvas to `frame.displayWidth/Height` if different, then
  `ctx2d.drawImage(frame, 0, 0, w, h)`. Get the 2D context with `{ alpha: false }`.
  CSS scales the canvas (`object-fit: contain` style via width/height 100% + aspect handling).
- **catchUp(clockUs)**: find the newest keyframe in `encoded` with timestamp ≤ clockUs. Only if
  it is newer than `newestDecodedUs` (otherwise you reset forever): drop `encoded` before it,
  close all frames, `decoder.reset(); decoder.configure(...)`, set `newestDecodedUs` to that
  keyframe's ts.

### 4.8 Buffering / end-of-stream state machine (`updateState`, every tick and pump)

```
clock = getStreamTime()
videoEnd = lastReceivedVideoUs < 0 ? 0 : (lastReceivedVideoUs + frameUs)/1e6
audioEnd = audioSamplesReceived / 44100

audio-gap detection (hasAudio && !serverEnded):
  enter if videoAhead > 3 + rebufferTarget && audioAhead < 0.1    # source audio shorter / has a hole
  leave if audioAhead > 0.5
gateAudio = hasAudio && !audioGap
ahead = gateAudio ? min(videoAhead, audioAhead) : videoAhead

if running:
  prune audio; clock handover checks (§4.5)
  if !serverEnded:
    starvedAudio = gateAudio && clock >= audioEnd - 0.01
    starvedVideo = no frames && no encoded && clock >= videoEnd
    if starved: underruns++; freezeClock(min(clock, starved end)); startTarget = rebufferTarget; buffering = true
  else if no frames, no encoded, decodeQueueSize == 0, clock >= max(videoEnd, audioEnd) - 0.02:
    freezeClock(end); playbackEnded = true; buffering = false; onPlaybackEnded(); return
  scheduleAudio(); return

if paused: return
if (frames.length || presentedSinceReset) && (ahead >= startTarget || serverEnded):
  at = frozenSec; on the very first start after a reset: at = max(at, firstKeyUs/1e6)
  startTarget = 0.18; buffering = false; startClock(at)
else buffering = true
```

Start threshold is 0.18 s for a fast start; after an underrun the target becomes the user's
rebuffer target (default 2 s) to avoid stutter loops.

### 4.9 Public API

```js
send(json)                         // false if socket not open
sendExpectingReset(payload)        // seek/speed/quality/fps:
  needResume = serverEnded && !paused
  send(payload); if (needResume) send({type:"resume"})
  awaitingReset = true; streamGen++; freezeClock(0); flushMedia(); serverEnded = playbackEnded = false
  buffering = !paused
setPaused(p)                       // send pause/resume UNLESS serverEnded (no ffmpeg; a resume would restart from 0
                                   //   while the client is still playing its buffer); freeze clock on pause;
                                   //   on resume: unlockAudio() + updateState()
setVolume(v, muted); setSyncOffset(sec); setRebufferTarget(sec >= 0.18)
isAudioLocked(); unlockAudio()     // ctx.resume().then(pump)
getStats(); takeHealthSample()     // see §5
destroy()                          // cancel rAF, clear interval, detach + close ws, flush media,
                                   //   close decoder, ctx.onstatechange = null, ctx.close()
```

Media time shown to the user: `min(duration, seekBase + max(0, streamSec) * speed)`, where
`seekBase = msg.seekTime` from the latest meta/reset.

---

## 5. Adaptive frame rate ("Auto")

Optional but valuable on weak devices (car, phones). Setting values: `"auto" | "source" | 60 |
30 | 24` (default 24 in TylerTube; persist in localStorage).

- **Ladder** from `meta.fpsCap`: `[cap, cap/2, cap/4, …]` while ≥ 12 (60→30→15, 24→12,
  59.94→29.97→14.985). Rung 0 is requested as `"source"`.
- **Health sample** once per second from the engine (deltas since the previous sample):
  `presented, late, underruns, catchUps, decodeQueue, aheadSec, arrivalRate
  (Δ videoEnd / Δt), ended`, and `active` = same `streamGen`, not paused/awaitingReset/ended,
  tab visible, rAF fresh, 0.2 < dt < 5, and (running or underruns > 0).
- **Classify**:
  - `skip` if not active.
  - `bad` if underruns > 0 or catchUps > 0 or lateRatio > 0.12 (only when ≥ 8 frames shown)
    or decodeQueue > 12 or (not ended && ahead < 4 s && arrivalRate < 0.9).
  - `good` if lateRatio ≤ 0.03 && decodeQueue ≤ 4 && (ended || ahead ≥ 8 || arrivalRate ≥ 1.15).
  - else `neutral`.
- **Step**: ignore the first 4 active seconds after any restart (warm-up). 3 consecutive bad
  → step down one rung. 30 s cumulative good → step up. If a step up is followed by a step
  down within 90 s, double the up-wait (max 480 s); a step up surviving 90 s restores 30 s.
- Changing rung = send `{type:"fps", fps, currentTime}` via `sendExpectingReset`. Call
  `restartWarmup` on every meta/reset.

Keep it pure (state in, state out) and unit test it.

---

## 6. UI layer (React, but the engine is framework-agnostic)

Rules that matter:
- Create the `<canvas>` imperatively inside a host `<div>` in the engine effect; never let
  React re-render it. One engine per (file, visible) — the effect depends only on
  `[file, isHidden, supported]`.
- Everything callbacks read lives in `useRef` (`seekBaseTimeRef`, `currentMediaTimeRef`,
  `durationRef`, `speedRef`, `qualityRef`, `isPausedRef`, `isEndedRef`, `loopRef`, volume refs,
  callback refs…). State is only for rendering.
- Effect cleanup: report the exact position, `engine.destroy()`, clear the host.
- `onFrame` → compute media time, update display (unless scrubbing), report progress once per
  whole second; `force` save on pause, seek, unmount, end.
- `onPlaybackEnded`: if loop → `seekTo(0)`; else mark ended + paused, `engine.setPaused(true)`,
  show duration, save as completed. Play after end → `setPaused(false)` then `seekTo(0)`.
- Speed/quality change: `seekBase = currentMediaTime` then `sendExpectingReset({...,
  currentTime})`. The `reset` message's `seekTime` is authoritative.
- A 1 s interval: health sample → auto fps; `getStats()` → fps, buffered-ahead, buffered % for
  the seek bar (`(streamTime + receivedAheadVideo)` mapped to media time), status text
  ("Tap anywhere to unmute" while audio locked; "Playing (A/V +3ms)" in audio mode), and a
  "stats for nerds" panel.
- Feature check: `typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function"`;
  otherwise render a message + a "use standard player" fallback.

Controls (YouTube-like): top bar (title, buffering/fps/status), center bezel animation on
play/pause/mute, buffering spinner, ±10 s skip ripples, seek bar (hover time, buffered,
played, mouse + touch drag; seek on release), control bar (play, ±10, mute + volume slider to
300%, time, A/V sync −/+ 0.1 s pill, settings, theater, fullscreen), settings popup (speed
0.5–2, quality, frame rate, buffer 1/2/5 s, loop, stats).

Input:
- Keys: Space/K play-pause, J/L ±10 s, ←/→ ±5 s, ↑/↓ volume ±5%, F fullscreen, 0–9 seek to
  N×10%, Esc exits pseudo-fullscreen. Ignore when focus is in input/textarea/select or with
  Ctrl/Meta/Alt.
- Canvas click: single click toggles play after 220 ms; double click (< 280 ms) on left 30% /
  right 30% / middle = −10 s / +10 s / fullscreen. Touch/pen tap while controls are hidden only
  reveals them (snapshot the hidden state on `pointerdown`, before the reveal handler runs).
- Controls auto-hide after 3 s of no movement while playing.
- Fullscreen: `requestFullscreen`/`webkitRequestFullscreen` on the player box; on rejection or
  absence, fall back to a CSS "pseudo-fullscreen" class (fixed, inset 0, high z-index).

---

## 7. Deployment

- Run the WebSocket server as its own Node process (plain `http.createServer` + `ws`
  `noServer: true`, handle `upgrade` only for your path, `socket.destroy()` others). In dev it can
  attach to Vite's `httpServer` instead (leave other upgrades like HMR alone).
- Reverse proxy (Nginx):
  ```nginx
  location /ws/stream {
      proxy_pass http://127.0.0.1:5180;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "Upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 86400s;
      proxy_send_timeout 86400s;
      proxy_buffering off;
  }
  ```
- Client picks `wss:` when the page is `https:`.
- Requires `ffmpeg` with libx264 and `ffprobe` on the server's PATH (set PATH explicitly for
  launchd/systemd).
- On shutdown terminate all WebSocket clients; each close handler SIGKILLs its ffmpeg.

---

## 8. Pitfalls (each of these was a real bug)

1. **Raw `AudioContext.currentTime` as the video clock** → judder. Use the smoothed clock (§4.5).
2. **Forgetting `outputLatency`** → video ahead of what you hear by 20–200 ms (Bluetooth worse).
3. **Unaligned PCM view** (`Int16Array` at byte offset 1) throws. Use `DataView`.
4. **Not closing VideoFrames** → decoder stops emitting after a handful of frames.
5. **No `decoder.flush()` at end of stream** → last frames never decoded, end never detected.
6. **Stale decoder callbacks** after reset/recreate → frames from the old stream shown. Tag with
   a generation counter.
7. **Media arriving between sending `seek` and receiving `reset`** belongs to the old stream.
   Drop everything while `awaitingReset`.
8. **Catch-up to a keyframe you already restarted from** → infinite reset loop. Only jump forward.
9. **Sending `resume` after `ended`** restarts the server from 0 while the client is still
   playing its 30 s buffer. Don't; and when restarting (seek) after `ended` while playing, send
   `resume` too, because the server considers itself paused.
10. **Audio shorter than video / audio holes** → audio gating stalls playback forever. Detect
    the gap and switch to the perf clock.
11. **Background tabs stop rAF** → clock and queues freeze, decoder backs up. Pump with
    `setInterval` when rAF is stale (no drawing).
12. **B-frames** → out-of-order output and wrong presentation times. Encode with `-bf 0`.
13. **Missing AUDs** → no reliable AU boundaries. `-aud 1` is required for the splitter.
14. **Codec level too low for 60 fps** → `NotSupportedError`. Compute the level from MB rate.
15. **ffmpeg fps filter vs your timestamps drifting at 29.97** → use exact `N/1001` rationals.
16. **Huge memory use** if the server reads as fast as possible → readrate + 30 s lead cap +
    socket backpressure.
17. **AudioContext suspended until a gesture** → start on the perf clock, show "Tap to unmute",
    resume on any click/touch/key, then hand the clock to audio.
18. **Volume > 100%** on a GainNode clips; acceptable for a boost, but clamp to a max (3.0).

---

## 9. Tests to write (`node:test`, no ffmpeg needed)

- AnnexBSplitter: splits on AUD, flags IDR, trailing AU only via `flush()`; byte-at-a-time
  input gives identical AUs; junk before first AUD dropped.
- PcmCoalescer: whole samples once ≥ minBytes; flush drops a lone odd byte.
- Pack (server) ↔ parse (client) round-trip for video and audio; PCM→float on unaligned views.
- Frame timestamps step by `1e6/fps` (NTSC included); `ffmpegFpsArg` integers vs `N/1001`.
- ffmpeg args: baseline, Annex-B on pipe:1, PCM on pipe:3, fps filter, GOP = 2·fps, level,
  scaled bitrate; atempo chain below 0.5.
- Level from MB rate; client fallback codec table agrees with server for 30 and 60 fps.
- `resolveOutputFps` never exceeds source content rate or 60; `pickSourceFps` prefers avg.
- `selectDueFrame`, `findCatchUpKeyframe`, `isPresentationBehind`, `bufferedAheadSec`,
  `mediaTimeFromStream`.
- Auto fps: ladder, classification, warm-up, sustained-bad steps down, isolated bad doesn't,
  sustained good steps up, failed step-up doubles the wait.
- `isWebCodecsSupported` needs both `VideoDecoder` and `EncodedVideoChunk`.

---

## 10. Suggested build order

1. `stream-format.js` + tests (args, splitter, coalescer, pack). Sanity-check by piping ffmpeg
   output through the splitter in a script and counting AUs/keyframes.
2. WebSocket handler with meta + streaming only (no controls). Verify with a tiny client that
   logs message types/sizes.
3. `protocol.js` + `scheduler.js` + tests.
4. Engine, video only on the perf clock: decode → canvas. Then add PCM + audio clock, then
   smoothing and latency compensation. Check A/V offset in a stats overlay (should sit within
   ±1 frame).
5. Pause/resume (SIGSTOP/SIGCONT), seek/speed/quality via reset, flow control, end + loop.
6. Underrun/rebuffer, audio-gap, background-tab pump, decoder error recovery, catch-up.
7. UI: controls, keyboard, touch, fullscreen, settings, stats panel, position saving.
8. Auto frame rate.
9. (Optional) Live sources, §11.

---

## 11. Extending to live streams (design, not yet implemented)

The decode/present half is source-agnostic: ffmpeg ingests HLS (`.m3u8`), RTMP, RTSP, SRT,
UDP/MPEG-TS or a capture device and re-encodes to the same H.264 Baseline + PCM. The wire
format, decoder, audio clock, audio scheduling and presentation code need no changes. What
changes is everything that assumes a finite, seekable, client-paced file.

### 11.1 What already works

- Synthetic timestamps (`frameIndex * 1e6 / fps`) plus the `fps` filter turn messy live PTS
  (jumps, VFR, wraparound) into a clean constant-rate timeline.
- `aresample=async=1000` stretches/pads audio to absorb small source gaps and drift.
- The pipeline is already low-latency: `-tune zerolatency`, `-bf 0`, `optimizeForLatency`,
  0.18 s start buffer. Glass-to-glass under ~2 s is realistic (source latency dominates;
  HLS sources add their own segment latency).
- `meta.isLive` already exists (always `false` today) — use it as the switch.

### 11.2 Server changes

| Concern | VOD behaviour | Live behaviour |
|---|---|---|
| Source selection | `?file=` resolved under the videos dir | `?channel=<id>` mapped to a URL from a **server-side allowlist** (config file). Never pass a client-supplied URL to ffmpeg (SSRF / arbitrary fetch / `file:` and `concat:` protocol abuse). Optionally restrict with `-protocol_whitelist`. |
| Probing | duration, audio, fps | Skip duration (send `duration: 0, isLive: true`). Probe audio/fps with a short timeout (`-analyzeduration`/`-probesize`, or `-rw_timeout`), or configure them per channel. |
| Read pacing | `-readrate` + `-readrate_initial_burst` | **Remove both** — input is already real-time; readrate would add latency. Add input-specific flags as needed: `-fflags nobuffer -flags low_delay`, RTSP `-rtsp_transport tcp`, `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5` for HTTP/HLS. |
| Seek / speed | restart ffmpeg at `currentSeek` | Reject (`seek`, `speed` messages ignored; speed fixed at 1). Quality/fps changes still restart ffmpeg — but from "now", so send a `reset` with `seekTime` = elapsed live time (see 11.4). |
| Lead cap (30 s / 25 s) | throttles the server | Never reached; keep socket backpressure (2 MB / 512 KB). If backpressure persists on live, **drop** (skip AUs until the next keyframe) rather than pause pipes, or ffmpeg's input buffer grows unbounded and the source may disconnect. |
| Pause | `SIGSTOP` ffmpeg | **Don't stop ffmpeg** (RTSP/SRT/RTMP sessions time out; buffers balloon). Options: (a) keep streaming and let the client discard; (b) kill ffmpeg on pause and restart on resume with a `reset` (simplest, jumps to live edge). Prefer (b) for long pauses, (a) for short ones. |
| ffmpeg exit | code 0 → `ended` | Any exit = feed dropped: send `status` ("Reconnecting…"), restart with exponential backoff (1 s → 30 s cap), send `reset` when the new process produces its first keyframe. Only send `ended` if the channel is known to be finite (e.g. a broadcast that ended). |
| Fan-out (optional) | one ffmpeg per viewer | For many viewers of one channel, run one ffmpeg per (channel, quality, fps) and broadcast AUs to subscribers. A late joiner must start at a keyframe: cache the latest GOP (from last IDR) and send it first, with timestamps rebased to that viewer's stream time 0, plus matching PCM. |

### 11.3 Client changes

- **UI:** when `meta.isLive`: hide the seek bar and time-remaining, show a red "LIVE" badge
  (grey when behind the live edge, click to jump to live = request a restart), disable
  0–9 / J / L / arrow seeking, speed menu and loop. Don't save watch progress.
- **Reconnect:** on WebSocket close (not destroyed), reconnect with backoff and show
  "Reconnecting…"; the new `meta` resets the engine as usual.
- **End handling:** `ended` on live means "feed stopped", not "video finished": show a
  message, don't mark anything completed.
- **Pause:** keep the engine's local pause (freeze clock). On resume after more than a few
  seconds, jump to the live edge (send `{type:"resume"}`/a restart and handle the `reset`)
  instead of playing stale buffered media.
- **Auto frame rate:** its "good" verdict needs `ahead ≥ 8 s` or `arrivalRate ≥ 1.15`, which a
  live stream (arrival ≈ 1.0×, small buffer by design) never satisfies, so it would only ever
  step down. For live: judge on late-frame ratio, decode queue and underruns only, and treat
  `arrivalRate < 0.9` as a source/network problem (lowering fps won't fix it unless bandwidth
  is the bottleneck — consider stepping *quality* instead).

### 11.4 Clock drift (the one genuinely new problem)

With a file, the client pulls media at its own pace. With live, the **source clock** produces
media and the **listener's audio device clock** consumes it; they differ by tens of ppm
(e.g. 50 ppm ≈ 4.3 s/day). Uncorrected, the buffer slowly grows (latency creeps up) or drains
(periodic underruns, each one adding the rebuffer target to latency).

Control loop (run in `updateState`, e.g. every 1 s):

```
target   = liveTargetSec            // e.g. 1.0 (user options 0.5 / 1 / 3)
ahead    = bufferedAheadSec          // already computed every tick
error    = ahead - target
smoothed = smoothed + 0.1 * (error - smoothed)     // EMA, ignore single bursts

if smoothed >  2.0 s : hard skip — drop encoded/decoded media up to the newest keyframe at
                       or before (clock + ahead - target) and re-anchor the clock there
                       (same mechanics as catchUp(); drop pendingAudio accordingly)
elif |smoothed| > 0.1 s : soft correct — rate = 1 + clamp(smoothed * 0.02, -0.01, +0.01)
else                     : rate = 1
```

Applying a playback rate on the audio clock:
- Set `src.playbackRate.value = rate` on every scheduled `AudioBufferSourceNode`; a chunk
  then lasts `durSec / rate` in context time. The clock mapping becomes piecewise:
  `streamTime = segStartStream + (ctxNow - segStartCtx) * rate`. On every rate change,
  re-anchor exactly like a clock-source handover (`t = getStreamTime(); freezeClock(t);
  startClock(t)` with the new rate) so scheduled chunks and video stay on one timeline.
- Keep `|rate − 1| ≤ 1 %`: pitch shift is inaudible at that size. (For larger corrections
  you'd need a time-stretch, which this design avoids.)
- Video needs nothing special: it is presented against `getStreamTime()`, so it follows.
- On the perf clock (audio locked/absent), apply `rate` to the
  `(performance.now() - perfStartMs)` term instead.

Also on live: the existing underrun → rebuffer path still applies, but after an underrun use
`liveTargetSec` (not the VOD 2 s rebuffer target) as the restart threshold, or each underrun
permanently adds ~2 s of latency until the drift loop removes it.

### 11.5 Protocol additions

- `meta`/`reset`: `isLive: true`, `duration: 0`, optional `channel`, `liveStartedAt`
  (server wall-clock ms of stream time 0, so the client can show "N s behind live" as
  `now − liveStartedAt − streamTime`).
- Server → client `status` messages for `Reconnecting…` / `Source offline`.
- Client → server: `{type:"golive"}` (restart at the live edge; server replies `reset`).
  Server ignores `seek`, `speed`, `loop` on live channels.

### 11.6 Tests to add

- Channel allowlist: unknown id rejected; client URL never reaches ffmpeg args.
- Live ffmpeg args: no `-readrate*`, reconnect flags present for HTTP inputs, `-ss` absent.
- Drift controller (pure function: smoothed error → rate / hard-skip decision): deadband,
  clamping, hard-skip threshold, EMA ignores a single burst.
- Piecewise clock mapping: re-anchoring at a rate change keeps `getStreamTime()` continuous.
- Late-joiner GOP cache (if fan-out): first message is a keyframe; timestamps start at 0.
