import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlaylistIdFromInput,
  createCustomPlaylist,
  renameCustomPlaylist,
  deleteCustomPlaylist,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
  moveVideoInPlaylist,
  getAdjacentPlaylistVideo,
  toPlayableYouTubeVideo
} from "../src/lib/youtubePlaylists.js";

test("extractPlaylistIdFromInput detects playlist URLs and bare playlist IDs", () => {
  const id = "PL1234567890abcdef";
  assert.equal(
    extractPlaylistIdFromInput(`https://www.youtube.com/playlist?list=${id}`),
    id
  );
  assert.equal(
    extractPlaylistIdFromInput(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${id}`),
    id
  );
  assert.equal(extractPlaylistIdFromInput(id), id);
  assert.equal(extractPlaylistIdFromInput("ytpl:" + id), id);
  assert.equal(extractPlaylistIdFromInput("dQw4w9WgXcQ"), null);
  assert.equal(extractPlaylistIdFromInput("jazz piano"), null);
});

test("custom playlist CRUD: create, rename, add/dedupe, reorder, remove, delete", () => {
  const v1 = { id: "aaaaaaaaaaa", title: "Track 1", author: "Chan 1", duration: 120 };
  const v2 = { id: "yt_bbbbbbbbbbb", title: "Track 2", author: "Chan 2", duration: 240 };

  let list = createCustomPlaylist([], { name: "Road Trip", items: [v1] });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Road Trip");
  assert.equal(list[0].items.length, 1);
  const plId = list[0].id;

  // Adding a duplicate video is a no-op
  list = addVideoToPlaylist(list, plId, v1);
  assert.equal(list[0].items.length, 1);

  // Adding a new video normalizes yt_ prefix
  list = addVideoToPlaylist(list, plId, v2);
  assert.equal(list[0].items.length, 2);
  assert.equal(list[0].items[1].id, "bbbbbbbbbbb");

  // Reorder up/down
  list = moveVideoInPlaylist(list, plId, "bbbbbbbbbbb", "up");
  assert.deepEqual(
    list[0].items.map((v) => v.id),
    ["bbbbbbbbbbb", "aaaaaaaaaaa"]
  );
  list = moveVideoInPlaylist(list, plId, "bbbbbbbbbbb", "down");
  assert.deepEqual(
    list[0].items.map((v) => v.id),
    ["aaaaaaaaaaa", "bbbbbbbbbbb"]
  );

  // Rename
  list = renameCustomPlaylist(list, plId, "Night Drive");
  assert.equal(list[0].title, "Night Drive");

  // Remove video
  list = removeVideoFromPlaylist(list, plId, "yt_aaaaaaaaaaa");
  assert.deepEqual(
    list[0].items.map((v) => v.id),
    ["bbbbbbbbbbb"]
  );

  // Delete playlist
  list = deleteCustomPlaylist(list, plId);
  assert.equal(list.length, 0);
});

test("getAdjacentPlaylistVideo advances, wraps, and shuffles cleanly", () => {
  const playlist = {
    id: "pl1",
    title: "Mix",
    items: [
      { id: "11111111111", title: "One", author: "A", duration: 60 },
      { id: "22222222222", title: "Two", author: "B", duration: 90 },
      { id: "33333333333", title: "Three", author: "C", duration: 120 }
    ]
  };

  // Next wraps from last to first
  assert.equal(getAdjacentPlaylistVideo(playlist, "yt_11111111111", 1).id, "yt_22222222222");
  assert.equal(getAdjacentPlaylistVideo(playlist, "yt_33333333333", 1).id, "yt_11111111111");

  // Prev wraps from first to last
  assert.equal(getAdjacentPlaylistVideo(playlist, "yt_11111111111", -1).id, "yt_33333333333");

  // Shuffle picks a different track when length > 1
  const shuffled = getAdjacentPlaylistVideo(playlist, "yt_22222222222", 1, {
    shuffle: true,
    randomFn: () => 0.75
  });
  assert.notEqual(shuffled.id, "yt_22222222222");
  assert.equal(shuffled.isYouTube, true);
  assert.equal(shuffled.src, `yt:${shuffled.ytId}`);

  // Playable conversion
  const playable = toPlayableYouTubeVideo(playlist.items[0]);
  assert.equal(playable.src, "yt:11111111111");
  assert.equal(playable.isYouTube, true);
});
