import { describe, expect, it } from "vitest";
import { createStorageFromEnv, S3Storage } from "../s3-storage.ts";
import { LocalDiskStorage } from "../storage.ts";

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
    expect(() => createStorageFromEnv({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k" })).toThrow(/set together/);
    expect(() => createStorageFromEnv({ S3_BUCKET: "b", S3_FORCE_PATH_STYLE: "maybe" })).toThrow(/invalid boolean/);
  });
});
