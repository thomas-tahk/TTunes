import { describe, expect, it } from "vitest";
import { createStorageFromEnv, S3Storage, verifyStorage } from "../s3-storage.ts";
import { LocalDiskStorage } from "../storage.ts";
import { runServer } from "./s3-test-env.ts";

describe("createStorageFromEnv", () => {
  it("uses local disk when S3_BUCKET is unset or blank", () => {
    expect(createStorageFromEnv({})).toBeInstanceOf(LocalDiskStorage);
    expect(createStorageFromEnv({ S3_BUCKET: " " })).toBeInstanceOf(LocalDiskStorage);
  });

  it("uses S3 with region auto and path-style by default when S3_BUCKET is set", async () => {
    const s = createStorageFromEnv({
      S3_BUCKET: "b",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(s).toBeInstanceOf(S3Storage);
    const cfg = (s as S3Storage).client.config;
    expect(await cfg.region()).toBe("auto");
    expect(cfg.forcePathStyle).toBe(true);
  });

  it("honours S3_REGION and S3_FORCE_PATH_STYLE=false", async () => {
    const s = createStorageFromEnv({ S3_BUCKET: "b", S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "false" });
    const cfg = (s as S3Storage).client.config;
    expect(await cfg.region()).toBe("us-east-1");
    expect(cfg.forcePathStyle).toBe(false);
  });

  it("fails loudly on half-set credentials or a bad boolean", () => {
    const endpoint = "http://127.0.0.1:9000";
    expect(() => createStorageFromEnv({ S3_BUCKET: "b", S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: "k" })).toThrow(
      /set together/,
    );
    expect(() =>
      createStorageFromEnv({ S3_BUCKET: "b", S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: "maybe" }),
    ).toThrow(/invalid boolean/);
  });

  it("throws when S3_BUCKET is set without S3_ENDPOINT and region is auto (would hit s3.auto.amazonaws.com)", () => {
    expect(() => createStorageFromEnv({ S3_BUCKET: "b" })).toThrow(/S3_ENDPOINT/);
    expect(() => createStorageFromEnv({ S3_BUCKET: "b", S3_REGION: "auto" })).toThrow(/S3_ENDPOINT/);
  });
});

describe("S3Storage.verify", () => {
  it("rejects with a clear, secret-free message when the endpoint is unreachable", async () => {
    const s = new S3Storage({
      bucket: "b",
      endpoint: "http://127.0.0.1:1",
      accessKeyId: "AKID-SHOULD-NOT-LEAK",
      secretAccessKey: "SECRET-SHOULD-NOT-LEAK",
    });
    const err = await s.verify().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/S3 storage check failed for bucket "b" at http:\/\/127\.0\.0\.1:1/);
    expect(err?.message).not.toMatch(/SHOULD-NOT-LEAK/);
  }, 20_000);

  it("verifyStorage is a no-op for local disk", async () => {
    await expect(verifyStorage(new LocalDiskStorage("/nonexistent-ttunes-dir"))).resolves.toBeUndefined();
  });
});

describe("server startup", () => {
  it("exits non-zero with a clear message when S3 config is invalid", async () => {
    const r = await runServer({ S3_BUCKET: "b", S3_SECRET_ACCESS_KEY: "SECRET-SHOULD-NOT-LEAK", S3_ACCESS_KEY_ID: "k" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/storage misconfigured: .*S3_ENDPOINT/);
    expect(r.stderr + r.stdout).not.toMatch(/SHOULD-NOT-LEAK/);
  }, 20_000);
});
