import Decimal from "decimal.js";
import { dec, money, type MoneyIn } from "./ageing";

/**
 * The tax side of a filing-grade invoice.
 *
 * Pure, because everything here is a rule an auditor will read back to
 * you: whether a supply is intra-state, how the same GST rate splits into
 * CGST and SGST, and what the rate-wise summary at the foot of the invoice
 * has to add up to. None of it should need a database to be provable.
 */

/** The default SAC for goods transport by road (GTA). */
export const GTA_SAC = "996791";

/**
 * The two-digit GST state code out of whatever we hold.
 *
 * A GSTIN's first two characters are the state code, which is the most
 * reliable source there is — a place of supply typed as "Rajasthan" and
 * one typed as "RAJASTHAN " are the same state, and comparing strings
 * would say otherwise.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const trimmed = gstin.trim();
  if (trimmed.length < 2) return null;
  const code = trimmed.slice(0, 2);
  return /^[0-9]{2}$/.test(code) ? code : null;
}

/** Normalises a state name for comparison. Nulls stay null. */
function normaliseState(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, " ");
  return cleaned === "" ? null : cleaned;
}

export type SupplyParties = {
  /** The branch raising the invoice. */
  sellerGstin?: string | null;
  sellerStateCode?: string | null;
  sellerStateName?: string | null;
  /** The customer being billed. */
  buyerGstin?: string | null;
  /** What the invoice states as the place of supply, name or code. */
  placeOfSupply?: string | null;
  buyerStateCode?: string | null;
  buyerStateName?: string | null;
};

export type SupplyPlace = {
  /** True when CGST and SGST apply, false when IGST does. */
  isIntraState: boolean;
  /** What the invoice prints as "Place of supply". */
  placeOfSupply: string | null;
  sellerStateCode: string | null;
  buyerStateCode: string | null;
  /**
   * True when neither side could be pinned to a state. The invoice still
   * prints — refusing to would be worse — but it says so rather than
   * silently claiming an intra-state supply.
   */
  isUndetermined: boolean;
};

/**
 * Where the supply lands.
 *
 * GST codes first, state names second. Falling back the other way round
 * would let an unregistered buyer in the same state as a differently-named
 * city read as inter-state.
 */
export function resolveSupplyPlace(parties: SupplyParties): SupplyPlace {
  const sellerCode =
    stateCodeFromGstin(parties.sellerGstin) ?? parties.sellerStateCode ?? null;

  const placeCode =
    (parties.placeOfSupply && /^[0-9]{2}$/.test(parties.placeOfSupply.trim())
      ? parties.placeOfSupply.trim()
      : null) ??
    stateCodeFromGstin(parties.buyerGstin) ??
    parties.buyerStateCode ??
    null;

  const placeOfSupply =
    parties.placeOfSupply?.trim() || parties.buyerStateName?.trim() || null;

  if (sellerCode && placeCode) {
    return {
      isIntraState: sellerCode === placeCode,
      placeOfSupply,
      sellerStateCode: sellerCode,
      buyerStateCode: placeCode,
      isUndetermined: false,
    };
  }

  const sellerName = normaliseState(parties.sellerStateName);
  const buyerName =
    normaliseState(parties.placeOfSupply) ?? normaliseState(parties.buyerStateName);

  if (sellerName && buyerName) {
    return {
      isIntraState: sellerName === buyerName,
      placeOfSupply,
      sellerStateCode: sellerCode,
      buyerStateCode: placeCode,
      isUndetermined: false,
    };
  }

  // Nothing to go on. Treat it as inter-state, which states the whole tax
  // as IGST in one line rather than inventing a CGST/SGST split that would
  // be wrong in two columns instead of one.
  return {
    isIntraState: false,
    placeOfSupply,
    sellerStateCode: sellerCode,
    buyerStateCode: placeCode,
    isUndetermined: true,
  };
}

export type TaxSplit = {
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
};

/**
 * Splits one tax figure into its heads.
 *
 * The halves are rounded independently and the remainder is pushed onto
 * CGST, so `cgst + sgst` always equals the figure that was split. Halving
 * and rounding both sides is how an invoice ends up a paisa short of its
 * own total.
 */
