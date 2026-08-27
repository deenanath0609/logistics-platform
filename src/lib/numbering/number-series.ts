import { prisma } from "@/lib/prisma";
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
  client: Pick<
    typeof prisma,
    "$queryRaw" | "$executeRaw" | "numberSeries"
  > = prisma,
): Promise<string> {
  const at = options.at ?? new Date();
  const branchId = options.branchId ?? null;

  // Serialise everyone competing for this counter.
  //
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and the
  // driver adapter cannot deserialise a void column.
  const lockKey = `number-series:${options.document}:${branchId ?? "network"}`;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const series = await client.numberSeries.findFirst({
    where: { document: options.document, branchId, isActive: true },
  });

  if (!series) {
    throw new Error(
      `No active number series configured for ${options.document}` +
        (branchId ? ` at branch ${branchId}` : ""),
    );
  }

  const periodKey = periodKeyFor(series.resetPolicy, at);
  const rolledOver = series.periodKey !== periodKey;
  const sequence = rolledOver ? 1 : series.currentValue + 1;

  await client.numberSeries.update({
    where: { id: series.id },
    data: { currentValue: sequence, periodKey },
  });

  return renderPattern(series.pattern, {
    prefix: series.prefix,
    branchCode: options.branchCode,
    sequence,
    padding: series.padding,
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
