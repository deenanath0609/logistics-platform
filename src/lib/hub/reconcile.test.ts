import { describe, expect, it } from "vitest";
import {
  reconcile,
  normaliseBarcode,
  describeReconciliation,
  type ActualScan,
  type ExpectedLine,
} from "./reconcile";

/**
 * These tests are the specification for BRD §A.6's discrepancy
 * automation. If one of them is wrong, a branch gets blamed for a box it
 * did send — so they are written as the scenarios a dock actually
 * produces, not as coverage of the branches in the file.
 */

/** A manifest line for `count` packages, barcoded CL…-01, -02, … */
function line(
  shipmentId: string,
  lrNumber: string,
  count: number,
  options: { labelled?: number } = {},
): ExpectedLine {
  const labelled = options.labelled ?? count;
  return {
    shipmentId,
    lrNumber,
    expectedPackages: count,
    barcodes: Array.from(
      { length: labelled },
      (_, i) => `${lrNumber}-${String(i + 1).padStart(2, "0")}`,
    ),
  };
}

/** Scans of known packages on the given lines. */
function scansFor(lines: ExpectedLine[], barcodes: string[]): ActualScan[] {
  const owner = new Map<string, string>();
  for (const l of lines) {
    for (const b of l.barcodes) owner.set(b, l.shipmentId);
  }
  return barcodes.map((barcode, i) => ({
    barcode,
    packageId: `pkg-${barcode}`,
    shipmentId: owner.get(barcode) ?? null,
    scannedAt: new Date(2026, 7, 25, 6, 30, i),
  }));
}

// ────────────────────────────────────────────────────────────
// The headline case: 17 expected, 15 scanned
// ────────────────────────────────────────────────────────────

