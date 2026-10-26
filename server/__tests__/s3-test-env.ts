import { CreateBucketCommand, HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { S3Storage, type S3StorageConfig } from "../s3-storage.ts";

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
