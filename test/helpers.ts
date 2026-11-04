import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorage } from "../server/storage.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { YouTubeIngest, type YtDlpRunner, type YtInfo } from "../server/ingest.ts";
import type { YtSearchRunner } from "../server/search.ts";
import { createApp } from "../server/app.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** Fake yt-dlp: writes the fixture MP3 where yt-dlp would, returns the given info JSON. */
export function fakeYtDlp(info: YtInfo): YtDlpRunner {
  return async (_url, outputTemplate) => {
    copyFileSync(join(FIXTURES, "tone.mp3"), outputTemplate.replace("%(ext)s", "mp3"));
    return info;
  };
}

const tempDirs: string[] = [];

/** mkdtemp that removeTempDirs() cleans up; call it from afterEach. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Default search: tests must never hit real YouTube. */
const failingSearch: YtSearchRunner = async () => {
  throw new Error("search runner not faked in this test");
};

/** A fully wired app on fresh temp dirs. */
export function makeTestApp(
  runner: YtDlpRunner = fakeYtDlp({ title: "Fixture" }),
  { search = failingSearch, staticDir }: { search?: YtSearchRunner; staticDir?: string } = {},
) {
  const root = makeTempDir("ttunes-test-");
  const uploadDir = join(root, "uploads");
  const storage = new LocalDiskStorage(uploadDir);
  const repo = new JsonTrackRepo(join(root, "data", "tracks.json"));
  const ingest = new YouTubeIngest(join(root, "staging"), runner);
  return { app: createApp({ storage, repo, ingest, search, uploadDir, staticDir }), repo, root };
}
