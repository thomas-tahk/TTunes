import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CreateBucketCommand, HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { S3Storage, type S3StorageConfig } from "../s3-storage.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Runs server/index.ts with the given env (inherited S3_/DB/auth vars stripped) in a temp
 * cwd. Resolves when it exits, or after timeoutMs (killing it) with code null: it kept running.
 */
export function runServer(
  env: Record<string, string>,
  timeoutMs = 8000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "ttunes-startup-"));
  // strip inherited config so only `env` decides storage (and the JSON repo + no auth are used)
  const inherited = ["DATABASE_URL", "OWNER_PASSWORD", "SESSION_SECRET", "TRUST_PROXY"];
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("S3_") && !inherited.includes(k)),
  );
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/tsx"), [join(REPO_ROOT, "server/index.ts")], {
    cwd,
    env: { ...base, PORT: "0", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  let timedOut = false;
  return new Promise((done) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      done({ code: timedOut ? null : code, stdout, stderr });
    });
  });
}

/**
 * S3 config for integration tests, from TEST_S3_* env vars. Null when
 * TEST_S3_ENDPOINT is unset, so S3 suites skip via describe.skipIf.
 */
export const testS3Config: S3StorageConfig | null = process.env.TEST_S3_ENDPOINT
  ? {
      endpoint: process.env.TEST_S3_ENDPOINT,
      bucket: process.env.TEST_S3_BUCKET ?? "ttunes-test",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin",
      region: process.env.TEST_S3_REGION ?? "auto",
      forcePathStyle: true,
    }
  : null;

/** Creates the test bucket if it doesn't exist yet and returns an adapter for it. */
export async function makeTestS3Storage(config: S3StorageConfig): Promise<S3Storage> {
  const storage = new S3Storage(config);
  await ensureBucket(storage.client, config.bucket);
  return storage;
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw err;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    // a parallel test file may have just created it
    const name = (err as Error).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
  }
}
