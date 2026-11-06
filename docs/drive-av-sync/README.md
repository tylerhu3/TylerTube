# Drive player A/V drift: investigation notes (attempt 1, 2026-11-05)

**Status: unsolved.** Attempt 1 did not fix the drift the user sees. These notes record what
was tried, what was measured, what is ruled out and what to try next.

## Symptom (as reported)

- In Drive mode, audio and video go out of sync after about **a minute** of playback.
- It happens on **all videos**, in a **Mac browser on `localhost:8080`** (production: Nginx → Drive server :5180)
  and in the **Tesla browser** (car speakers).
- The **Standard player is in sync** on the same videos.
- The stats panel's "A/V Drift" / "Playing (Δ …)" readout stays near 0 ms while it is visibly off.
  So the player's own drift measurement does not see the drift.
- The Mac browser was not confirmed. All of attempt 1's measurements were done in Chromium (the
  Claude desktop app's built-in browser pane). Nothing was measured in Safari or on the Tesla.

## What attempt 1 changed (`attempt-1.patch`, uncommitted when written)

**Server (`server/drive-ws.js`)**
- `buildDriveFfmpegArgs()`:
  - Video: `fps=fps=30:start_time=0`.
  - Audio: `aresample=44100:async=1000:first_pts=0`, applied before `atempo`. The old version was
    `async=1` and had no `first_pts`.
  - `buildAtempoChain()` handles speeds below 0.5.

**Client (`src/components/drive/jsmpegPatch.js`, guard flag `__tylertubePatchedV4`)**
- Corrected the heard-audio clock: `computeAudiblePts` adds one MP2 frame (1152 samples), because
  `decodedTime` is the frame start but the queued time runs to the frame end.
- When video is more than 120 ms behind, it decodes frames without drawing them (a no-op
  destination is swapped in), within a 10/14 ms per-tick budget.
- Removed the old ">3 s behind → free-run" branch.
- Publishes `player.__avDrift`.

**Client (`DriveVideoPlayer.jsx`, `driveUtils.js`)**
- A 500 ms drift monitor (`evaluateAvSync`):
  - soft correction above 120 ms;
  - hard resync (a `seek` to the heard position) at 1 s or more, or for persistent drift;
  - cooldown and back-off so it can't loop.
- Re-anchors on pause/resume, seek, speed, quality, buffering and visibility changes.
- "Resync A/V now" chip in the settings menu.
- Tests in `tests/drive-sync.test.js`.

**Result:** the user still sees drift after about a minute.

## Measurements (all in-sync, so these are ruled out)

| What | How | Result |
|---|---|---|
| Server transcode, synthetic marker clip (flash + beep every 5 s), 1×/1.5×/2×, with seeks | `buildDriveFfmpegArgs` → TS, then ffprobe `signalstats` + `astats` | flash − beep 25–79 ms, constant over 4 min |
| Server transcode, **real episode** ("Steel Ball Run Ep2") vs the source MP4 | `tools/capture.mjs` + `tools/compare.mjs` (audio cross-correlation + video frame-signature match against the source, read via Nginx `/videos/…`) | video − audio = −11 ms, constant over 3 min |
| Real stream packet structure | `tools/pes.mjs` | exactly 1 MP2 frame per audio PES, 1 picture per video PES, perfectly regular PTS, so the patch's PTS-queue bookkeeping is valid |
| Bare patched JSMpeg player, marker clip, 10 min (Chromium) | hooked `video.destination.render` (flash) and `audioOut.play` (beep onset → `ctx.getOutputTimestamp()`) | 120 markers, −85…+38 ms, no growth. The user watched this and confirmed it stayed in sync |
| Full app Drive player, marker clip (WebSocket URL rewritten in the page to a test server), 3 min with pause/resume and seeks | same hooks | −14…+41 ms, no growth |
| Full app, real episode, short windows | `player.__avDrift` | ±16 ms, but this uses the player's own clock (see the symptom section) |

**Conclusion so far:** neither the transcode nor the JSMpeg patch plus app logic drifts in
Chromium on this Mac, on synthetic or real content. The drift the user sees comes from something
these tests don't cover.

## Unexplored leads (next attempt)

