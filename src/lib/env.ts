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
   * The platform's own domain, and the operator console's address.
   *
   * A carrier is reached at `<subdomain>.<APP_ROOT_DOMAIN>`; the bare
   * domain is never a carrier and serves the console instead. `localhost`
   * in development, so `acme.localhost:3010` exercises exactly the
   * resolution path production uses — nobody should develop against a code
   * path that does not exist in production.
   */
  /**
   * Row-level security, the second of the two isolation mechanisms in
   * ADR 001. Validated here rather than read raw from `process.env`,
   * because it was silently absent from this schema — which meant a
   * deployment could ship with `off`, run on the Prisma extension alone,
   * and have `npm run tenant:verify` report success while skipping the
   * probes that would have said so.
   *
   * Defaults to `on` outside development: a production deployment that
   * forgets the variable gets the safer of the two behaviours.
   */
  TENANT_RLS: z
    .enum(["on", "off"])
    .default(process.env.NODE_ENV === "production" ? "on" : "off"),

  APP_ROOT_DOMAIN: z.string().default("localhost"),

  /**
   * How many reverse proxies stand between the internet and this process.
   *
   * The number is what makes `X-Forwarded-For` readable: the chain grows
   * left to right, so with one load balancer the client is the *last*
   * entry, with two it is the second from last, and with none no entry can
   * be believed at all. See `lib/net/client-ip.ts`.
   *
   * Defaults to 0 — trust nothing — because the failure modes of the two
   * possible wrong answers are not symmetric. Configured too low, an IP
   * allowlist refuses and an audit row loses an address; configured too
   * high, a forged header is accepted as fact. Set it deliberately when
   * the deployment gains a proxy: one for a single nginx or ALB, two for
   * a CDN in front of that.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),

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

  /**
   * Development fallbacks for what is now per-tenant configuration.
   *
   * A notification goes out as the carrier, so the real values live on
   * `Organization`: `supportPhone`, `dltSenderId`, `smtpFrom`. These three
   * are consulted only when no tenant has been established — a preview, a
   * script, a test — or when the carrier's own field is still empty during
   * onboarding, which for a DLT sender header can be weeks.
   *
   * A value set here is one every tenant on the deployment would share, and
   * in production all three should be empty.
   */
  SUPPORT_PHONE: z.string().default(""),
  SMS_SENDER_ID: z.string().default(""),
  SMTP_FROM: z.string().default(""),

  /**
   * The key `TenantCredential.secret` is encrypted under — 32 bytes, as 64
   * hex or 43 base64url characters.
   *
   * Empty by default rather than required, which is the one deliberate
   * exception to the rule at the top of this file. A carrier's own gateway
   * account is read only by the code that is about to call that gateway, so
   * a developer with no encrypted rows has nothing to decrypt; requiring it
   * at boot would stop `npm run dev` for a value that is not yet used, and
   * the usual response to that is a placeholder key committed to a `.env`.
   * `lib/integrations/secrets.ts` demands it at the moment of use instead,
   * and says what to do about it.
   *
   * Losing it is not recoverable: every stored secret must then be re-entered
   * by hand. It belongs with the database backups, not in them.
   */
  CREDENTIALS_KEY: z.string().default(""),
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
