// How a newly added track enters playback. Every add path (YouTube link, dropped
// file, typed search) ends in one of these three choices.
export type AddChoice = "now" | "next" | "last";

/** The queue after adding `id` with "next" or "last" ("now" bypasses the queue). */
export function queueWith(queue: string[], id: string, choice: Exclude<AddChoice, "now">): string[] {
  const rest = queue.filter((q) => q !== id);
  return choice === "next" ? [id, ...rest] : [...rest, id];
}
