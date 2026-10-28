import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTrackRepo } from "../repo.ts";
import { JsonStationRepo, defaultStation } from "../station-repo.ts";
import { createStationRepoFromEnv } from "../db/index.ts";
import { stationContract } from "./station.contract.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ttunes-json-station-"));
  roots.push(root);
  return root;
}

stationContract("JsonStationRepo", async () => {
  const dir = tempDir();
  const open = () => ({
    tracks: new JsonTrackRepo(join(dir, "data", "tracks.json")),
    station: new JsonStationRepo(join(dir, "data", "station.json")),
  });
  return { ...open(), reopen: async () => open() };
});

describe("JsonStationRepo file", () => {
  it("is only written once something changes, and never left as a .tmp", async () => {
    const file = join(tempDir(), "data", "station.json");
    const repo = new JsonStationRepo(file);
    await repo.update(() => null);
    expect(existsSync(file)).toBe(false);
    await repo.update((s) => ({ ...s, queue: ["x"] }));
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it.each([
    ["not JSON", "{oops"],
    ["the wrong shape", JSON.stringify({ queue: "nope" })],
    ["an over-full queue", JSON.stringify({ ...defaultStation(), queue: ["a", "a", "a", "a", "a", "a", "a"] })],
    ["a bad nowPlaying", JSON.stringify({ ...defaultStation(), nowPlaying: { trackId: 1 } })],
  ])("logs and starts fresh when the file is %s", async (_what, content) => {
    const file = join(tempDir(), "station.json");
    writeFileSync(file, content);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const repo = new JsonStationRepo(file);
      expect(await repo.get()).toEqual(defaultStation());
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/station: .*starting fresh/));
      await repo.update((s) => ({ ...s, queue: ["x"] })); // and it can write over it
      expect((await new JsonStationRepo(file).get()).queue).toEqual(["x"]);
    } finally {
      logged.mockRestore();
    }
  });

  it("reads a file written before upNext existed", async () => {
    const file = join(tempDir(), "station.json");
    writeFileSync(file, JSON.stringify({ activePool: { kind: "library" }, nowPlaying: null, queue: ["a"] }));
    expect(await new JsonStationRepo(file).get()).toEqual({ ...defaultStation(), queue: ["a"] });
  });

  it("createStationRepoFromEnv picks the JSON file without DATABASE_URL", () => {
    const dir = tempDir();
    const repo = createStationRepoFromEnv(join(dir, "s.json"), new JsonTrackRepo(join(dir, "t.json")), {});
    expect(repo).toBeInstanceOf(JsonStationRepo);
  });
});