1. **Measure in the user's actual browser.** Find out which Mac browser (Safari?) and test there.
   For Chrome, use Claude in Chrome to run the speaker-level marker measurement in the user's own
   Chrome. Safari's WebAudio differs: no `outputLatency`, different scheduling and resampling of
   44.1 kHz buffers in a 48 kHz context.
2. **Test on the Tesla itself.** It has slow hardware and car audio. Watch "Stats for nerds"
   (fps, frames skipped, A/V Auto-Sync line, Audio Queue).
3. **Run a marker test on real content in the browser.** Ground truth was only measured with a
   synthetic clip in the browser. Real content has much higher bitrate, decode load and buffer
   growth (the server sends at ~1.6× real time; Buffer Health reached 110 s and the patched
   `BitBuffer` never evicts, it only grows). Option: overlay or replace markers in a real episode
   (e.g. ffmpeg-mix a beep and a white frame every 5 s) and serve it from a test dir.
4. **Check the user's persisted settings** (`tylertube_*` localStorage: sync offset, buffer
   target, quality, speed). They were not checked.
5. **Watch for longer than 10 minutes,** and include backgrounding, screen-off and other
   interruptions.
6. **Pausing drops queued audio.** `resetEnqueuedTime()` on pause throws away up to ~0.45 s of
   scheduled audio. This is pre-existing and was not changed.
7. **Architectural alternatives** if patching JSMpeg's two independent clocks can't be made
   reliable:
   - Play audio through a native `<audio>` element or a single `AudioContext` timeline, and slave
     the canvas video to that clock. First check whether the Tesla allows `<audio>` while driving.
   - WebCodecs (`VideoDecoder`/`AudioDecoder`) with H.264/AAC over the WebSocket, presented
     against the `AudioContext` clock.

## How to reproduce the measurements

- **Marker clip** (needs no `drawtext`; this ffmpeg build lacks it):
  ```bash
  ffmpeg -f lavfi -i "color=c=black:s=1280x720:r=24000/1001:d=600,geq=lum='if(lt(mod(T\,5)\,0.08)\,235\,16)':cb=128:cr=128" \
         -f lavfi -i "aevalsrc='if(lt(mod(t\,5)\,0.08)\,0.8*sin(2*PI*1000*t)\,0)':s=48000:d=600" \
         -c:v libx264 -preset ultrafast -g 48 -c:a aac -b:a 160k -shortest sync10.mp4
  ```
- **Test Drive server on another videos dir** (leaves `public/videos` untouched):
  ```bash
  node -e 'import("./server/standalone.js").then(m=>m.startDriveServer({port:5199,videosDir:process.argv[1]}))' /path/to/dir
  ```
- **Run the app player against it:** in the page, wrap `window.WebSocket` so URLs containing
  `/ws/mpeg1` point at `ws://127.0.0.1:5199/ws/mpeg1?file=sync10.mp4&…`, then switch to Drive mode.
- **In-browser ground truth** (wrap the player via `JSMpeg.Player.prototype.updateForStreaming`):
  - Flash: when `video.destination.render(y, …)` gets a bright Y plane, record `performance.now()`.
  - Beep: when `audioOut.play(sr, left, right)` gets the first sample above 0.1, compute its play
    time as `startTime + idx/sr`, then map that to performance time with
    `ctx.getOutputTimestamp()`.
  - The decoded MP2 amplitude is about 0.29, so use a 0.1 threshold, not 0.3.
- **Real content vs source:**
  ```bash
  node tools/capture.mjs "ws://127.0.0.1:5180/ws/mpeg1?file=<url-encoded /videos/... path>&quality=720&speed=1&seek=0&loop=0" real.ts 125
  ```
  ```bash
  node tools/compare.mjs "http://localhost:8080/videos/<path>" real.ts 190
  ```
  ```bash
  node tools/pes.mjs real.ts
  ```

## Gotchas hit during attempt 1

- A **hidden browser pane** throttles requestAnimationFrame to about 1 Hz, but
  `document.visibilityState` still says `visible`. Measurements taken while it is hidden are
  garbage.
- **Vite dev servers** don't reload `server/` code. A `:5173` started before a `drive-ws.js` edit
  still runs the old ffmpeg pipeline.
- The LaunchAgent `com.tylertube.drive` was not installed before this session. It was installed
  per the README on 2026-11-05.
- **Drive player controls auto-hide.** A click where the gear used to be lands on the canvas and
  toggles pause.
