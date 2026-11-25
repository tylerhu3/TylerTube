import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractYouTubeVideoId,
  isYouTubeTarget,
  findYtDlpBinary,
  createYouTubeHandler,
  extractUrlExpireMs,
  formatFfmpegHeaders,
  selectYouTubeStreams
} from "../server/youtube.js";

test("extractYouTubeVideoId: parses various YouTube formats", () => {
  const expected = "dQw4w9WgXcQ";

  // Standard watch URL
  assert.equal(
    extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    expected
  );
  // Short URL
  assert.equal(
    extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"),
    expected
  );
  // Embed URL
  assert.equal(
    extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    expected
  );
  // Shorts URL
  assert.equal(
    extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    expected
  );
  // Mobile watch URL
  assert.equal(
    extractYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share"),
    expected
  );
  // Internal target prefix
  assert.equal(
    extractYouTubeVideoId("yt:dQw4w9WgXcQ"),
    expected
  );
  // Bare 11-char ID
  assert.equal(
    extractYouTubeVideoId("dQw4w9WgXcQ"),
    expected
  );

  // Invalid inputs
  assert.equal(extractYouTubeVideoId(""), null);
  assert.equal(extractYouTubeVideoId(null), null);
  assert.equal(extractYouTubeVideoId("not-a-youtube-url"), null);
  assert.equal(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
});

test("isYouTubeTarget returns true for valid YouTube IDs and URLs", () => {
  assert.equal(isYouTubeTarget("yt:dQw4w9WgXcQ"), true);
  assert.equal(isYouTubeTarget("https://youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(isYouTubeTarget("some/local/file.mp4"), false);
});

test("findYtDlpBinary resolves to a string", () => {
  const binary = findYtDlpBinary();
  assert.equal(typeof binary, "string");
  assert.ok(binary.length > 0);
});

test("createYouTubeHandler: routing and method checks", async () => {
  const handler = createYouTubeHandler();

  // Non-matching path should return false and invoke connect `next` middleware
  const reqOther = { url: "/api/state", method: "GET" };
  const resOther = {};
  let nextCalled = false;
  assert.equal(await handler(reqOther, resOther, () => { nextCalled = true; }), false);
  assert.equal(nextCalled, true);

  // Non-GET method on /api/youtube should return 405
  let status = 0;
  let headers = {};
  let body = "";
  const reqPost = { url: "/api/youtube/search", method: "POST" };
  const resPost = {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(b) {
      body = b;
    }
  };
  assert.equal(await handler(reqPost, resPost), true);
  assert.equal(status, 405);

  // Bad ID on /api/youtube/info should return 400
  const reqBadInfo = { url: "/api/youtube/info?v=invalid", method: "GET" };
  const resBadInfo = {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(b) {
      body = b;
    }
  };
  assert.equal(await handler(reqBadInfo, resBadInfo), true);
  assert.equal(status, 400);

  // Empty query on search returns empty list without error
  const reqEmptySearch = { url: "/api/youtube/search?q=", method: "GET" };
  const resEmptySearch = {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(b) {
      body = b;
    }
  };
  assert.equal(await handler(reqEmptySearch, resEmptySearch), true);
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { query: "", items: [] });

  // Empty query on shorts returns empty list without error
  const reqEmptyShorts = { url: "/api/youtube/shorts?q=", method: "GET" };
  const resEmptyShorts = {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(b) {
      body = b;
    }
  };
  assert.equal(await handler(reqEmptyShorts, resEmptyShorts), true);
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { query: "", items: [] });
});

test("standalone server: /api/youtube routing", async () => {
  const { startDriveServer } = await import("../server/standalone.js");
  const drive = startDriveServer({ port: 0, videosDir: "/tmp" });
  const port = await drive.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/youtube/search?q=`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { query: "", items: [] });

    const shortsRes = await fetch(`http://127.0.0.1:${port}/api/youtube/shorts?q=`);
    assert.equal(shortsRes.status, 200);
    const shortsData = await shortsRes.json();
    assert.deepEqual(shortsData, { query: "", items: [] });

    const badInfo = await fetch(`http://127.0.0.1:${port}/api/youtube/info?v=bad_id`);
    assert.equal(badInfo.status, 400);
  } finally {
    await drive.close();
  }
});

