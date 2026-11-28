import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  parseTakeoutWatchHistory,
  parseTakeoutWatchHistoryJson,
  parseTakeoutWatchHistoryHtml,
  mergeYouTubeHistory
} from "../src/lib/youtubeHistory.js";
import {
  createYouTubeHistoryStore,
  validateCookiesBrowser,
  validateNetscapeCookiesText
} from "../server/youtube-history.js";
import { createYouTubeHandler } from "../server/youtube.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tylertube-yt-history-"));
}

function makeReq(method, url, body = "") {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function makeRes() {
  const out = { status: 0, headers: {}, body: "" };
  out.writeHead = (s, h) => {
    out.status = s;
    out.headers = h || {};
  };
  out.end = (chunk) => {
    out.body = chunk ? String(chunk) : "";
  };
  return out;
}

test("parseTakeoutWatchHistoryJson: parses, deduplicates, cleans titles, skips removed", () => {
  const sample = [
    {
      header: "YouTube",
      title: "Watched Rick Astley - Never Gonna Give You Up",
      titleUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      subtitles: [{ name: "Rick Astley", url: "https://www.youtube.com/channel/123" }],
      time: "2026-11-25T10:00:00.000Z"
    },
    {
      header: "YouTube",
      title: "Watched Rick Astley - Never Gonna Give You Up",
      titleUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      subtitles: [{ name: "Rick Astley" }],
      time: "2026-11-20T08:00:00.000Z"
    },
    {
      header: "YouTube",
      title: "Watched a video that has been removed",
      titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      time: "2026-11-24T10:00:00.000Z"
    },
    {
      header: "YouTube",
      title: "Watched Cool Short",
      titleUrl: "https://www.youtube.com/shorts/abcdefghijk",
      subtitles: [{ name: "Creator" }],
      time: "2026-11-26T12:00:00.000Z"
    }
  ];

  const items = parseTakeoutWatchHistoryJson(JSON.stringify(sample));
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "abcdefghijk");
  assert.equal(items[0].title, "Cool Short");
  assert.equal(items[0].author, "Creator");
  assert.equal(items[0].source, "youtube");
  assert.equal(items[0].watchedOnYouTube, true);

  assert.equal(items[1].id, "dQw4w9WgXcQ");
  assert.equal(items[1].title, "Rick Astley - Never Gonna Give You Up");
  assert.equal(items[1].watchedAt, Date.parse("2026-11-25T10:00:00.000Z"));
});

test("parseTakeoutWatchHistoryHtml: extracts video, channel, and timestamp", () => {
  const html = `
    <div class="outer-cell">
      <div class="content-cell mdl-cell">
        Watched&nbsp;<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Tom &amp; Jerry</a><br>
        <a href="https://www.youtube.com/channel/UC123">WB Kids</a><br>
        Nov 25, 2026, 3:15:00 PM UTC
      </div>
    </div>
  `;
  const items = parseTakeoutWatchHistoryHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "dQw4w9WgXcQ");
  assert.equal(items[0].title, "Tom & Jerry");
  assert.equal(items[0].author, "WB Kids");
  assert.ok(items[0].watchedAt > 0);

  // Auto-detect via parseTakeoutWatchHistory
  const auto = parseTakeoutWatchHistory(html, "watch-history.html");
  assert.equal(auto.length, 1);
  assert.equal(auto[0].id, "dQw4w9WgXcQ");
});

test("mergeYouTubeHistory: preserves richest metadata and newest timestamp", () => {
  const base = [
    {
      id: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
      duration: 213,
      watchedAt: 1000,
      source: "youtube",
      watchedOnYouTube: true
    }
  ];
  const incoming = [
    {
      id: "dQw4w9WgXcQ",
      title: "YouTube Video",
      author: "YouTube",
      duration: 0,
      watchedAt: 2000,
      source: "tylertube",
      watchedOnYouTube: false
    },
    {
      id: "abcdefghijk",
      title: "Second Video",
      author: "Channel B",
      duration: 60,
      watchedAt: 3000,
      source: "youtube",
      watchedOnYouTube: true
    }
  ];

  const merged = mergeYouTubeHistory(base, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "abcdefghijk");
  assert.equal(merged[1].id, "dQw4w9WgXcQ");
  assert.equal(merged[1].title, "Never Gonna Give You Up");
  assert.equal(merged[1].author, "Rick Astley");
  assert.equal(merged[1].duration, 213);
  assert.equal(merged[1].watchedAt, 2000);
  assert.equal(merged[1].watchedOnYouTube, true);
});

