import test from "node:test";
import assert from "node:assert/strict";
import {
  YOUTUBE_MOOD_SECTIONS,
  CREATIVE_SEARCH_POOL,
  generateWildcardSearch,
  pickRandomSearch,
  pickRandomSuggestedSearches,
  pickQueryForSection,
  pickInitialShelves
} from "../src/data/youtubeDiscovery.js";
import { formatViewCount } from "../src/utils/format.js";

test("CREATIVE_SEARCH_POOL has a large variety of unique creative queries", () => {
  assert.ok(CREATIVE_SEARCH_POOL.length >= 80, "expected at least 80 curated creative queries");
  const lower = CREATIVE_SEARCH_POOL.map((q) => q.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, "curated queries should not duplicate");
});

test("pickRandomSearch returns non-empty strings and avoids the excluded query", () => {
  const first = pickRandomSearch("", () => 0.5);
  assert.ok(typeof first === "string" && first.length > 3);

  // Even with a constant RNG that picks from curated pool, excluding `first` returns something else
  const second = pickRandomSearch(first, () => 0.5);
  assert.notEqual(second.toLowerCase(), first.toLowerCase());

  // Wildcard branch (rng < 0.2)
  const wild = pickRandomSearch("", () => 0.05);
  assert.ok(wild.split(" ").length >= 3);
});

test("generateWildcardSearch builds multi-word creative queries", () => {
  const q = generateWildcardSearch(() => 0.33);
  assert.ok(typeof q === "string" && q.trim().length > 5);
});

test("pickRandomSuggestedSearches returns requested count without duplicates or excluded items", () => {
  const excluded = [CREATIVE_SEARCH_POOL[0], CREATIVE_SEARCH_POOL[1]];
  const picks = pickRandomSuggestedSearches(9, excluded);
  assert.equal(picks.length, 9);

  const lower = picks.map((p) => p.toLowerCase());
  assert.equal(new Set(lower).size, 9);
  for (const ex of excluded) {
    assert.ok(!lower.includes(ex.toLowerCase()));
  }
});

test("YOUTUBE_MOOD_SECTIONS and pickQueryForSection / pickInitialShelves work cleanly", () => {
  assert.ok(YOUTUBE_MOOD_SECTIONS.length >= 6);
  for (const section of YOUTUBE_MOOD_SECTIONS) {
    assert.ok(section.id && section.title && section.emoji && section.queries.length >= 5);
    const q1 = pickQueryForSection(section.id);
    assert.ok(section.queries.includes(q1));
    const q2 = pickQueryForSection(section.id, q1);
    assert.notEqual(q2.toLowerCase(), q1.toLowerCase());
  }

  const shelves = pickInitialShelves(3);
  assert.equal(shelves.length, 3);
  const ids = new Set(shelves.map((s) => s.id));
  assert.equal(ids.size, 3);
  for (const s of shelves) {
    assert.ok(typeof s.activeQuery === "string" && s.activeQuery.length > 0);
  }
});

test("formatViewCount formats counts compactly", () => {
  assert.equal(formatViewCount(0), "");
  assert.equal(formatViewCount(null), "");
  assert.equal(formatViewCount(850), "850 views");
  assert.equal(formatViewCount(1200), "1.2K views");
  assert.equal(formatViewCount(2000000), "2M views");
  assert.equal(formatViewCount(1460000000), "1.5B views");
});
