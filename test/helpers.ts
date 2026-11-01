import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorage } from "../server/storage.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { YouTubeIngest, type YtDlpRunner, type YtInfo } from "../server/ingest.ts";
import { runRealYtSearch, type YtSearchRunner } from "../server/search.ts";
import { createApp } from "../server/app.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** Fake yt-dlp: writes the fixture MP3 where yt-dlp would, returns the given info JSON. */
export function fakeYtDlp(info: YtInfo): YtDlpRunner {
  return async (_url, outputTemplate) => {
    copyFileSync(join(FIXTURES, "tone.mp3"), outputTemplate.replace("%(ext)s", "mp3"));
    return info;
  };
}

/** A fully wired app on fresh temp dirs. */
export function makeTestApp(
  runner: YtDlpRunner = fakeYtDlp({ title: "Fixture" }),
  { search = runRealYtSearch }: { search?: YtSearchRunner } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ttunes-test-"));
  const uploadDir = join(root, "uploads");
  const storage = new LocalDiskStorage(uploadDir);
  const repo = new JsonTrackRepo(join(root, "data", "tracks.json"));
  const ingest = new YouTubeIngest(join(root, "staging"), runner);
  return { app: createApp({ storage, repo, ingest, search, uploadDir }), repo, root };
}
