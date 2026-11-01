import { describe, expect, it } from "vitest";
import { addBatch, queueWith } from "../src/addChoice.ts";

function runBatch(choice: "now" | "next" | "last") {
  const played: string[] = [];
  let queue = ["x"];
  addBatch(["a", "b", "c"], choice, (id, c) => {
    if (c === "now") played.push(id);
    else queue = queueWith(queue, id, c);
  });
  return { played, queue };
}

describe("addBatch", () => {
  it("next: first dropped file is first in queue", () => {
    expect(runBatch("next").queue).toEqual(["a", "b", "c", "x"]);
  });
  it("last: drop order at the end", () => {
    expect(runBatch("last").queue).toEqual(["x", "a", "b", "c"]);
  });
  it("now: first plays, rest queue behind it", () => {
    expect(runBatch("now")).toEqual({ played: ["a"], queue: ["b", "c", "x"] });
  });
});
