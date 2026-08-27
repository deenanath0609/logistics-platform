import { describe, expect, it } from "vitest";
import { foregroundFor, hexToOklch, parseHex } from "@/lib/tenant/colour";
import { tenantPaletteCss } from "@/lib/tenant/branding";

describe("parseHex", () => {
  it("accepts both lengths, with or without the hash", () => {
    expect(parseHex("#fff")).toEqual([1, 1, 1]);
    expect(parseHex("000000")).toEqual([0, 0, 0]);
  });

  it("rejects anything that is not a colour", () => {
    expect(parseHex("teal")).toBeNull();
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(parseHex(null)).toBeNull();
  });
});

describe("hexToOklch", () => {
  it("maps the achromatic ends correctly", () => {
    expect(hexToOklch("#ffffff")!.l).toBeCloseTo(1, 2);
    expect(hexToOklch("#ffffff")!.c).toBeCloseTo(0, 3);
    expect(hexToOklch("#000000")!.l).toBeCloseTo(0, 3);
  });

  it("puts a mid blue where OKLCh says it belongs", () => {
    const blue = hexToOklch("#0057b8")!;
    expect(blue.l).toBeGreaterThan(0.3);
    expect(blue.l).toBeLessThan(0.55);
    expect(blue.h).toBeGreaterThan(230);
    expect(blue.h).toBeLessThan(280);
  });
});

describe("foregroundFor", () => {
  it("puts dark text on a pale brand colour", () => {
    expect(foregroundFor(hexToOklch("#ffe066")!).l).toBeLessThan(0.4);
  });

  it("puts light text on a deep brand colour", () => {
    expect(foregroundFor(hexToOklch("#0f3d3e")!).l).toBeGreaterThan(0.9);
  });
});

describe("tenantPaletteCss", () => {
  it("is empty when the tenant has chosen nothing — our tokens stand", () => {
    expect(tenantPaletteCss({ primaryColorHex: null, accentColorHex: null })).toBe("");
  });

  it("overrides every token derived from the brand colour, in both themes", () => {
    const css = tenantPaletteCss({ primaryColorHex: "#0057b8", accentColorHex: null });
    for (const token of [
      "--primary:",
      "--primary-foreground:",
      "--ring:",
      "--sidebar-primary:",
      "--sidebar-ring:",
      "--chart-1:",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain(":root {");
    expect(css).toContain(".dark {");
  });

  it("never touches the status colours", () => {
    const css = tenantPaletteCss({ primaryColorHex: "#b00020", accentColorHex: "#b00020" });
    expect(css).not.toContain("--ok:");
    expect(css).not.toContain("--warn:");
    expect(css).not.toContain("--bad:");
  });
});