describe("reconcile — a manifest of 17 that arrives as 15", () => {
  // Three consignments: 8 + 5 + 4 = 17 packages.
  const expected = [
    line("s1", "CL2026082500011", 8),
    line("s2", "CL2026082500012", 5),
    line("s3", "CL2026082500013", 4),
  ];

  // Everything except the last box of s2 and the last box of s3.
  const scannedBarcodes = expected
    .flatMap((l) => l.barcodes)
    .filter(
      (b) => b !== "CL2026082500012-05" && b !== "CL2026082500013-04",
    );

  const result = reconcile(expected, scansFor(expected, scannedBarcodes));

  it("counts 15 of 17", () => {
    expect(result.totals.expectedPackages).toBe(17);
    expect(result.totals.matchedPackages).toBe(15);
    expect(result.totals.scannedPackages).toBe(15);
  });

  it("names the two missing boxes rather than reporting a number", () => {
    expect(result.short).toHaveLength(2);
    expect(result.short.map((s) => s.barcode).sort()).toEqual([
      "CL2026082500012-05",
      "CL2026082500013-04",
    ]);
  });

  it("attributes each shortage to its own shipment", () => {
    expect(result.short.find((s) => s.barcode === "CL2026082500012-05")?.shipmentId).toBe("s2");
    expect(result.short.find((s) => s.barcode === "CL2026082500013-04")?.shipmentId).toBe("s3");
  });

  it("raises no excess when nothing unexpected was scanned", () => {
    expect(result.excess).toEqual([]);
  });

  it("marks the untouched line complete and the other two short", () => {
    const byShipment = new Map(result.lines.map((l) => [l.shipmentId, l]));
    expect(byShipment.get("s1")).toMatchObject({
      expectedPackages: 8,
      scannedPackages: 8,
      shortPackages: 0,
      isComplete: true,
    });
    expect(byShipment.get("s2")).toMatchObject({
      scannedPackages: 4,
      shortPackages: 1,
      isComplete: false,
    });
    expect(byShipment.get("s3")).toMatchObject({
      scannedPackages: 3,
      shortPackages: 1,
      isComplete: false,
    });
  });

  it("is not clean", () => {
    expect(result.isClean).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Duplicate reads
// ────────────────────────────────────────────────────────────

describe("reconcile — duplicate scans of the same barcode", () => {
  const expected = [line("s1", "CL0001", 3)];

  it("counts a barcode read three times as one package", () => {
    const result = reconcile(
      expected,
      scansFor(expected, [
        "CL0001-01",
        "CL0001-01",
        "CL0001-01",
        "CL0001-02",
        "CL0001-03",
      ]),
    );

    expect(result.totals.matchedPackages).toBe(3);
    expect(result.short).toEqual([]);
    expect(result.excess).toEqual([]);
    expect(result.isClean).toBe(true);
  });

  it("reports the extra reads so a jammed trigger is visible", () => {
    const result = reconcile(
      expected,
      scansFor(expected, ["CL0001-01", "CL0001-01", "CL0001-01", "CL0001-02", "CL0001-03"]),
    );

    expect(result.duplicateScans).toEqual([{ barcode: "CL0001-01", extraReads: 2 }]);
    expect(result.matched.find((m) => m.barcode === "CL0001-01")?.scanCount).toBe(3);
  });

  it("does not let repeats disguise a shortage", () => {
    // Two boxes scanned, one of them twice. Three were sent.
    const result = reconcile(
      expected,
      scansFor(expected, ["CL0001-01", "CL0001-02", "CL0001-02"]),
    );

    expect(result.short).toHaveLength(1);
    expect(result.short[0].barcode).toBe("CL0001-03");
  });

  it("keeps the first read's timestamp", () => {
    const result = reconcile(expected, [
      { barcode: "CL0001-01", packageId: "p1", shipmentId: "s1", scannedAt: new Date(2026, 7, 25, 6, 0, 0) },
      { barcode: "CL0001-01", packageId: "p1", shipmentId: "s1", scannedAt: new Date(2026, 7, 25, 9, 0, 0) },
    ]);

    expect(result.matched[0].scannedAt).toEqual(new Date(2026, 7, 25, 6, 0, 0));
  });

  it("resolves a barcode a later read identified but an earlier one did not", () => {
    const result = reconcile([], [
      { barcode: "CL9999-01", packageId: null, shipmentId: null },
      { barcode: "CL9999-01", packageId: "p9", shipmentId: "s9" },
    ]);

    expect(result.excess).toHaveLength(1);
    expect(result.excess[0]).toMatchObject({
      packageId: "p9",
      shipmentId: "s9",
      reason: "NOT_ON_MANIFEST",
    });
  });
});

// ────────────────────────────────────────────────────────────
// A barcode belonging to a different manifest
// ────────────────────────────────────────────────────────────

describe("reconcile — a package from another manifest", () => {
  const expected = [line("s1", "CL0001", 2)];

  const result = reconcile(expected, [
    ...scansFor(expected, ["CL0001-01", "CL0001-02"]),
    // A real, known package — just not one this truck was supposed to carry.
    {
      barcode: "CL7777-01",
      packageId: "pkg-other",
      shipmentId: "s-other",
      scannedAt: new Date(2026, 7, 25, 6, 40),
    },
  ]);

  it("raises it as excess, not as a match", () => {
    expect(result.matched).toHaveLength(2);
    expect(result.excess).toHaveLength(1);
    expect(result.excess[0].barcode).toBe("CL7777-01");
  });

  it("classifies it as misrouted rather than unknown", () => {
    expect(result.excess[0].reason).toBe("NOT_ON_MANIFEST");
    expect(result.excess[0].shipmentId).toBe("s-other");
    expect(result.excess[0].packageId).toBe("pkg-other");
  });

  it("leaves the manifest's own lines complete", () => {
    expect(result.short).toEqual([]);
    expect(result.lines[0].isComplete).toBe(true);
  });

  it("is not clean — an excess alone blocks a clean close", () => {
    expect(result.isClean).toBe(false);
  });

  it("calls a barcode nothing in the system knows UNKNOWN", () => {
    const withGarbage = reconcile(expected, [
      { barcode: "NOT-A-REAL-LABEL", packageId: null, shipmentId: null },
    ]);

    expect(withGarbage.excess[0].reason).toBe("UNKNOWN");
    expect(withGarbage.excess[0].shipmentId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Zero scans
// ────────────────────────────────────────────────────────────

describe("reconcile — nothing scanned at all", () => {
  const expected = [line("s1", "CL0001", 3), line("s2", "CL0002", 2)];
  const result = reconcile(expected, []);

  it("makes every expected package short", () => {
    expect(result.short).toHaveLength(5);
    expect(result.totals.shortPackages).toBe(5);
    expect(result.totals.matchedPackages).toBe(0);
  });

  it("names every missing barcode", () => {
    expect(result.short.map((s) => s.barcode)).toEqual([
      "CL0001-01",
      "CL0001-02",
      "CL0001-03",
      "CL0002-01",
      "CL0002-02",
    ]);
  });

  it("marks no line complete", () => {
    expect(result.lines.every((l) => !l.isComplete)).toBe(true);
  });

  it("raises no excess", () => {
    expect(result.excess).toEqual([]);
  });
});

describe("reconcile — an empty manifest", () => {
  it("is clean when nothing was expected and nothing scanned", () => {
    const result = reconcile([], []);
    expect(result.isClean).toBe(true);
    expect(result.totals.expectedPackages).toBe(0);
    expect(result.totals.expectedShipments).toBe(0);
  });

  it("makes every scan an excess when nothing was expected", () => {
    const result = reconcile([], [{ barcode: "CL0001-01", packageId: "p1", shipmentId: "s1" }]);
    expect(result.excess).toHaveLength(1);
    expect(result.short).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// Exact match
// ────────────────────────────────────────────────────────────

describe("reconcile — an exact match", () => {
  const expected = [
    line("s1", "CL0001", 4),
    line("s2", "CL0002", 1),
    line("s3", "CL0003", 7),
  ];
  const result = reconcile(
    expected,
    scansFor(expected, expected.flatMap((l) => l.barcodes)),
  );

  it("is clean", () => {
    expect(result.isClean).toBe(true);
    expect(result.short).toEqual([]);
    expect(result.excess).toEqual([]);
  });

  it("matches all twelve packages across three shipments", () => {
    expect(result.totals.expectedShipments).toBe(3);
    expect(result.totals.expectedPackages).toBe(12);
    expect(result.totals.matchedPackages).toBe(12);
  });

  it("ticks every line", () => {
    expect(result.lines.every((l) => l.isComplete)).toBe(true);
  });

  it("holds regardless of the order the boxes came off the truck", () => {
    const shuffled = [...expected.flatMap((l) => l.barcodes)].reverse();
    expect(reconcile(expected, scansFor(expected, shuffled)).isClean).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Barcode hygiene
// ────────────────────────────────────────────────────────────

describe("reconcile — barcode normalisation", () => {
  const expected = [line("s1", "CL0001", 2)];

  it("matches despite case and stray whitespace from a hand-typed entry", () => {
    const result = reconcile(expected, [
      { barcode: " cl0001-01 ", packageId: "p1", shipmentId: "s1" },
      { barcode: "CL0001-02\n", packageId: "p2", shipmentId: "s1" },
    ]);

    expect(result.isClean).toBe(true);
    expect(result.matched.map((m) => m.barcode)).toEqual(["CL0001-01", "CL0001-02"]);
  });

  it("does not report the same box as both short and excess", () => {
    const result = reconcile(expected, [
      { barcode: "cl0001-01", packageId: "p1", shipmentId: "s1" },
    ]);

    expect(result.excess).toEqual([]);
    expect(result.short).toHaveLength(1);
    expect(result.short[0].barcode).toBe("CL0001-02");
  });

  it("ignores an empty read from a mis-fired gun", () => {
    const result = reconcile(expected, [
      { barcode: "   ", packageId: null, shipmentId: null },
      ...scansFor(expected, ["CL0001-01", "CL0001-02"]),
    ]);

    expect(result.isClean).toBe(true);
    expect(result.totals.scannedPackages).toBe(2);
  });

  it("normaliseBarcode trims and upper-cases", () => {
    expect(normaliseBarcode("  cl2026-01 ")).toBe("CL2026-01");
  });
});

// ────────────────────────────────────────────────────────────
// Consignments manifested without package labels
// ────────────────────────────────────────────────────────────

describe("reconcile — a line declaring more packages than it has labels", () => {
  // Five declared, only two ever barcoded.
  const expected = [line("s1", "CL0001", 5, { labelled: 2 })];

  it("still reports the unlabelled remainder as short", () => {
    const result = reconcile(expected, scansFor(expected, ["CL0001-01", "CL0001-02"]));

    expect(result.short).toHaveLength(3);
    expect(result.short.every((s) => s.barcode === null)).toBe(true);
    expect(result.lines[0].shortPackages).toBe(3);
  });

  it("counts a named missing label and the unnamed remainder together", () => {
    const result = reconcile(expected, scansFor(expected, ["CL0001-01"]));

    expect(result.short).toHaveLength(4);
    expect(result.short.filter((s) => s.barcode === "CL0001-02")).toHaveLength(1);
    expect(result.short.filter((s) => s.barcode === null)).toHaveLength(3);
  });

  it("is clean when a labelled line matches exactly", () => {
    const exact = [line("s1", "CL0001", 2, { labelled: 2 })];
    expect(reconcile(exact, scansFor(exact, ["CL0001-01", "CL0001-02"])).isClean).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Damage flag pass-through
// ────────────────────────────────────────────────────────────

describe("reconcile — damaged packages", () => {
  const expected = [line("s1", "CL0001", 2)];

  it("counts a damaged package as received, and separately as damaged", () => {
    const result = reconcile(expected, [
      { barcode: "CL0001-01", packageId: "p1", shipmentId: "s1", isDamaged: true },
      { barcode: "CL0001-02", packageId: "p2", shipmentId: "s1" },
    ]);

    expect(result.isClean).toBe(true);
    expect(result.totals.damagedPackages).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// The sentence an operator reads before closing
// ────────────────────────────────────────────────────────────

describe("describeReconciliation", () => {
  it("confirms a clean receipt", () => {
    const expected = [line("s1", "CL0001", 3)];
    const result = reconcile(expected, scansFor(expected, expected[0].barcodes));

    expect(describeReconciliation(result)).toBe(
      "All 3 packages accounted for across 1 shipment.",
    );
  });

  it("states both sides of a mixed discrepancy", () => {
    const expected = [line("s1", "CL0001", 3)];
    const result = reconcile(expected, [
      { barcode: "CL0001-01", packageId: "p1", shipmentId: "s1" },
      { barcode: "CL7777-01", packageId: "px", shipmentId: "sx" },
    ]);

    expect(describeReconciliation(result)).toBe(
      "2 short of 3 expected and 1 unexpected package. Closing raises these against the dispatching branch.",
    );
  });

  it("uses the singular for a single package", () => {
    const expected = [line("s1", "CL0001", 1)];
    const result = reconcile(expected, scansFor(expected, expected[0].barcodes));

    expect(describeReconciliation(result)).toBe(
      "All 1 package accounted for across 1 shipment.",
    );
  });
});
