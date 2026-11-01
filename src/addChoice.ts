// How a newly added track enters playback. Every add path (YouTube link, dropped
// file, typed search) ends in one of these three choices.
export type AddChoice = "now" | "next" | "last";

/** The queue after adding `id` with "next" or "last" ("now" bypasses the queue). */
export function queueWith(queue: string[], id: string, choice: Exclude<AddChoice, "now">): string[] {
  const rest = queue.filter((q) => q !== id);
  return choice === "next" ? [id, ...rest] : [...rest, id];
}

/**
 * Applies one choice to a dropped batch so the first file ends up first:
 * "next" adds in reverse (each lands in front), "last" adds in drop order,
 * "now" plays the first file and queues the rest right behind it.
 */
export function addBatch(ids: string[], choice: AddChoice, add: (id: string, choice: AddChoice) => void): void {
  if (choice === "last") return ids.forEach((id) => add(id, "last"));
  const [first, ...rest] = ids;
  if (choice === "now" && first !== undefined) add(first, "now");
  const toQueue = choice === "now" ? rest : ids;
  [...toQueue].reverse().forEach((id) => add(id, "next"));
}
