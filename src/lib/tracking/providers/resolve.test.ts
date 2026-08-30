import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "@/lib/integrations/credentials";

/**
 * Whose telematics account is this carrier's live map actually made of?
 *
 * The push half of the pipeline has answered this per carrier since the
 * webhook route learned to identify a sender by whichever secret verifies.
 * The pull half answered "whatever `GPS_PROVIDER` says" for every carrier at
 * once, which is the failure this file now guards against: one account, one
 * bill, one revoked key that empties fifty live maps together.
 *
 * The test that matters most is the least dramatic one — a carrier with two
 * vendors gets both polled. Returning "the" provider for them would leave
 * half a fleet quietly unpolled, and a truck that is simply never asked
 * about looks exactly like a truck that has not moved.
 */

const env = vi.hoisted(() => ({
  current: {
    GPS_PROVIDER: "mock",
    GPS_POLL_INTERVAL_SECONDS: 30,
  } as Record<string, unknown>,
}));

const store = vi.hoisted(() => ({
  /** Rows as the table holds them, unfiltered. The mock applies the where. */
  configs: [] as Record<string, unknown>[],
  credential: null as unknown,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    trackingProviderConfig: {
      /**
       * Applies the `where` rather than ignoring it. The point of these
       * tests is partly the query itself — a row that is disabled, or set
       * to be pushed rather than pulled, must not come back — and a mock
       * that returned everything would pass whatever the query said.
       */
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        store.configs.filter((row) => {
          if (where.isActive !== undefined && row.isActive !== where.isActive) {
            return false;
          }
          const mode = where.mode as { in?: string[] } | undefined;
          if (mode?.in && !mode.in.includes(row.mode as string)) return false;
          return true;
        }),
    },
  },
}));

vi.mock("@/lib/integrations/credentials", () => ({
  credentialFor: async () => store.credential,
}));

const { resolvePollProviders, isDue } = await import("./resolve");

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cfg_1",
    code: "mock",
    baseUrl: "https://api.vendor.example",
    apiKey: "vendor-key",
    webhookSecret: "vendor-secret",
    pollIntervalSeconds: 60,
    lastPolledAt: null,
    isActive: true,
    mode: "poll",
    ...overrides,
  };
}

function credential(
  overrides: Partial<ResolvedCredential<"GPS">> = {},
): ResolvedCredential<"GPS"> {
  return {
    kind: "GPS",
    source: "none",
    secret: null,
    settings: { providerCode: null, baseUrl: null },
    orgId: "org_1",
    updatedAt: null,
    ...overrides,
  } as ResolvedCredential<"GPS">;
}

beforeEach(() => {
  store.configs = [];
  store.credential = credential();
  env.current.GPS_PROVIDER = "mock";
  env.current.GPS_POLL_INTERVAL_SECONDS = 30;
});

// ────────────────────────────────────────────────────────────

