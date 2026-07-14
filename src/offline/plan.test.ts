// Run: npx tsx src/offline/plan.test.ts
import assert from "node:assert/strict";
import type { Track } from "../types.ts";
import { planOfflineSync } from "./plan.ts";
import { parseRange } from "./range.ts";

function track(id: string, sizeBytes: number, createdAt: string): Track {
  return { id, title: id, artist: "x", album: null, durationSec: null, bitrate: null, format: null, sizeBytes, storageKey: id, createdAt };
}

// --- planOfflineSync ---

// Fits under budget → mirror everything, download the uncached, evict nothing.
(() => {
  const tracks = [track("a", 100, "2026-01-01"), track("b", 100, "2026-01-02")];
  const plan = planOfflineSync(tracks, ["a"], 1000);
  assert.deepEqual(new Set(plan.keep), new Set(["a", "b"]));
  assert.deepEqual(plan.toDownload, ["b"]);
  assert.deepEqual(plan.toEvict, []);
})();

// Over budget → keep newest-first that fits; the rest neither downloaded nor kept.
(() => {
  const tracks = [track("old", 100, "2026-01-01"), track("new", 100, "2026-01-03"), track("mid", 100, "2026-01-02")];
  const plan = planOfflineSync(tracks, [], 250); // room for 2
  assert.deepEqual(plan.keep, ["new", "mid"]); // newest first
  assert.ok(!plan.keep.includes("old"));
})();

// Shrinking budget evicts an already-cached track that no longer fits.
(() => {
  const tracks = [track("old", 100, "2026-01-01"), track("new", 100, "2026-01-03")];
  const plan = planOfflineSync(tracks, ["old", "new"], 100); // room for 1
  assert.deepEqual(plan.keep, ["new"]);
  assert.deepEqual(plan.toEvict, ["old"]);
})();

// A cached track deleted from the library gets evicted.
(() => {
  const plan = planOfflineSync([track("a", 100, "2026-01-01")], ["a", "ghost"], 1000);
  assert.deepEqual(plan.toEvict, ["ghost"]);
})();

// Unlimited budget keeps everything.
(() => {
  const tracks = [track("a", 1e9, "2026-01-01"), track("b", 1e9, "2026-01-02")];
  const plan = planOfflineSync(tracks, [], Number.POSITIVE_INFINITY);
  assert.deepEqual(new Set(plan.keep), new Set(["a", "b"]));
})();

// --- parseRange ---
assert.equal(parseRange(null, 1000), null);
assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 }); // open-ended
assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 }); // suffix
assert.deepEqual(parseRange("bytes=0-99999", 1000), { start: 0, end: 999 }); // clamp over-end
assert.equal(parseRange("bytes=900-100", 1000), null); // start > end

console.log("✓ offline plan + range tests passed");
