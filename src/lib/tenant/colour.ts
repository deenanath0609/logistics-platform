/**
 * Hex → OKLCh, because the palette is declared in OKLCh and a tenant picks
 * a colour in hex.
 *
 * The token system in globals.css was built for exactly this — every
 * component reads `--primary` rather than a literal — so a tenant palette
 * is a stylesheet, not a fork. What it was not built for is a tenant
 * choosing a colour so light that white text on it becomes unreadable, so
 * the foreground that pairs with each brand colour is computed here rather
 * than chosen by the tenant.
 */

export type Oklch = { l: number; c: number; h: number };

function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Parses `#rgb`, `#rrggbb`, or the same without the hash. Null if unparseable. */
export function parseHex(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** sRGB → OKLab → OKLCh, using Björn Ottosson's published matrices. */
export function hexToOklch(value: string | null | undefined): Oklch | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(srgbToLinear);

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;

  return { l: L, c, h };
}

export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)})`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Text that stays readable on the tenant's colour.
 *
 * A tenant choosing a pale yellow must not be able to produce white-on-white
 * buttons, so the pairing is derived from lightness rather than configured.
 * The 0.62 threshold is where OKLCh lightness stops carrying white text at
 * the contrast the rest of the palette holds.
 */
export function foregroundFor(colour: Oklch): Oklch {
  return colour.l > 0.62
    ? { l: 0.21, c: Math.min(colour.c * 0.25, 0.03), h: colour.h }
    : { l: 0.99, c: Math.min(colour.c * 0.05, 0.01), h: colour.h };
}

/** A muted wash of the brand colour, for hovers and selected rows. */
export function subtleFor(colour: Oklch, dark: boolean): Oklch {
  return dark
    ? { l: clamp(colour.l * 0.4 + 0.1, 0.2, 0.36), c: Math.min(colour.c * 0.45, 0.05), h: colour.h }
    : { l: clamp(0.99 - colour.c * 0.6, 0.93, 0.97), c: Math.min(colour.c * 0.2, 0.02), h: colour.h };
}

/** The dark-theme counterpart of a brand colour: lighter, slightly less saturated. */
export function darkVariantFor(colour: Oklch): Oklch {
  return {
    l: clamp(1.24 - colour.l * 0.62, 0.62, 0.86),
    c: Math.min(colour.c * 1.15, 0.14),
    h: colour.h,
  };
}
