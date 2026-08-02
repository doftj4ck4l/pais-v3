/**
 * Every environment variable the API reads, resolved once. Import this instead
 * of touching process.env, so the full configuration surface is one file.
 */
export const env = {
  port: Number(process.env.PORT || 4000),
  logLevel: process.env.LOG_LEVEL || "info",

  /** OpenAI-compatible gateway that serves the model catalog. */
  gatewayBaseUrl: process.env.CUSTOM_BASE_URL ?? "http://60.51.17.97:9999/v1",

  /** Default user id when a request doesn't carry one. */
  defaultUserId: process.env.DEFAULT_USER_ID ?? "local",
} as const;
