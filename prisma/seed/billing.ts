import { db, step, done } from "./client";
import { BILLING_NUMBER_SERIES } from "../../src/lib/billing/default-series";

/**
 * Finance document number series.
 *
 * `CREDIT_NOTE` in particular has never been seeded, and `createCreditNote`
 * has always called `nextNumber({ document: "CREDIT_NOTE" })` — which throws
 * when no series row exists. On a fresh database the first credit note a
 * clerk tried to raise would have failed with an error about a missing
 * series, at exactly the moment somebody was trying to correct a bill.
 *
 * Idempotent, and never resets `currentValue`: re-running this must not
 * re-issue a number already printed on a document someone is holding.
 */
export async function seedBillingSeries(orgId: string) {
  step("finance number series");

  let created = 0;

  for (const series of BILLING_NUMBER_SERIES) {
    // Not an upsert: `branchId` is null on these network-wide series, and a
    // compound unique containing a null cannot be a `where` target.
    const existing = await db.numberSeries.findFirst({
      where: { orgId, document: series.document, branchId: null },
    });

    const data = {
      pattern: series.pattern,
      prefix: series.prefix,
      padding: series.padding,
      resetPolicy: series.resetPolicy,
    };

    if (existing) {
      await db.numberSeries.update({ where: { id: existing.id }, data });
    } else {
      await db.numberSeries.create({
        data: { orgId, document: series.document, ...data },
      });
      created++;
    }
  }

  done(`${created} new, ${BILLING_NUMBER_SERIES.length - created} refreshed`);
}
