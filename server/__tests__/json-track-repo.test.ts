import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTrackRepo } from "../repo.ts";
import { trackRepoContract } from "./track-repo.contract.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), "ttunes-json-repo-"));
  roots.push(root);
  return join(root, "data", "tracks.json");
}

trackRepoContract("JsonTrackRepo", async () => new JsonTrackRepo(tempFile()));

describe("JsonTrackRepo persistence", () => {
  it("reloads what it wrote", async () => {
    const file = tempFile();
    const a = new JsonTrackRepo(file);
    await a.add({
      id: "x",
      title: "X",
      artist: "A",
      album: null,
      durationSec: null,
      bitrate: null,
      format: null,
      sizeBytes: 1,
      storageKey: "x.mp3",
      createdAt: new Date(0).toISOString(),
    });
    expect((await new JsonTrackRepo(file).all()).map((t) => t.id)).toEqual(["x"]);
  });
});
