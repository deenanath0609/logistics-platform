/**
 * Inbound reconciliation.
 *
 * Given what a manifest says was sent and what a dock actually scanned,
 * this decides — with no database, no clock and no side effects — which
 * packages are missing, which arrived unannounced, and which tallied.
 *
 * It is pure on purpose. The behaviour BRD §A.6 asks for ("at close,
 * unscanned lines become SHORT and unexpected scans become EXCESS,
 * automatically") is the one piece of this module that decides who owes
 * whom money, so it must be exhaustively testable without a hub, a
 * scanner gun, or a Postgres instance. `closeReceipt` in ./receipt.ts is
 * a thin wrapper that fetches rows, calls this, and writes what it says.
 *
 * The same function closes a loading sheet: "scanned but not loaded" is
 * an excess and "loaded but not scanned" is a shortage, which is exactly
 * the shape below.
 */

/** One manifest line: what the dispatching branch says it put on the truck. */
export type ExpectedLine = {
  shipmentId: string;
  /** For messages and discrepancy rows; not used in matching. */
  lrNumber?: string;
  /**
   * Barcodes of the packages on this line. May be shorter than
   * `expectedPackages` when a consignment was manifested at consignment
   * level and its packages were never individually labelled.
   */
  barcodes: string[];
  /** The declared count. Authoritative when it exceeds `barcodes.length`. */
  expectedPackages: number;
};

/** One physical barcode read at the dock. */
export type ActualScan = {
  barcode: string;
  /** Resolved by the scan path; null when the barcode matched nothing. */
  packageId?: string | null;
  /** The shipment the barcode really belongs to, wherever it belongs. */
  shipmentId?: string | null;
  /** Device clock. Used only for ordering and reporting. */
  scannedAt?: Date | null;
  /** Set by the scan path when the operator flagged the package damaged. */
  isDamaged?: boolean;
};

export type MatchedPackage = {
  barcode: string;
  packageId: string | null;
  shipmentId: string;
  lrNumber?: string;
  scannedAt: Date | null;
  /** How many times this barcode was read. Always at least 1. */
  scanCount: number;
};

export type ShortPackage = {
  shipmentId: string;
  lrNumber?: string;
  /**
   * Null when the line declared more packages than it had barcodes for —
   * we know a box is missing but cannot name it. Still a shortage.
   */
  barcode: string | null;
};

export type ExcessReason =
  /** The barcode is not in the system at all. */
  | "UNKNOWN"
  /** A real package, but it belongs to a shipment not on this manifest. */
  | "NOT_ON_MANIFEST";

export type ExcessPackage = {
  barcode: string;
  packageId: string | null;
  shipmentId: string | null;
  reason: ExcessReason;
  scannedAt: Date | null;
  scanCount: number;
};

/** Per-shipment roll-up, which is what the receipt screen ticks green. */
export type LineOutcome = {
  shipmentId: string;
  lrNumber?: string;
  expectedPackages: number;
  scannedPackages: number;
  shortPackages: number;
  /** True when every declared package was accounted for. */
  isComplete: boolean;
};

export type ReconcileResult = {
  matched: MatchedPackage[];
  short: ShortPackage[];
  excess: ExcessPackage[];
  /** Repeat reads of a barcode already counted. Not an error, just noise. */
  duplicateScans: Array<{ barcode: string; extraReads: number }>;
  lines: LineOutcome[];
  totals: {
    expectedShipments: number;
    expectedPackages: number;
    /** Distinct barcodes read, including unexpected ones. */
    scannedPackages: number;
    /** Distinct expected barcodes read. */
    matchedPackages: number;
    shortPackages: number;
    excessPackages: number;
    damagedPackages: number;
  };
  /** True when nothing is short and nothing is excess. */
  isClean: boolean;
};

/**
 * Barcodes are printed, photographed, and typed by hand at 6am. Compare
 * them case-insensitively with surrounding whitespace stripped, or the
 * same box is short and excess at once.
 */
export function normaliseBarcode(barcode: string): string {
  return barcode.trim().toUpperCase();
}

