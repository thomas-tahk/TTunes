import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTrackRepo } from "../repo.ts";
import { JsonStationRepo } from "../station-repo.ts";
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

  it("createStationRepoFromEnv picks the JSON file without DATABASE_URL", () => {
    const dir = tempDir();
    const repo = createStationRepoFromEnv(join(dir, "s.json"), new JsonTrackRepo(join(dir, "t.json")), {});
    expect(repo).toBeInstanceOf(JsonStationRepo);
  });
});
