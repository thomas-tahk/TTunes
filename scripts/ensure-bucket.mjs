// One-shot: creates S3_BUCKET on S3_ENDPOINT if it doesn't exist, retrying while the store boots.
// Used by docker-compose.yml for a self-hosted MinIO. Not needed for Cloudflare R2 (create the bucket there).
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
if (!S3_ENDPOINT || !S3_BUCKET) {
  console.error("ensure-bucket: S3_ENDPOINT and S3_BUCKET are required");
  process.exit(1);
}

const client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION || "auto",
  forcePathStyle: true,
  credentials:
    S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
      ? { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY }
      : undefined,
});

const deadline = Date.now() + 60_000;
for (let attempt = 1; ; attempt++) {
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      console.log(`ensure-bucket: ${S3_BUCKET} exists`);
    } catch (err) {
      if (err?.$metadata?.httpStatusCode !== 404) throw err;
      await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      console.log(`ensure-bucket: created ${S3_BUCKET}`);
    }
    process.exit(0);
  } catch (err) {
    if (Date.now() > deadline) {
      console.error(`ensure-bucket: giving up after ${attempt} attempts: ${err?.name ?? ""} ${err?.message ?? err}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
