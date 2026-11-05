// Runtime patches for the global window.JSMpeg (loaded from /jsmpeg.min.js in index.html).
// ensureJSMpegPatched() is idempotent (guarded by JSMpeg.__tylertubePatchedV3).
export function ensureJSMpegPatched() {
  const JSMpeg = typeof window !== "undefined" ? window.JSMpeg : null;
  if (!JSMpeg) return null;
  if (JSMpeg.__tylertubePatchedV3) return JSMpeg;

  // 1. BitBuffer patch: never discard unread bytes on EVICT overflow; expand buffer instead
  if (JSMpeg.BitBuffer) {
    JSMpeg.BitBuffer.prototype.evict = function (neededBytes) {
      const readBytes = this.index >> 3;
      if (readBytes > 0) {
        if (this.bytes.copyWithin) {
          this.bytes.copyWithin(0, readBytes, this.byteLength);
        } else {
          this.bytes.set(this.bytes.subarray(readBytes, this.byteLength), 0);
        }
        this.byteLength -= readBytes;
        this.index -= readBytes << 3;
      }
    };

    JSMpeg.BitBuffer.prototype.write = function (buffers) {
      const isArray = typeof buffers[0] === "object";
      let totalBytes = 0;
      if (isArray) {
        for (let i = 0; i < buffers.length; i++) totalBytes += buffers[i].byteLength;
      } else {
        totalBytes = buffers.byteLength;
      }
      const available = this.bytes.length - this.byteLength;
      if (totalBytes > available) {
        if (this.mode === JSMpeg.BitBuffer.MODE.EXPAND) {
          const newSize = Math.max(2 * this.bytes.length, this.bytes.length + totalBytes);
          this.resize(newSize);
        } else {
          this.evict(totalBytes);
          // If still insufficient space after evicting read bytes, expand rather than wiping unread data
          if (totalBytes > this.bytes.length - this.byteLength) {
            const newSize = Math.max(
              this.bytes.length * 2,
              this.byteLength + totalBytes + 1024 * 1024
            );
            this.resize(newSize);
          }
        }
      }
      if (isArray) {
        for (let i = 0; i < buffers.length; i++) this.appendSingleBuffer(buffers[i]);
      } else {
        this.appendSingleBuffer(buffers);
      }
      return totalBytes;
    };
  }

  // 2. Safe WebSocket destroy + JSON control message handling + paused seek preview
  if (JSMpeg.Source && JSMpeg.Source.WebSocket) {
    JSMpeg.Source.WebSocket.prototype.destroy = function () {
      clearTimeout(this.reconnectTimeoutId);
      this.shouldAttemptReconnect = false;
      if (this.socket) {
        try {
          this.socket.onclose = null;
          this.socket.onmessage = null;
          this.socket.onerror = null;
          this.socket.onopen = null;
          this.socket.close();
        } catch {
          // Ignore close errors
        }
        this.socket = null;
      }
    };

    const origOnMessage = JSMpeg.Source.WebSocket.prototype.onMessage;
    JSMpeg.Source.WebSocket.prototype.onMessage = function (ev) {
      if (!ev) return;
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (this.options && this.options.onControlMessage) {
            this.options.onControlMessage(msg);
          }
        } catch {
          // Ignore invalid JSON
        }
        return;
      }
      const res = origOnMessage.call(this, ev);
      const p = this.options && this.options.__player;
      if (p && p.__isPaused && p.needsPausedPreview && p.video) {
        if (p.video.decode()) {
          p.needsPausedPreview = false;
        }
      }
      return res;
    };
  }

  // 3. Track exact MPEG-TS 90kHz PTS per frame in Video & Audio decoders (never purge PTS queue on false)
  function patchDecoderPts(DecoderClass) {
    if (!DecoderClass || !DecoderClass.prototype || DecoderClass.__ptsPatched) {
      return;
    }
    const origWrite = DecoderClass.prototype.write;
    const origDecode = DecoderClass.prototype.decode;

    DecoderClass.prototype.write = function (pts, buffers) {
      if (!this.ptsQueue) {
        this.ptsQueue = [];
        this.lastWritePts = -1;
      }
      if (typeof pts === "number" && pts > 0 && pts !== this.lastWritePts) {
        this.lastWritePts = pts;
        this.ptsQueue.push(pts);
        if (this.__onPtsObserved) {
          this.__onPtsObserved(pts);
        }
      }
      return origWrite.call(this, pts, buffers);
    };

    DecoderClass.prototype.decode = function () {
      const ok = origDecode.call(this);
      if (ok) {
        if (this.ptsQueue && this.ptsQueue.length > 0) {
          this.decodedTime = this.ptsQueue.shift();
        }
      }
      return ok;
    };

    DecoderClass.__ptsPatched = true;
  }

  if (JSMpeg.Decoder) {
    patchDecoderPts(JSMpeg.Decoder.MPEG1Video);
    patchDecoderPts(JSMpeg.Decoder.MPEG1VideoWASM);
    patchDecoderPts(JSMpeg.Decoder.MP2Audio);
    patchDecoderPts(JSMpeg.Decoder.MP2AudioWASM);
  }

  // 4. Hardware-clock WebAudio output with suspended-context protection & clean resync
  if (JSMpeg.AudioOutput && JSMpeg.AudioOutput.WebAudio) {
    const WA = JSMpeg.AudioOutput.WebAudio;
    WA.prototype.play = function (sampleRate, left, right) {
      if (!this.enabled || this.__isPaused) return;
      if (this.context && this.context.state !== "running") {
        if (this.context.resume) {
          this.context.resume().catch(() => {});
        }
        const wNow = JSMpeg.Now();
        if (this.wallclockStartTime < wNow) this.wallclockStartTime = wNow;
        this.wallclockStartTime += left.length / sampleRate;
        return;
      }
      this.unlocked = true;
      this.gain.gain.value = this.__isMuted ? 0 : this.volume;
      const buffer = this.context.createBuffer(2, left.length, sampleRate);
      buffer.getChannelData(0).set(left);
      buffer.getChannelData(1).set(right);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.destination);
      const now = this.context.currentTime;
      const duration = buffer.duration;
      if (this.startTime < now) {
        this.startTime = now + 0.04;
        this.wallclockStartTime = JSMpeg.Now() + 0.04;
      }
      source.start(this.startTime);
      this.startTime += duration;
      this.wallclockStartTime += duration;
    };

    WA.prototype.getEnqueuedTime = function () {
      if (this.context && this.context.state === "running") {
        const hwLatency =
          (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
        return (
          Math.max(this.startTime - this.context.currentTime, 0) + hwLatency
        );
      }
      return Math.max(this.wallclockStartTime - JSMpeg.Now(), 0);
    };

    WA.prototype.resetEnqueuedTime = function () {
      if (this.context) {
        try {
          this.gain.disconnect();
          this.gain = this.context.createGain();
          this.gain.gain.value = this.__isMuted ? 0 : this.volume;
          this.destination = this.gain;
          this.gain.connect(this.context.destination);
        } catch {
          // Ignore gain reconnect errors
        }
        this.startTime = this.context.currentTime + 0.04;
      }
      this.wallclockStartTime = JSMpeg.Now() + 0.04;
    };
  }

  // 5. Intelligent Jitter Buffer + Smooth A/V Sync + Underrun Detection
  if (JSMpeg.Player) {
    const origStartLoading = JSMpeg.Player.prototype.startLoading;
    JSMpeg.Player.prototype.startLoading = function () {
      if (this.__destroyed) return;
      const res = origStartLoading.call(this);
      if (this.source && this.source.options) {
        this.source.options.__player = this;
      }
      if (this.video && this.__onPtsObserved) {
        this.video.__onPtsObserved = this.__onPtsObserved;
      }
      if (this.audio && this.__onPtsObserved) {
        this.audio.__onPtsObserved = this.__onPtsObserved;
      }
      if (this.audioOut) {
        this.audioOut.__isPaused = Boolean(this.__isPaused || this.__isBuffering);
        this.audioOut.__isMuted = Boolean(this.__isMuted);
      }
      return res;
    };

    JSMpeg.Player.prototype.destroy = function () {
      this.__destroyed = true;
      this.pause();
      if (this.source) {
        try {
          this.source.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.video) {
        try {
          this.video.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.renderer) {
        try {
          this.renderer.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.audio) {
        try {
          this.audio.destroy();
        } catch {
          // Ignore
        }
      }
      if (this.audioOut) {
        try {
          this.audioOut.destroy();
        } catch {
          // Ignore
        }
      }
    };

    JSMpeg.Player.prototype.updateForStreaming = function () {
      if (this.__destroyed) return;

      // 1. Calculate how much decoded/queued media is buffered ahead
      const vLatest = this.video ? this.video.lastWritePts : -1;
      const aLatest = this.audio ? this.audio.lastWritePts : -1;
      const latestWritePts = Math.max(vLatest, aLatest);

      const vDecoded = this.video ? this.video.decodedTime : 0;
      const aDecoded = this.audio ? this.audio.decodedTime : 0;
      const currentPts = aDecoded > 0 ? aDecoded : vDecoded;

      let bufferedAhead = 0;
      if (latestWritePts > 0 && currentPts > 0 && latestWritePts >= currentPts) {
        bufferedAhead = latestWritePts - currentPts;
      }
      this.__bufferedAhead = bufferedAhead;

      if (this.__onBufferStats) {
        this.__onBufferStats(bufferedAhead, latestWritePts);
      }

      // 2. Check if user paused
      if (this.__isPaused) {
        if (this.needsPausedPreview && this.video) {
          if (this.video.decode()) {
            this.needsPausedPreview = false;
          }
        }
        return;
      }

      const now = JSMpeg.Now();
      const targetBuffer = this.__bufferingTarget || 2.0;
      const dur = this.__mediaDuration || 0;
      const curMedia = this.__currentMediaTime || 0;
      const isNearEnd = dur > 0 && curMedia >= dur - 1.2;
      const effectiveTarget = isNearEnd ? Math.max(0.3, dur - curMedia) : targetBuffer;

      // 3. Handle Buffering State (initial connect, seek, or network starvation)
      if (this.__isBuffering) {
        if (this.needsPausedPreview && this.video) {
          if (this.video.decode()) {
            this.needsPausedPreview = false;
          }
        }

        const waitElapsed = this.__bufferingStartTime ? Date.now() - this.__bufferingStartTime : 0;
        const reachedTarget = bufferedAhead >= effectiveTarget;
        const timedOut = waitElapsed >= 3000 && (bufferedAhead >= 0.4 || isNearEnd);

        if (reachedTarget || timedOut) {
          this.__isBuffering = false;
          if (this.audioOut) {
            this.audioOut.__isPaused = false;
            this.audioOut.resetEnqueuedTime();
          }
          if (this.__onBufferingStateChange) {
            this.__onBufferingStateChange(false, bufferedAhead);
          }
          this.lastVideoWallTime = now;
        } else {
          // Still buffering: hold WebAudio and do not advance video
          if (this.audioOut) {
            this.audioOut.__isPaused = true;
          }
          if (this.__onBufferingStateChange) {
            this.__onBufferingStateChange(true, bufferedAhead);
          }
          return;
        }
      }

      // 4. Decode audio frames into WebAudio with controlled lookahead (~0.45s)
      // This prevents dumping huge amounts into WebAudio while preserving the compressed buffer
      if (this.audio && this.audioOut) {
        const TARGET_AUDIO_AHEAD = 0.45;
        let loopCount = 0;
        while (
          this.audioOut.enqueuedTime < TARGET_AUDIO_AHEAD &&
          loopCount < 16
        ) {
          const decoded = this.audio.decode();
          if (!decoded) break;
          loopCount++;
        }
        this.audioOut.enabled = true;
      }

      if (!this.video) return;

      // 5. Starvation / buffer underrun detection during active playback
      const hasQueuedVideo = Boolean(this.video.ptsQueue && this.video.ptsQueue.length > 0);
      const isStarved =
        !isNearEnd &&
        bufferedAhead < 0.2 &&
        !hasQueuedVideo &&
        (!this.audio || !this.audio.ptsQueue || this.audio.ptsQueue.length === 0);

      if (isStarved) {
        this.__isBuffering = true;
        this.__bufferingStartTime = Date.now();
        this.__bufferingTarget = Math.max(targetBuffer, 2.2);
        if (this.audioOut) {
          this.audioOut.__isPaused = true;
          this.audioOut.resetEnqueuedTime();
        }
        if (this.__onBufferingStateChange) {
          this.__onBufferingStateChange(true, bufferedAhead);
        }
        return;
      }

      // 6. Video decoding synchronized to audible sound coming from speakers
      const hasAudioClock =
        this.audio &&
        this.audio.canPlay &&
        this.audio.decodedTime > 0 &&
        (!this.audioOut ||
          !this.audioOut.context ||
          this.audioOut.context.state === "running");

      if (!hasAudioClock) {
        const frameDur = 1 / (this.video.frameRate || 30);
        if (
          !this.lastVideoWallTime ||
          now - this.lastVideoWallTime >= frameDur - 0.004
        ) {
          if (this.video.decode()) {
            this.lastVideoWallTime = now;
          }
        }
        return;
      }

      const offset = this.syncOffset || 0;
      const audibleAudioPts = Math.max(
        0,
        this.audio.decodedTime - (this.audioOut ? this.audioOut.enqueuedTime : 0)
      );
      const targetAudioPts = audibleAudioPts + offset;

      let videoPts = this.video.decodedTime;
      const frameStep = 1 / (this.video.frameRate || 30);
      let nextVideoPts =
        this.video.ptsQueue && this.video.ptsQueue.length > 0
          ? this.video.ptsQueue[0]
          : videoPts > 0
            ? videoPts + frameStep
            : 0;

      // Initial frame or large PTS discontinuity
      if (videoPts === 0 || Math.abs(nextVideoPts - targetAudioPts) > 3.0) {
        this.video.decode();
        return;
      }

      const tolerance = 0.5 * frameStep;
      const lag = targetAudioPts - nextVideoPts;
      const maxCatchupFrames = lag > 0.25 ? 8 : 3;
      let decodedCount = 0;

      while (
        decodedCount < maxCatchupFrames &&
        nextVideoPts <= targetAudioPts + tolerance
      ) {
        if (!this.video.decode()) break;
        decodedCount++;
        videoPts = this.video.decodedTime;
        nextVideoPts =
          this.video.ptsQueue && this.video.ptsQueue.length > 0
            ? this.video.ptsQueue[0]
            : videoPts + frameStep;
      }
    };
  }

  JSMpeg.__tylertubePatchedV3 = true;
  return JSMpeg;
}

export function flushPlayerBuffers(player) {
  if (!player) return;
  player.__bufferedAhead = 0;
  if (player.demuxer) {
    player.demuxer.leftoverBytes = null;
    player.demuxer.bits = null;
    player.demuxer.pidsToStreamIds = {};
    for (const sid in player.demuxer.pesPacketInfo) {
      const info = player.demuxer.pesPacketInfo[sid];
      if (info) {
        info.currentLength = 0;
        info.totalLength = 0;
        info.pts = 0;
        info.buffers = [];
      }
    }
  }
  if (player.video) {
    if (player.video.decoder) {
      player.video.destroy();
      player.video.decoder = null;
      player.video.hasSequenceHeader = false;
    } else if (player.video.bits) {
      player.video.bits.index = 0;
      player.video.bits.byteLength = 0;
    }
    player.video.ptsQueue = [];
    player.video.lastWritePts = -1;
    player.video.decodedTime = 0;
    player.video.startTime = -1;
  }
  if (player.audio) {
    if (player.audio.decoder) {
      player.audio.destroy();
      player.audio.decoder = null;
    } else if (player.audio.bits) {
      player.audio.bits.index = 0;
      player.audio.bits.byteLength = 0;
    }
    player.audio.ptsQueue = [];
    player.audio.lastWritePts = -1;
    player.audio.decodedTime = 0;
    player.audio.startTime = -1;
  }
  if (player.audioOut) {
    player.audioOut.resetEnqueuedTime();
  }
}
