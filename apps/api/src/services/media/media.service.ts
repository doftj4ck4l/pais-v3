import crypto from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

/**
 * Object storage for generated media, over RustFS (S3-compatible).
 *
 * The bytes of an image never enter SQLite or the chat transcript. One Gemini
 * image is 25–200KB, which is 33k–270k characters once base64'd: a single one
 * would exceed `RESULT_CHAR_CAP` (40k) on its own, and — worse — it would be
 * re-sent to the model on every following turn of the conversation. The bucket
 * holds the bytes, the row holds the key, and the transcript carries a URL.
 *
 * `Bun.S3Client` covers get/put/delete but has no CreateBucket, so that one
 * call is signed by hand below.
 */

/** True when enough configuration exists to reach the bucket at all. */
export function mediaConfigured(): boolean {
  return !!(env.s3Endpoint && env.s3Bucket && env.s3AccessKey && env.s3SecretKey);
}

let client: Bun.S3Client | undefined;

function mediaClient(): Bun.S3Client {
  if (!mediaConfigured()) {
    throw new Error(
      "object storage is not configured — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY",
    );
  }
  client ??= new Bun.S3Client({
    accessKeyId: env.s3AccessKey,
    secretAccessKey: env.s3SecretKey,
    bucket: env.s3Bucket,
    endpoint: env.s3Endpoint,
    region: env.s3Region,
  });
  return client;
}

/** Reset the memoised client. Tests point the endpoint somewhere else. */
export function resetMediaClient(): void {
  client = undefined;
  bucketReady = undefined;
}

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data).digest();

/**
 * PUT /<bucket>, signed with SigV4.
 *
 * Written out rather than pulled in as a dependency: this is the only request
 * in the codebase that `Bun.S3Client` cannot express, and `@aws-sdk/client-s3`
 * is ~20MB of transitive dependency to gain one call.
 */
async function createBucket(): Promise<Response> {
  const url = new URL(`${env.s3Endpoint}/${env.s3Bucket}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260810T093000Z
  const dateStamp = amzDate.slice(0, 8);

  // Outside us-east-1 the region has to be stated in the body, or S3-compatible
  // servers reject the request as a region mismatch.
  const body =
    env.s3Region === "us-east-1"
      ? ""
      : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<LocationConstraint>${env.s3Region}</LocationConstraint></CreateBucketConfiguration>`;
  const payloadHash = sha256(body);

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join("");

  const canonicalRequest = [
    "PUT",
    url.pathname,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${env.s3Region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const signature = hmac(
    hmac(hmac(hmac(hmac(`AWS4${env.s3SecretKey}`, dateStamp), env.s3Region), "s3"), "aws4_request"),
    stringToSign,
  ).toString("hex");

  return fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${env.s3AccessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body || undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Make sure the bucket exists, at most once per process.
 *
 * The promise itself is cached, not its result, so twenty concurrent first
 * writes issue one CreateBucket rather than twenty racing ones.
 */
let bucketReady: Promise<void> | undefined;

export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const res = await createBucket();
    // Both outcomes mean "the bucket is there". Re-creating an existing bucket
    // is 409 BucketAlreadyOwnedByYou on AWS, but RustFS answers 200 — measured,
    // not assumed — and that is the steady state on every boot after the first.
    if (res.ok || res.status === 409) {
      logger.debug("media.bucket.ready", { bucket: env.s3Bucket, status: res.status });
      return;
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`could not create bucket ${env.s3Bucket}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  })().catch((e) => {
    // Do not cache a failure: RustFS may simply not be up yet, and the next
    // call should retry rather than inherit a permanent error.
    bucketReady = undefined;
    throw e;
  });
  return bucketReady;
}

/** Store bytes under `key`. Returns the key it wrote. */
export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  await ensureBucket();
  await mediaClient().write(key, bytes, { type: contentType });
  logger.debug("media.put", { key, bytes: bytes.byteLength, contentType });
  return key;
}

/** Read an object back. Returns null when the key is not in the bucket. */
export async function getObject(key: string): Promise<Uint8Array | null> {
  const file = mediaClient().file(key);
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Remove an object. Missing keys are not an error. */
export async function deleteObject(key: string): Promise<void> {
  await mediaClient().delete(key);
}