test("extractUrlExpireMs and formatFfmpegHeaders", () => {
  assert.equal(
    extractUrlExpireMs("https://rr1.googlevideo.com/videoplayback?expire=1700000000&id=1"),
    1700000000 * 1000
  );
  assert.equal(extractUrlExpireMs("https://example.com/no-expire"), null);
  assert.equal(extractUrlExpireMs("not a url"), null);

  assert.equal(
    formatFfmpegHeaders({ "User-Agent": "Test/1.0", Accept: "*/*", Bad: "a\r\nb" }),
    "User-Agent: Test/1.0\r\nAccept: */*\r\nBad: ab\r\n"
  );
  assert.equal(formatFfmpegHeaders(null), "");
});

test("selectYouTubeStreams: prefers direct HTTPS vp9 > avc1 > av01 and opus audio", () => {
  const formats = [
    {
      protocol: "https",
      url: "https://cdn/v-av01-720",
      vcodec: "av01.0.05M.08",
      acodec: "none",
      height: 720,
      fps: 30,
      tbr: 2000,
      http_headers: { "User-Agent": "UA" }
    },
    {
      protocol: "https",
      url: "https://cdn/v-avc1-720",
      vcodec: "avc1.4D401F",
      acodec: "none",
      height: 720,
      fps: 30,
      tbr: 1500
    },
    {
      protocol: "https",
      url: "https://cdn/v-vp9-720",
      vcodec: "vp9",
      acodec: "none",
      height: 720,
      fps: 60,
      tbr: 1200,
      http_headers: { "User-Agent": "UA-VP9" }
    },
    {
      protocol: "https",
      url: "https://cdn/v-vp9-1080",
      vcodec: "vp9",
      acodec: "none",
      height: 1080,
      fps: 60,
      tbr: 3000
    },
    {
      protocol: "https",
      url: "https://cdn/a-m4a",
      vcodec: "none",
      acodec: "mp4a.40.2",
      abr: 128
    },
    {
      protocol: "https",
      url: "https://cdn/a-opus",
      vcodec: "none",
      acodec: "opus",
      abr: 128
    }
  ];

  const pick720 = selectYouTubeStreams(formats, 720);
  assert.equal(pick720.videoUrl, "https://cdn/v-vp9-720");
  assert.equal(pick720.audioUrl, "https://cdn/a-opus");
  assert.equal(pick720.hasAudio, true);
  assert.equal(pick720.fps, 60);
  assert.equal(pick720.isDirect, true);
  assert.deepEqual(pick720.headers, { "User-Agent": "UA-VP9" });

  const pick1080 = selectYouTubeStreams(formats, 1080);
  assert.equal(pick1080.videoUrl, "https://cdn/v-vp9-1080");

  // Falls back to muxed when no separate audio exists
  const muxedOnly = selectYouTubeStreams(
    [
      {
        protocol: "https",
        url: "https://cdn/muxed-720",
        vcodec: "avc1",
        acodec: "mp4a",
        height: 720,
        fps: 25
      }
    ],
    720
  );
  assert.equal(muxedOnly.videoUrl, "https://cdn/muxed-720");
  assert.equal(muxedOnly.audioUrl, null);
  assert.equal(muxedOnly.hasAudio, true);
  assert.equal(muxedOnly.fps, 25);

  // Falls back to HLS when no direct HTTPS exists
  const hlsOnly = selectYouTubeStreams(
    [
      {
        protocol: "m3u8_native",
        url: "https://cdn/live.m3u8",
        vcodec: "avc1",
        acodec: "mp4a",
        height: 720,
        fps: 30
      }
    ],
    720
  );
  assert.equal(hlsOnly.videoUrl, "https://cdn/live.m3u8");
  assert.equal(hlsOnly.isDirect, false);
});