export function reconcile(
  expected: readonly ExpectedLine[],
  actual: readonly ActualScan[],
): ReconcileResult {
  // ── Index the expectation ─────────────────────────────────
  // barcode → the line that expects it. A barcode appearing on two lines
  // of the same manifest is impossible (barcodes are unique per package),
  // so first writer wins and the duplicate is simply never matched twice.
  const expectedByBarcode = new Map<string, ExpectedLine>();
  const expectedShipments = new Set<string>();

  for (const line of expected) {
    expectedShipments.add(line.shipmentId);
    for (const raw of line.barcodes) {
      const barcode = normaliseBarcode(raw);
      if (!expectedByBarcode.has(barcode)) expectedByBarcode.set(barcode, line);
    }
  }

  // ── Fold the scans ────────────────────────────────────────
  // One entry per distinct barcode, holding the first read and a count.
  // The gun fires twice when a hand slips; that is a duplicate, not an
  // extra package, and counting it as one would invent an excess.
  type Read = {
    barcode: string;
    packageId: string | null;
    shipmentId: string | null;
    scannedAt: Date | null;
    isDamaged: boolean;
    count: number;
  };

  const reads = new Map<string, Read>();

  for (const scan of actual) {
    const barcode = normaliseBarcode(scan.barcode);
    if (barcode === "") continue;

    const existing = reads.get(barcode);
    if (existing) {
      existing.count += 1;
      // A later read that resolved the barcode wins over an earlier one
      // that did not — the offline queue sometimes syncs an unresolved
      // scan before the booking it belongs to has replicated.
      existing.packageId ??= scan.packageId ?? null;
      existing.shipmentId ??= scan.shipmentId ?? null;
      existing.isDamaged ||= scan.isDamaged ?? false;
      continue;
    }

    reads.set(barcode, {
      barcode,
      packageId: scan.packageId ?? null,
      shipmentId: scan.shipmentId ?? null,
      scannedAt: scan.scannedAt ?? null,
      isDamaged: scan.isDamaged ?? false,
      count: 1,
    });
  }

  // ── Split into matched and excess ─────────────────────────
  const matched: MatchedPackage[] = [];
  const excess: ExcessPackage[] = [];
  const matchedBarcodes = new Set<string>();
  const scannedPerShipment = new Map<string, number>();

  for (const read of reads.values()) {
    const line = expectedByBarcode.get(read.barcode);

    if (line) {
      matchedBarcodes.add(read.barcode);
      matched.push({
        barcode: read.barcode,
        packageId: read.packageId,
        shipmentId: line.shipmentId,
        lrNumber: line.lrNumber,
        scannedAt: read.scannedAt,
        scanCount: read.count,
      });
      scannedPerShipment.set(
        line.shipmentId,
        (scannedPerShipment.get(line.shipmentId) ?? 0) + 1,
      );
      continue;
    }

    excess.push({
      barcode: read.barcode,
      packageId: read.packageId,
      shipmentId: read.shipmentId,
      // A barcode the system knows but this manifest does not is a
      // misroute — someone else's box on this truck. A barcode nothing
      // knows is a foreign label or a misread. Both are excess; the
      // reason is what tells the branch which conversation to have.
      reason: read.packageId || read.shipmentId ? "NOT_ON_MANIFEST" : "UNKNOWN",
      scannedAt: read.scannedAt,
      scanCount: read.count,
    });
  }

  // ── Everything expected and not seen is short ─────────────
  const short: ShortPackage[] = [];
  const lines: LineOutcome[] = [];

  for (const line of expected) {
    const seen = scannedPerShipment.get(line.shipmentId) ?? 0;

    for (const raw of line.barcodes) {
      const barcode = normaliseBarcode(raw);
      if (matchedBarcodes.has(barcode)) continue;
      short.push({
        shipmentId: line.shipmentId,
        lrNumber: line.lrNumber,
        barcode,
      });
    }

    // The line declared more boxes than it had labels for. The unnamed
    // remainder is still missing goods, and swallowing it would let a
    // three-package consignment arrive as one without complaint.
    const unlabelled = Math.max(0, line.expectedPackages - line.barcodes.length);
    const unlabelledSeen = Math.max(0, seen - line.barcodes.length);
    for (let i = 0; i < unlabelled - unlabelledSeen; i += 1) {
      short.push({
        shipmentId: line.shipmentId,
        lrNumber: line.lrNumber,
        barcode: null,
      });
    }

    const shortForLine = Math.max(0, line.expectedPackages - seen);
    lines.push({
      shipmentId: line.shipmentId,
      lrNumber: line.lrNumber,
      expectedPackages: line.expectedPackages,
      scannedPackages: seen,
      shortPackages: shortForLine,
      isComplete: shortForLine === 0,
    });
  }

  const duplicateScans = [...reads.values()]
    .filter((read) => read.count > 1)
    .map((read) => ({ barcode: read.barcode, extraReads: read.count - 1 }));

  const expectedPackages = expected.reduce(
    (sum, line) => sum + line.expectedPackages,
    0,
  );

  return {
    matched,
    short,
    excess,
    duplicateScans,
    lines,
    totals: {
      expectedShipments: expectedShipments.size,
      expectedPackages,
      scannedPackages: reads.size,
      matchedPackages: matched.length,
      shortPackages: short.length,
      excessPackages: excess.length,
      damagedPackages: [...reads.values()].filter((r) => r.isDamaged).length,
    },
    isClean: short.length === 0 && excess.length === 0,
  };
}

/**
 * One line of plain English for the close-confirmation dialog. An
 * operator about to raise an exception against a sister branch should
 * read what they are about to assert, not a count of rows.
 */
export function describeReconciliation(result: ReconcileResult): string {
  const { totals } = result;

  if (result.isClean) {
    return `All ${totals.expectedPackages} package${totals.expectedPackages === 1 ? "" : "s"} accounted for across ${totals.expectedShipments} shipment${totals.expectedShipments === 1 ? "" : "s"}.`;
  }

  const parts: string[] = [];
  if (totals.shortPackages > 0) {
    parts.push(
      `${totals.shortPackages} short of ${totals.expectedPackages} expected`,
    );
  }
  if (totals.excessPackages > 0) {
    parts.push(
      `${totals.excessPackages} unexpected package${totals.excessPackages === 1 ? "" : "s"}`,
    );
  }

  return `${parts.join(" and ")}. Closing raises these against the dispatching branch.`;
}