export function splitTax(taxAmount: MoneyIn, isIntraState: boolean): TaxSplit {
  const total = money(dec(taxAmount));

  if (!isIntraState) {
    return { cgst: new Decimal(0), sgst: new Decimal(0), igst: total };
  }

  const cgst = money(total.dividedBy(2));
  return { cgst, sgst: money(total.minus(cgst)), igst: new Decimal(0) };
}

export type TaxableLine = {
  amount: MoneyIn;
  taxPercent?: MoneyIn;
  taxAmount?: MoneyIn;
  hsnSac?: string | null;
};

export type TaxSummaryRow = {
  /** Blank rather than "null" when a line carries no code. */
  hsnSac: string;
  ratePercent: Decimal;
  taxableValue: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  total: Decimal;
};

/**
 * The rate-wise summary printed at the foot of a tax invoice.
 *
 * Grouped by HSN/SAC and rate, which is what GSTR-1 wants — one row per
 * combination, never one row per line, or a fifty-consignment consolidated
 * invoice prints fifty identical summary rows.
 */
export function taxSummary(
  lines: TaxableLine[],
  isIntraState: boolean,
): { rows: TaxSummaryRow[]; totals: TaxSummaryRow } {
  const grouped = new Map<
    string,
    { hsnSac: string; ratePercent: Decimal; taxableValue: Decimal; tax: Decimal }
  >();

  for (const line of lines) {
    const hsnSac = line.hsnSac?.trim() || "";
    const ratePercent = dec(line.taxPercent).toDecimalPlaces(3);
    const key = `${hsnSac}|${ratePercent.toFixed(3)}`;

    const bucket = grouped.get(key) ?? {
      hsnSac,
      ratePercent,
      taxableValue: new Decimal(0),
      tax: new Decimal(0),
    };

    bucket.taxableValue = bucket.taxableValue.plus(dec(line.amount));
    bucket.tax = bucket.tax.plus(dec(line.taxAmount));
    grouped.set(key, bucket);
  }

  const rows = [...grouped.values()]
    .map((bucket) => {
      const taxableValue = money(bucket.taxableValue);
      const split = splitTax(bucket.tax, isIntraState);
      return {
        hsnSac: bucket.hsnSac,
        ratePercent: bucket.ratePercent,
        taxableValue,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        total: money(split.cgst.plus(split.sgst).plus(split.igst)),
      };
    })
    .sort((a, b) =>
      a.hsnSac === b.hsnSac
        ? a.ratePercent.comparedTo(b.ratePercent)
        : a.hsnSac.localeCompare(b.hsnSac),
    );

  const totals = rows.reduce<TaxSummaryRow>(
    (sum, row) => ({
      hsnSac: "",
      ratePercent: new Decimal(0),
      taxableValue: sum.taxableValue.plus(row.taxableValue),
      cgst: sum.cgst.plus(row.cgst),
      sgst: sum.sgst.plus(row.sgst),
      igst: sum.igst.plus(row.igst),
      total: sum.total.plus(row.total),
    }),
    {
      hsnSac: "",
      ratePercent: new Decimal(0),
      taxableValue: new Decimal(0),
      cgst: new Decimal(0),
      sgst: new Decimal(0),
      igst: new Decimal(0),
      total: new Decimal(0),
    },
  );

  return {
    rows,
    totals: {
      ...totals,
      taxableValue: money(totals.taxableValue),
      cgst: money(totals.cgst),
      sgst: money(totals.sgst),
      igst: money(totals.igst),
      total: money(totals.total),
    },
  };
}

/**
 * The declaration a reverse-charge invoice must carry.
 *
 * The tax is stated so the recipient knows what to pay, and is not added
 * to the total, because it is not ours to collect. `totals.ts` already
 * enforces the arithmetic; this is the sentence that has to appear beside
 * it on the paper.
 */
export const REVERSE_CHARGE_DECLARATION =
  "Tax payable by the recipient under reverse charge (GTA service, " +
  "Notification 13/2017-Central Tax (Rate)). The tax stated above is not " +
  "included in the invoice total and has not been collected.";

export const FORWARD_CHARGE_DECLARATION =
  "Tax on this invoice is payable by the supplier under forward charge.";