test("validateCookiesBrowser and validateNetscapeCookiesText", () => {
  assert.equal(validateCookiesBrowser("chrome"), "chrome");
  assert.equal(validateCookiesBrowser("chrome:Profile 1"), "chrome:Profile 1");
  assert.equal(validateCookiesBrowser("chrome; rm -rf /"), null);
  assert.equal(validateCookiesBrowser("unknownbrowser"), null);

  assert.equal(validateNetscapeCookiesText("").valid, false);
  assert.equal(validateNetscapeCookiesText("not a cookie file").valid, false);

  const validCookies = [
    "# Netscape HTTP Cookie File",
    ".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc123"
  ].join("\n");
  assert.equal(validateNetscapeCookiesText(validCookies).valid, true);
});

test("createYouTubeHistoryStore & /api/youtube/history routes", async () => {
  const dir = makeTempDir();
  try {
    const storeFile = path.join(dir, "youtube-history.json");
    const store = createYouTubeHistoryStore(storeFile);
    const handler = createYouTubeHandler({
      historyStore: store,
      fetchHistoryViaYtDlp: async () => ({
        items: [
          {
            id: "syncVideo11",
            title: "Synced From YouTube",
            author: "YT Creator",
            duration: 300,
            thumbnail: "https://i.ytimg.com/vi/syncVideo11/hqdefault.jpg",
            viewCount: 5000,
            watchedAt: 5000,
            source: "youtube",
            watchedOnYouTube: true
          }
        ],
        syncedAt: 5000
      })
    });

    // 1. Initial GET is empty
    const res1 = makeRes();
    assert.equal(await handler(makeReq("GET", "/api/youtube/history"), res1), true);
    assert.equal(res1.status, 200);
    assert.deepEqual(JSON.parse(res1.body).items, []);

    // 2. Record TylerTube watch
    const res2 = makeRes();
    await handler(
      makeReq(
        "POST",
        "/api/youtube/history/record",
        JSON.stringify({ id: "ttVideo1234", title: "Watched on TT", author: "Author A", watchedAt: 2000 })
      ),
      res2
    );
    assert.equal(res2.status, 200);
    assert.equal(JSON.parse(res2.body).items.length, 1);

    // 3. Import Google Takeout JSON content
    const res3 = makeRes();
    const takeout = JSON.stringify([
      {
        title: "Watched Takeout Video",
        titleUrl: "https://www.youtube.com/watch?v=takeoutVid1",
        subtitles: [{ name: "Takeout Channel" }],
        time: "2026-11-25T10:00:00.000Z"
      }
    ]);
    await handler(
      makeReq(
        "POST",
        "/api/youtube/history/import",
        JSON.stringify({ content: takeout, filename: "watch-history.json" })
      ),
      res3
    );
    assert.equal(res3.status, 200);
    const importedBody = JSON.parse(res3.body);
    assert.equal(importedBody.importedCount, 1);
    assert.equal(importedBody.items.length, 2);

    // 4. Save cookies.txt & run live sync
    const resCookies = makeRes();
    await handler(
      makeReq(
        "POST",
        "/api/youtube/history/cookies",
        JSON.stringify({
          cookies: "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\txyz"
        })
      ),
      resCookies
    );
    assert.equal(resCookies.status, 200);
    assert.equal(JSON.parse(resCookies.body).sync.liveConfigured, true);

    const resSync = makeRes();
    await handler(makeReq("POST", "/api/youtube/history/sync", "{}"), resSync);
    assert.equal(resSync.status, 200);
    const syncBody = JSON.parse(resSync.body);
    assert.equal(syncBody.syncedCount, 1);
    assert.equal(syncBody.items.length, 3);

    // 5. Delete single item and verify re-sync respects tombstone
    const resDel = makeRes();
    await handler(makeReq("DELETE", "/api/youtube/history?id=syncVideo11"), resDel);
    assert.equal(resDel.status, 200);
    assert.equal(JSON.parse(resDel.body).items.length, 2);

    const resSync2 = makeRes();
    await handler(makeReq("POST", "/api/youtube/history/sync", "{}"), resSync2);
    assert.equal(resSync2.status, 200);
    assert.equal(JSON.parse(resSync2.body).items.length, 2);

    // 6. Disconnect cookies
    const resDelCookies = makeRes();
    await handler(makeReq("DELETE", "/api/youtube/history/cookies"), resDelCookies);
    assert.equal(resDelCookies.status, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
