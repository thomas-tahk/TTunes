import type { FeedItem } from "./useRequests.ts";

/** Waiting requests older than the feed's newest 30 are pinned above it, so every one the badge counts can be acted on. */
export function withAllWaiting(requests: FeedItem[], waiting: FeedItem[]): FeedItem[] {
  const listed = new Set(requests.map((r) => r.id));
  return [...waiting.filter((w) => !listed.has(w.id)), ...requests];
}

/** A load that started before the latest owner action must not overwrite what that action just showed. */
export function createStaleGuard() {
  let actions = 0;
  return {
    actionStarted: () => {
      actions += 1;
    },
    startLoad: () => {
      const seen = actions;
      return () => seen === actions;
    },
  };
}

const DONE = {
  approve: "Approved. It is queued.",
  deny: "Denied. It will not play.",
  remove: "Removed from the feed.",
  keep: "Added to the library.",
} as const;

/** The note after a successful action; Remove on a request that had not played yet cancels it, and says so. */
export function doneNote(action: keyof typeof DONE, before: string | undefined): string {
  return action === "remove" && (before === "queued" || before === "waiting") ? "Removed. It will not play." : DONE[action];
}
