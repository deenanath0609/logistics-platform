import { prisma, type Db } from "@/lib/prisma";
import { TenantContextError, resolveTenant } from "@/lib/tenant";
import type { SeriesDocument, SeriesReset } from "@/generated/prisma/client";

/**
 * Document numbering.
 *
 * Counters are read and incremented inside a transaction holding a Postgres
 * advisory lock keyed on the series. Two clerks booking at the same instant
 * therefore get different LR numbers — which `MAX(id) + 1` does not
 * guarantee, and which you only discover on your first busy morning.
 */

export type PatternTokens = {
  prefix?: string | null;
  branchCode?: string | null;
  sequence: number;
  padding: number;
  at: Date;
};

/** Indian financial year: April to March, rendered "2627" for 2026–27. */
export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

/** The period a counter belongs to. A different key resets it to 1. */
export function periodKeyFor(policy: SeriesReset, at: Date): string {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");

  switch (policy) {
    case "DAILY":
      return `${yyyy}-${mm}-${dd}`;
    case "MONTHLY":
      return `${yyyy}-${mm}`;
    case "FINANCIAL_YEAR":
      return financialYear(at);
    case "NEVER":
    default:
      return "ALL";
  }
}

/**
 * Renders a pattern. Tokens:
 * `{PREFIX} {BRANCH} {YYYY} {YY} {MM} {DD} {FY} {SEQ}`
 */
export function renderPattern(pattern: string, tokens: PatternTokens): string {
  const { at } = tokens;

  const replacements: Record<string, string> = {
    PREFIX: tokens.prefix ?? "",
    BRANCH: tokens.branchCode ?? "",
    YYYY: String(at.getFullYear()),
    YY: String(at.getFullYear()).slice(-2),
    MM: String(at.getMonth() + 1).padStart(2, "0"),
    DD: String(at.getDate()).padStart(2, "0"),
    FY: financialYear(at),
    SEQ: String(tokens.sequence).padStart(tokens.padding, "0"),
  };

  return pattern.replace(/\{([A-Z]+)\}/g, (whole, token: string) =>
    token in replacements ? replacements[token] : whole,
  );
}

export type NextNumberOptions = {
  document: SeriesDocument;
  /** Omit for a network-wide series. */
  branchId?: string | null;
  branchCode?: string | null;
  /** Override "now" — used by tests and by backdated entries. */
  at?: Date;
};

/**
 * Issues the next number for a document.
 *
 * Call this inside the same transaction as the record it numbers, so an
 * abandoned booking does not burn a number: pass the transaction client as
 * `client`. Without it, the number is consumed even if the caller later fails.
 */
export async function nextNumber(
  options: NextNumberOptions,
  // Narrower than `DbOrTx`: the lock and the counter are all this touches.
  client: Pick<Db, "$executeRaw" | "numberSeries"> = prisma,
): Promise<string> {
  const at = options.at ?? new Date();
  const branchId = options.branchId ?? null;

  // The lock has to name the row it protects, and since multi-tenancy that
  // row belongs to one organisation — the `findFirst` below is filtered to
  // it by the tenant extension. An org-less key is wider than the thing it
  // guards: every carrier booking against a network-wide series would queue
  // on the same lock, so one carrier's busy morning would throttle
  // everybody else's for no benefit, since the counters were never shared.
  // Nothing about that is visible from outside — the numbers stay correct
  // and only the throughput quietly is not.
  const tenant = await resolveTenant();
  if (!tenant) {
    throw new TenantContextError(
      "nextNumber() ran with no tenant context; the counter lock cannot be " +
        "scoped to an organisation. Wrap the job in runWithTenant().",
    );
  }

  // Which series applies, before taking the lock — because the lock has to
  // name the row it protects, and that row is not knowable from the request
  // alone.
  //
  // A branch may have its own counter; most do not. Asking for
  // `branchId: <branch>` exactly, and failing when only the network-wide row
  // exists, is what stopped delivery runs being created at all on a default
  // tenant: the seed writes network-wide series, `createDeliveryRun` is the
  // one caller that passes a branch, and every attempt threw. The whole
  // last-mile module had no rows because of this line.
  const candidates = await client.numberSeries.findMany({
    where: {
      document: options.document,
      isActive: true,
      OR: [{ branchId }, { branchId: null }],
    },
  });

  // A branch's own counter wins where it exists; otherwise the network one.
  const series =
    candidates.find((row) => branchId !== null && row.branchId === branchId) ??
    candidates.find((row) => row.branchId === null) ??
    null;

  if (!series) {
    throw new Error(
      `No active number series configured for ${options.document}` +
        (branchId ? ` at branch ${branchId}, and none network-wide` : ""),
    );
  }

  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and the
  // driver adapter cannot deserialise a void column.
  //
  // Keyed on the series actually chosen, not on the branch asked for. Two
  // branches that both fall back to the network counter must queue on the
  // same lock — keying it on the branch would give them different locks over
  // one row, which is the race this lock exists to prevent.
  const lockKey = `number-series:${tenant.orgId}:${series.id}`;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  // Re-read under the lock: the row above was read without it, and another
  // transaction may have consumed a number in between.
  const locked = await client.numberSeries.findFirst({ where: { id: series.id } });
  if (!locked) {
    throw new Error(
      `The ${options.document} number series was removed while a number was being issued.`,
    );
  }

  const periodKey = periodKeyFor(locked.resetPolicy, at);
  const rolledOver = locked.periodKey !== periodKey;
  const sequence = rolledOver ? 1 : locked.currentValue + 1;

  await client.numberSeries.update({
    where: { id: locked.id },
    data: { currentValue: sequence, periodKey },
  });

  return renderPattern(locked.pattern, {
    prefix: locked.prefix,
    branchCode: options.branchCode,
    sequence,
    padding: locked.padding,
    at,
  });
}

/** What the next number would look like, without consuming one. */
export function previewNext(
  series: {
    pattern: string;
    prefix: string | null;
    padding: number;
    resetPolicy: SeriesReset;
    currentValue: number;
    periodKey: string | null;
  },
  branchCode?: string,
  at: Date = new Date(),
): string {
  const rolledOver = series.periodKey !== periodKeyFor(series.resetPolicy, at);

  return renderPattern(series.pattern, {
    prefix: series.prefix,
    branchCode: branchCode ?? "BRN",
    sequence: rolledOver ? 1 : series.currentValue + 1,
    padding: series.padding,
    at,
  });
}
