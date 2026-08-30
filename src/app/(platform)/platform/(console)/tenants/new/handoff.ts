/**
 * Carrying the first owner's generated password from the provisioning
 * action to the page that shows it, once.
 *
 * Its own module because both halves — the action that writes the cookie
 * and the server component that reads it — need the same name and the same
 * encoding, and a server component may not import from a `"use server"`
 * file without every export becoming an action.
 *
 * The value is base64 only so a password containing a `;` or a `,` cannot
 * break the cookie header. That is encoding, not protection: what protects
 * it is the cookie being httpOnly, scoped to `/platform` on the operator
 * console's own host, and expiring in ten minutes.
 */

export const HANDOFF_COOKIE = "platform_provisioned";

/** Long enough to write it down, short enough not to linger. */
export const HANDOFF_MAX_AGE_SECONDS = 600;

export function encodeHandoff(orgId: string, password: string): string {
  return Buffer.from(`${orgId}:${password}`, "utf8").toString("base64url");
}

/**
 * Returns the password only when the cookie names the tenant being viewed.
 *
 * The check matters: without it, provisioning one carrier and then walking
 * to another's page would display the first one's password there, which is
 * both confusing and exactly the kind of thing that gets typed into the
 * wrong login screen.
 */
export function readHandoff(
  raw: string | undefined,
  orgId: string,
): string | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    if (decoded.slice(0, separator) !== orgId) return null;
    return decoded.slice(separator + 1) || null;
  } catch {
    return null;
  }
}
