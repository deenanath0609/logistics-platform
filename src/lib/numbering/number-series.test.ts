import { describe, expect, it } from "vitest";
import {
  financialYear,
  periodKeyFor,
  renderPattern,
  previewNext,
} from "./number-series";

describe("financialYear", () => {
  it("starts the year in April", () => {
    expect(financialYear(new Date("2026-04-01T00:00:00"))).toBe("2627");
    expect(financialYear(new Date("2027-03-31T00:00:00"))).toBe("2627");
  });

  it("puts January in the previous year's FY", () => {
    expect(financialYear(new Date("2026-01-15T00:00:00"))).toBe("2526");
  });
});

describe("periodKeyFor", () => {
  const at = new Date("2026-08-25T10:30:00");

  it("keys by day, month, financial year, or not at all", () => {
    expect(periodKeyFor("DAILY", at)).toBe("2026-08-25");
    expect(periodKeyFor("MONTHLY", at)).toBe("2026-08");
    expect(periodKeyFor("FINANCIAL_YEAR", at)).toBe("2627");
    expect(periodKeyFor("NEVER", at)).toBe("ALL");
  });
});

describe("renderPattern", () => {
  const at = new Date("2026-08-25T10:30:00");

  it("renders the LR pattern from the specification", () => {
    expect(
      renderPattern("{PREFIX}{YYYY}{MM}{DD}{SEQ}", {
        prefix: "CL",
        sequence: 1,
        padding: 4,
        at,
      }),
    ).toBe("CL202608250001");
  });

  it("renders manifest, trip, and invoice patterns", () => {
    expect(
      renderPattern("M{SEQ}", { prefix: "M", sequence: 145, padding: 6, at }),
    ).toBe("M000145");

    expect(
      renderPattern("TRIP-{YYYY}-{SEQ}", {
        prefix: "TRIP",
        sequence: 125,
        padding: 5,
        at,
      }),
    ).toBe("TRIP-2026-00125");

    expect(
      renderPattern("INV/{FY}/{BRANCH}/{SEQ}", {
        prefix: "INV",
        branchCode: "DEL",
        sequence: 184,
        padding: 4,
        at,
      }),
    ).toBe("INV/2627/DEL/0184");
  });

  it("leaves unknown tokens alone rather than blanking them", () => {
    expect(
      renderPattern("{NOPE}-{SEQ}", { sequence: 1, padding: 2, at }),
    ).toBe("{NOPE}-01");
  });

  it("substitutes empty strings for absent prefix and branch", () => {
    expect(
      renderPattern("{PREFIX}{BRANCH}{SEQ}", { sequence: 7, padding: 3, at }),
    ).toBe("007");
  });
});

describe("previewNext", () => {
  const at = new Date("2026-08-25T10:30:00");

  it("continues the sequence within the same period", () => {
    expect(
      previewNext(
        {
          pattern: "{PREFIX}{YYYY}{MM}{DD}{SEQ}",
          prefix: "CL",
          padding: 4,
          resetPolicy: "DAILY",
          currentValue: 41,
          periodKey: "2026-08-25",
        },
        undefined,
        at,
      ),
    ).toBe("CL202608250042");
  });

  it("restarts at 1 when the period has rolled over", () => {
    expect(
      previewNext(
        {
          pattern: "{PREFIX}{YYYY}{MM}{DD}{SEQ}",
          prefix: "CL",
          padding: 4,
          resetPolicy: "DAILY",
          currentValue: 998,
          // Yesterday — so today's first number starts again at 1.
          periodKey: "2026-08-24",
        },
        undefined,
        at,
      ),
    ).toBe("CL202608250001");
  });

  it("does not reset a NEVER series", () => {
    expect(
      previewNext(
        {
          pattern: "M{SEQ}",
          prefix: "M",
          padding: 6,
          resetPolicy: "NEVER",
          currentValue: 144,
          periodKey: "ALL",
        },
        undefined,
        at,
      ),
    ).toBe("M000145");
  });
});