describe("resolvePollProviders", () => {
  it("polls the carrier's own vendor, with the carrier's own key", async () => {
    store.configs = [row()];

    const [provider, ...rest] = await resolvePollProviders();

    expect(rest).toHaveLength(0);
    expect(provider.source).toBe("config");
    expect(provider.configId).toBe("cfg_1");
    expect(provider.code).toBe("mock");
    expect(provider.credentials.apiKey).toBe("vendor-key");
    expect(provider.credentials.baseUrl).toBe("https://api.vendor.example");
    expect(provider.pollIntervalSeconds).toBe(60);
  });

  it("polls every vendor a carrier has, not just the first", async () => {
    // One organisation on two telematics contracts, which is what buying a
    // competitor leaves behind. Picking one would strand the other fleet.
    store.configs = [
      row({ id: "cfg_a", code: "mock", apiKey: "key-a" }),
      row({ id: "cfg_b", code: "mock", apiKey: "key-b" }),
    ];

    const resolved = await resolvePollProviders();

    expect(resolved.map((entry) => entry.configId)).toEqual(["cfg_a", "cfg_b"]);
    expect(resolved.map((entry) => entry.credentials.apiKey)).toEqual([
      "key-a",
      "key-b",
    ]);
  });

  it("does not poll a vendor that pushes", async () => {
    // Polling a webhook vendor as well would double every fix and turn the
    // duplicate counters into noise.
    store.configs = [row({ mode: "webhook" })];
    store.credential = credential({ source: "platform", secret: "platform-key" });

    const [provider] = await resolvePollProviders();

    expect(provider.source).not.toBe("config");
  });

  it("polls a vendor that both pushes and is pulled", async () => {
    store.configs = [row({ mode: "both" })];

    const [provider] = await resolvePollProviders();

    expect(provider.source).toBe("config");
  });

  it("does not poll a disabled vendor", async () => {
    store.configs = [row({ isActive: false })];

    const [provider] = await resolvePollProviders();

    expect(provider.source).not.toBe("config");
    expect(provider.configId).toBeNull();
  });

  it("falls back to the account the operator holds for this carrier", async () => {
    store.credential = credential({
      source: "tenant",
      secret: "held-for-them",
      settings: { providerCode: "mock", baseUrl: "https://held.example" },
    });

    const [provider] = await resolvePollProviders();

    expect(provider.source).toBe("credential");
    expect(provider.configId).toBeNull();
    expect(provider.credentials.apiKey).toBe("held-for-them");
    expect(provider.credentials.baseUrl).toBe("https://held.example");
  });

  it("names the platform's shared account for what it is", async () => {
    // `credentialFor` reports "platform" for the environment's own key. That
    // is not this carrier's account and must not be reported as one.
    store.credential = credential({
      source: "platform",
      secret: "platform-key",
      settings: { providerCode: "mock", baseUrl: null },
    });

    const [provider] = await resolvePollProviders();

    expect(provider.source).toBe("environment");
  });

  it("still polls when there is no account anywhere", async () => {
    // The simulated fleet in development is exactly this case, and it has to
    // keep working — with the adapter named rather than guessed.
    env.current.GPS_PROVIDER = "mock";

    const [provider] = await resolvePollProviders();

    expect(provider.source).toBe("environment");
    expect(provider.code).toBe("mock");
    expect(provider.credentials.apiKey).toBeNull();
    expect(provider.pollIntervalSeconds).toBe(30);
  });

  it("never hands a webhook secret to a pull", async () => {
    store.credential = credential({
      source: "tenant",
      secret: "held-for-them",
      settings: { providerCode: "mock", baseUrl: null },
    });

    const [provider] = await resolvePollProviders();

    expect(provider.credentials.webhookSecret).toBeNull();
  });
});

describe("isDue", () => {
  const base = {
    source: "config" as const,
    configId: "cfg_1",
    code: "mock",
    credentials: { baseUrl: null, apiKey: null, webhookSecret: null },
    pollIntervalSeconds: 60,
  };

  it("is due when it has never been polled", () => {
    expect(isDue({ ...base, lastPolledAt: null })).toBe(true);
  });

  it("is not due inside its own interval", () => {
    const now = new Date("2026-08-30T10:00:00Z");
    const lastPolledAt = new Date("2026-08-30T09:59:30Z");

    expect(isDue({ ...base, lastPolledAt }, now)).toBe(false);
  });

  it("is due once its interval has elapsed", () => {
    const now = new Date("2026-08-30T10:00:00Z");
    const lastPolledAt = new Date("2026-08-30T09:59:00Z");

    expect(isDue({ ...base, lastPolledAt }, now)).toBe(true);
  });

  it("is due when the clock has gone backwards", () => {
    // A resumed VM or an NTP correction would otherwise park a vendor until
    // the future the row thinks it is in arrives.
    const now = new Date("2026-08-30T10:00:00Z");
    const lastPolledAt = new Date("2026-08-30T11:00:00Z");

    expect(isDue({ ...base, lastPolledAt }, now)).toBe(true);
  });
});
