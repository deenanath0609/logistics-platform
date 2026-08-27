import { describe, it, expect } from "vitest";
import {
  bucketKey,
  cutoffsFor,
  emptyCarry,
  planRetention,
  reductionRatio,
  retentionPolicy,
  windowFor,
  DEFAULT_ARCHIVE_DAYS,
  DEFAULT_RETENTION_DAYS,
  DOWNSAMPLE_BUCKET_MINUTES,
  type RetainablePing,
  type RetentionWindow,
} from "./retention";

/**
 * The selection, proved without a database.
 *
 * The one property worth more than all the others: a cold trail is
 * *thinned*, never erased. Six months after a delivery, an insurance
 * assessor asking where the vehicle was between two and five o'clock has
 * to get an answer, and these tests are what say they will.
 */

const NOW = new Date("2026-08-27T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

function windowAt(overrides: Partial<RetentionWindow> = {}): RetentionWindow {
  return {
    now: NOW,
    retentionDays: DEFAULT_RETENTION_DAYS,
    archiveDays: DEFAULT_ARCHIVE_DAYS,
    bucketMinutes: DOWNSAMPLE_BUCKET_MINUTES,
    ...overrides,
  };
}

/** A ping `daysAgo` days and `plusMs` milliseconds back from `NOW`. */
function ping(
  id: string,
  daysAgo: number,
  plusMs = 0,
  extra: Partial<RetainablePing> = {},
): RetainablePing {
  return {
    id,
    deviceId: extra.deviceId ?? "dev-1",
    recordedAt: new Date(NOW.getTime() - daysAgo * DAY + plusMs),
    ignition: extra.ignition,
  };
}

/** A device reporting every 30 seconds for `minutes`, `daysAgo` back. */
function trail(
  deviceId: string,
  daysAgo: number,
  minutes: number,
  options: { everySeconds?: number; ignition?: boolean } = {},
): RetainablePing[] {
  const every = (options.everySeconds ?? 30) * 1_000;
  const start = NOW.getTime() - daysAgo * DAY;
  const out: RetainablePing[] = [];

  for (let offset = 0; offset < minutes * MINUTE; offset += every) {
    out.push({
      id: `${deviceId}:${offset}`,
      deviceId,
      recordedAt: new Date(start + offset),
      ignition: options.ignition,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Bands
// ────────────────────────────────────────────────────────────

describe("cutoffsFor", () => {
  it("puts the hot horizon at retentionDays and the archive at archiveDays", () => {
    const { hot, archive } = cutoffsFor(windowAt());

    expect(hot.getTime()).toBe(NOW.getTime() - DEFAULT_RETENTION_DAYS * DAY);
    expect(archive.getTime()).toBe(NOW.getTime() - DEFAULT_ARCHIVE_DAYS * DAY);
  });

  it("pushes the archive horizon out of reach when it is not finite", () => {
    const { archive } = cutoffsFor(windowAt({ archiveDays: Number.POSITIVE_INFINITY }));
    // Nothing real can precede it, so nothing is ever expired.
    expect(archive.getTime()).toBeLessThan(new Date("1900-01-01").getTime());
  });
});

describe("planRetention — bands", () => {
  it("leaves everything inside the retention window untouched", () => {
    const pings = trail("dev-1", 1, 10);
    const plan = planRetention(pings, windowAt());

    expect(plan.keep).toHaveLength(pings.length);
    expect(plan.downsample).toHaveLength(0);
    expect(plan.expire).toHaveLength(0);
  });

  it("keeps a fix on the retention boundary itself hot", () => {
    // A ping exactly `retentionDays` old is inside the window: the
    // comparison is `>=`, so the boundary second is never the second
    // something quietly loses resolution.
    const onBoundary = ping("edge", DEFAULT_RETENTION_DAYS);
    const plan = planRetention([onBoundary], windowAt());

    expect(plan.keep).toEqual(["edge"]);
  });

  it("expires only what is past the archive horizon", () => {
    const plan = planRetention(
      [
        ping("ancient", DEFAULT_ARCHIVE_DAYS + 1),
        ping("old", DEFAULT_ARCHIVE_DAYS - 1),
        ping("recent", 2),
      ],
      windowAt(),
    );

    expect(plan.expire).toEqual(["ancient"]);
    expect(plan.keep).toContain("recent");
    expect([...plan.keep, ...plan.downsample]).toContain("old");
  });

  it("expires nothing when the archive horizon is infinite", () => {
    const plan = planRetention(
      [ping("ancient", 5_000)],
      windowAt({ archiveDays: Number.POSITIVE_INFINITY }),
    );

    expect(plan.expire).toHaveLength(0);
    expect(plan.keep).toEqual(["ancient"]);
  });
});

// ────────────────────────────────────────────────────────────
// Downsampling — the point of the module
// ────────────────────────────────────────────────────────────

describe("planRetention — downsampling", () => {
  it("downsamples rather than deletes: an hour of cold trail still has a fix every five minutes", () => {
    const pings = trail("dev-1", 120, 60); // 120 days old, 2 fixes a minute.
    const plan = planRetention(pings, windowAt());

    expect(plan.expire).toHaveLength(0);
    expect(pings).toHaveLength(120);

    // One per five-minute bucket over an hour.
    expect(plan.keep).toHaveLength(12);
    expect(plan.downsample).toHaveLength(108);

    // And the survivors are spread across the hour, not clustered at one
    // end — this is what makes the remnant a trail rather than a stub.
    const kept = new Set(plan.keep);
    const kise = pings.filter((p) => kept.has(p.id));
    const gaps = kise
      .slice(1)
      .map((p, i) => p.recordedAt.getTime() - kise[i].recordedAt.getTime());
    expect(Math.max(...gaps)).toBe(5 * MINUTE);
  });

  it("keeps the earliest fix of each bucket, so the choice is stable", () => {
    const pings = trail("dev-1", 200, 15);
    const plan = planRetention(pings, windowAt());

    const kept = new Set(plan.keep);
    for (const survivor of pings.filter((p) => kept.has(p.id))) {
      const bucket = bucketKey(survivor.recordedAt, DOWNSAMPLE_BUCKET_MINUTES);
      const sameBucket = pings.filter(
        (p) => bucketKey(p.recordedAt, DOWNSAMPLE_BUCKET_MINUTES) === bucket,
      );
      const earliest = sameBucket.reduce((a, b) =>
        a.recordedAt <= b.recordedAt ? a : b,
      );
      expect(survivor.id).toBe(earliest.id);
    }
  });

  it("is idempotent — a second pass over the survivors removes nothing", () => {
    const pings = trail("dev-1", 150, 30);
    const first = planRetention(pings, windowAt());

    const survivors = pings.filter((p) => new Set(first.keep).has(p.id));
    const second = planRetention(survivors, windowAt());

    expect(second.downsample).toHaveLength(0);
    expect(second.expire).toHaveLength(0);
    expect(second.keep.sort()).toEqual([...first.keep].sort());
  });

  it("thins each device on its own — a busy vehicle cannot use up another's budget", () => {
    const pings = [
      ...trail("dev-1", 150, 10),
      ...trail("dev-2", 150, 10),
    ];
    const plan = planRetention(pings, windowAt());

    const kept = new Set(plan.keep);
    const perDevice = (deviceId: string) =>
      pings.filter((p) => p.deviceId === deviceId && kept.has(p.id)).length;

    expect(perDevice("dev-1")).toBe(2);
    expect(perDevice("dev-2")).toBe(2);
  });

  it("does not depend on the order the rows arrive in", () => {
    const pings = trail("dev-1", 150, 20);
    const shuffled = [...pings].reverse();

    const forwards = planRetention(pings, windowAt());
    const backwards = planRetention(shuffled, windowAt());

    expect([...backwards.keep].sort()).toEqual([...forwards.keep].sort());
    expect([...backwards.downsample].sort()).toEqual(
      [...forwards.downsample].sort(),
    );
  });

  it("honours a coarser or finer bucket", () => {
    const pings = trail("dev-1", 150, 60);

    expect(planRetention(pings, windowAt({ bucketMinutes: 1 })).keep).toHaveLength(60);
    expect(planRetention(pings, windowAt({ bucketMinutes: 15 })).keep).toHaveLength(4);
  });
});

describe("planRetention — ignition transitions", () => {
  it("keeps both edges of a stop, so a detention claim survives downsampling", () => {
    // Engine on for two minutes, off for six, on again. At a five-minute
    // grid the two transitions would both fall inside a bucket and be
    // lost; they are kept explicitly.
    const start = NOW.getTime() - 200 * DAY;
    const pings: RetainablePing[] = [];
    for (let i = 0; i < 20; i++) {
      pings.push({
        id: `p${i}`,
        deviceId: "dev-1",
        recordedAt: new Date(start + i * 30_000),
        ignition: i < 4 ? true : i < 16 ? false : true,
      });
    }

    const plan = planRetention(pings, windowAt());
    const kept = new Set(plan.keep);

    // p4 is the switch-off, p16 the switch-on. Neither begins a bucket.
    expect(bucketKey(pings[4].recordedAt, 5)).toBe(
      bucketKey(pings[3].recordedAt, 5),
    );
    expect(kept.has("p4")).toBe(true);
    expect(kept.has("p16")).toBe(true);
  });

  it("does not invent a transition from a fix that carries no ignition", () => {
    const pings = trail("dev-1", 150, 10); // ignition undefined throughout
    const plan = planRetention(pings, windowAt());

    expect(plan.keep).toHaveLength(2);
  });
});

describe("planRetention — paging", () => {
  it("plans a device in pages without double-counting a bucket at the seam", () => {
    const pings = trail("dev-1", 150, 30);
    const whole = planRetention(pings, windowAt());

    // Split mid-bucket, which is exactly where a naive per-page plan keeps
    // a second fix it should not have.
    const cut = 13;
    const first = planRetention(pings.slice(0, cut), windowAt());
    const second = planRetention(pings.slice(cut), windowAt(), first.carry);

    expect([...first.keep, ...second.keep].sort()).toEqual([...whole.keep].sort());
    expect([...first.downsample, ...second.downsample].sort()).toEqual(
      [...whole.downsample].sort(),
    );
  });

  it("starts from an empty carry by default", () => {
    const carry = emptyCarry();
    expect(carry.lastBucket.size).toBe(0);
    expect(carry.lastIgnition.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// Policy
// ────────────────────────────────────────────────────────────

describe("retentionPolicy", () => {
  const KEYS = ["GPS_RETENTION_DAYS", "GPS_ARCHIVE_DAYS"] as const;

  function withEnv<T>(values: Partial<Record<(typeof KEYS)[number], string>>, fn: () => T): T {
    const before = KEYS.map((key) => [key, process.env[key]] as const);
    try {
      for (const key of KEYS) {
        const value = values[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return fn();
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("defaults to 90 days hot and 400 days archived", () => {
    const policy = withEnv({}, () => retentionPolicy());
    expect(policy.retentionDays).toBe(90);
    expect(policy.archiveDays).toBe(400);
    expect(policy.bucketMinutes).toBe(5);
  });

  it("reads whole positive days from the environment", () => {
    const policy = withEnv(
      { GPS_RETENTION_DAYS: "30", GPS_ARCHIVE_DAYS: "730" },
      () => retentionPolicy(),
    );
    expect(policy.retentionDays).toBe(30);
    expect(policy.archiveDays).toBe(730);
  });

  it("falls back rather than refusing to boot on a nonsense value", () => {
    const policy = withEnv({ GPS_RETENTION_DAYS: "ninety" }, () => retentionPolicy());
    expect(policy.retentionDays).toBe(90);
  });

  it("refuses to delete hot data when the horizons are configured backwards", () => {
    const policy = withEnv(
      { GPS_RETENTION_DAYS: "90", GPS_ARCHIVE_DAYS: "30" },
      () => retentionPolicy(),
    );

    expect(Number.isFinite(policy.archiveDays)).toBe(false);

    const plan = planRetention([ping("old", 200)], windowFor(policy, NOW));
    expect(plan.expire).toHaveLength(0);
  });
});

describe("reductionRatio", () => {
  it("is zero for an empty plan and reports what a pass removed", () => {
    expect(reductionRatio({ keep: [], downsample: [], expire: [] })).toBe(0);
    expect(
      reductionRatio({ keep: ["a"], downsample: ["b", "c"], expire: ["d"] }),
    ).toBe(0.75);
  });
});
