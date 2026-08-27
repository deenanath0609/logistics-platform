import { z } from "zod";

/**
 * Fail at boot, not at 6am on a loading dock. Anything the server
 * genuinely cannot run without is required here; everything phased
 * in later carries a safe default.
 */
const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),

  REDIS_URL: z.string().default("redis://localhost:6380"),

  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z.string().url().optional(),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(43200),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * The platform's own domain. A tenant is reached at
   * `<subdomain>.<APP_ROOT_DOMAIN>`, so this is `localhost` in development
   * and lets `acme.localhost:3010` exercise the same resolution path that
   * production uses — nobody should develop against a code path that does
   * not exist in production.
   */
  APP_ROOT_DOMAIN: z.string().default("localhost"),

  APP_NAME: z.string().default("City Logistics"),
  APP_URL: z.string().default("http://localhost:3010"),
  LR_PREFIX: z.string().default("CL"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),
  DEFAULT_CURRENCY: z.string().default("INR"),

  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("logistics"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  SMS_PROVIDER: z.string().default("mock"),
  WHATSAPP_PROVIDER: z.string().default("mock"),
  MAPS_PROVIDER: z.string().default("mock"),
  GPS_PROVIDER: z.string().default("mock"),
  GPS_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /// Raw fixes kept at full resolution for this long.
  GPS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /// Beyond this, downsampled fixes are deleted. Must exceed retention —
  /// a shorter archive would delete hot data, so the retention pass
  /// refuses rather than obeying.
  GPS_ARCHIVE_DAYS: z.coerce.number().int().positive().default(400),
  GPS_RETENTION_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  EWAYBILL_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
