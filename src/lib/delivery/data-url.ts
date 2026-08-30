/**
 * What a `data:` URL from the field app is allowed to contain.
 *
 * The signature canvas and the compressed delivery photograph both arrive
 * as base64 in a `data:` URL, and this decides which of them the platform
 * will keep. Pure and separate from `assets.ts` so the policy — which is
 * the security-relevant half — is testable without a database.
 */

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i;

/**
 * Image types accepted as evidence.
 *
 * An allowlist rather than a `startsWith("image/")` test, which is what
 * used to be here and which let `image/svg+xml` through. SVG is a document
 * format wearing an image's name: it carries `<script>`, `<foreignObject>`
 * and external references, and the asset route hands the stored content
 * type straight back to the browser. Inside the `<img>` on the POD page
 * that script is inert — but nothing stops anyone opening the asset URL
 * itself, and there it runs on the carrier's own origin with the viewer's
 * session. A signature is ink on a canvas; it has no need to be a
 * document.
 *
 * Adding a format here is a deliberate act. Anything not raster, and
 * anything the browser will parse as markup, does not belong.
 */
export const ACCEPTED_CAPTURE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function isAcceptedCaptureType(contentType: string): boolean {
  // Parameters (`image/png; charset=…`) and casing are both things a
  // client can vary without changing what the bytes are.
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ACCEPTED_CAPTURE_TYPES.has(bare);
}

export function parseDataUrl(
  value: string,
): { contentType: string; bytes: Buffer } | null {
  const match = DATA_URL.exec(value.trim());
  if (!match) return null;

  if (!isAcceptedCaptureType(match[1])) return null;

  try {
    return {
      contentType: match[1].split(";")[0].trim().toLowerCase(),
      bytes: Buffer.from(match[2], "base64"),
    };
  } catch {
    return null;
  }
}
