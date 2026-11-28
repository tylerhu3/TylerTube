import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  isYouTubeTarget,
  findYtDlpBinary,
  createYouTubeHandler,
  extractUrlExpireMs,
  formatFfmpegHeaders,
  selectYouTubeStreams,
  extractHistorySeedCreators
} from "../server/youtube.js";
import {
  parseIso8601Duration,
  channelIdToShortsPlaylistId
} from "../server/youtube-feed.js";

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

test("extractYouTubePlaylistId: parses playlist URLs, watch+list URLs, and bare IDs", () => {
  const plId = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

  assert.equal(
    extractYouTubePlaylistId(`https://www.youtube.com/playlist?list=${plId}`),
    plId
  );
  assert.equal(
    extractYouTubePlaylistId(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${plId}&index=2`),
    plId
  );
  assert.equal(
    extractYouTubePlaylistId(`https://youtu.be/dQw4w9WgXcQ?list=${plId}`),
    plId
  );
  assert.equal(
    extractYouTubePlaylistId(`https://music.youtube.com/playlist?list=${plId}`),
    plId
  );
  assert.equal(extractYouTubePlaylistId(`ytpl:${plId}`), plId);
  assert.equal(extractYouTubePlaylistId(plId), plId);
  assert.equal(extractYouTubePlaylistId("LL"), "LL");

  // Invalid or non-playlist inputs
  assert.equal(extractYouTubePlaylistId(""), null);
  assert.equal(extractYouTubePlaylistId(null), null);
  assert.equal(extractYouTubePlaylistId("dQw4w9WgXcQ"), null);
  assert.equal(extractYouTubePlaylistId("lofi hip hop radio"), null);
  assert.equal(extractYouTubePlaylistId("https://example.com/playlist?list=" + plId), null);
});

test("createYouTubeHandler: /api/youtube/playlist and /api/youtube/playlists validation", async () => {
  const handler = createYouTubeHandler();

  let status = 0;
  let body = "";
  const makeRes = () => ({
    writeHead(s) {
      status = s;
    },
    end(b) {
      body = b;
    }
  });

  // Missing or invalid playlist ID -> 400
  assert.equal(
    await handler({ url: "/api/youtube/playlist?list=not-a-playlist", method: "GET" }, makeRes()),
    true
  );
  assert.equal(status, 400);

  // /api/youtube/playlists without authStore -> 401 AUTH_DISABLED
  assert.equal(
    await handler({ url: "/api/youtube/playlists", method: "GET" }, makeRes()),
    true
  );
  assert.equal(status, 401);
  assert.equal(JSON.parse(body).code, "AUTH_DISABLED");
});

test("selectYouTubeStreams: handles vertical 9:16 Shorts by short edge", () => {
  const verticalFormats = [
    {
      protocol: "https",
      url: "https://cdn/v-360",
      vcodec: "vp9",
      acodec: "none",
      width: 360,
      height: 640,
      fps: 30,
      tbr: 500
    },
    {
      protocol: "https",
      url: "https://cdn/v-480",
      vcodec: "vp9",
      acodec: "none",
      width: 480,
      height: 854,
      fps: 30,
      tbr: 900
    },
    {
      protocol: "https",
      url: "https://cdn/v-720",
      vcodec: "vp9",
      acodec: "none",
      width: 720,
      height: 1280,
      fps: 60,
      tbr: 1800
    },
    {
      protocol: "https",
      url: "https://cdn/v-1080",
      vcodec: "vp9",
      acodec: "none",
      width: 1080,
      height: 1920,
      fps: 60,
      tbr: 3200
    },
    {
      protocol: "https",
      url: "https://cdn/a-opus",
      vcodec: "none",
      acodec: "opus",
      abr: 128
    }
  ];

  // 480p quality picks 480x854 (short edge = 480) instead of dropping to 360x640
  assert.equal(selectYouTubeStreams(verticalFormats, 480).videoUrl, "https://cdn/v-480");
  // 720p quality picks 720x1280 (short edge = 720) instead of dropping to 360x640
  assert.equal(selectYouTubeStreams(verticalFormats, 720).videoUrl, "https://cdn/v-720");
  // 1080p quality picks 1080x1920
  assert.equal(selectYouTubeStreams(verticalFormats, 1080).videoUrl, "https://cdn/v-1080");
});

test("parseIso8601Duration and channelIdToShortsPlaylistId", () => {
  assert.equal(parseIso8601Duration("PT45S"), 45);
  assert.equal(parseIso8601Duration("PT1M15S"), 75);
  assert.equal(parseIso8601Duration("PT1H2M3S"), 3723);
  assert.equal(parseIso8601Duration("PT2M"), 120);
  assert.equal(parseIso8601Duration(""), 0);
  assert.equal(parseIso8601Duration("invalid"), 0);

  assert.equal(channelIdToShortsPlaylistId("UC_x5XG1OV2P6uZZ5FSM9Ttw"), "UUSH_x5XG1OV2P6uZZ5FSM9Ttw");
  assert.equal(channelIdToShortsPlaylistId("PL123"), null);
  assert.equal(channelIdToShortsPlaylistId(""), null);
});

test("extractHistorySeedCreators ranks creators with recency and short-video boost", () => {
  const history = [
    { id: "aaaaaaaaaaa", author: "YouTube", duration: 30 },
    { id: "bbbbbbbbbbb", author: "Veritasium", duration: 45 },
    { id: "ccccccccccc", author: "Marques Brownlee", duration: 600 },
    { id: "ddddddddddd", author: "Veritasium", duration: 55 },
    { id: "eeeeeeeeeee", author: "Fireship", duration: 100 }
  ];
  const creators = extractHistorySeedCreators(history, 3);
  assert.equal(creators[0], "Veritasium");
  assert.ok(creators.includes("Fireship"));
  assert.ok(!creators.includes("YouTube"));
});

test("createYouTubeHandler: /api/youtube/prefetch and /api/youtube/shorts/tailored", async () => {
  const handler = createYouTubeHandler();
  let status = 0;
  let body = "";
  const makeRes = () => ({
    writeHead(s) {
      status = s;
    },
    end(b) {
      body = b;
    }
  });

  // Prefetch with empty / invalid IDs returns 202 with empty queued list (no yt-dlp spawned)
  assert.equal(
    await handler({ url: "/api/youtube/prefetch?ids=invalid,bad", method: "GET" }, makeRes()),
    true
  );
  assert.equal(status, 202);
  assert.deepEqual(JSON.parse(body), { queued: [] });

  // Tailored shorts without auth or history returns 200 with tailored: false
  assert.equal(
    await handler({ url: "/api/youtube/shorts/tailored?limit=12", method: "GET" }, makeRes()),
    true
  );
  assert.equal(status, 200);
  const tailoredData = JSON.parse(body);
  assert.equal(tailoredData.tailored, false);
  assert.deepEqual(tailoredData.items, []);
});
