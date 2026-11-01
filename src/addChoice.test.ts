import { describe, expect, it } from "vitest";
import { queueWith } from "./addChoice.ts";

describe("queueWith", () => {
  it("puts a 'next' track at the head and a 'last' track at the tail", () => {
    expect(queueWith(["a", "b"], "c", "next")).toEqual(["c", "a", "b"]);
    expect(queueWith(["a", "b"], "c", "last")).toEqual(["a", "b", "c"]);
  });

  it("moves an already-queued track instead of duplicating it", () => {
    expect(queueWith(["a", "b", "c"], "c", "next")).toEqual(["c", "a", "b"]);
  });
});
