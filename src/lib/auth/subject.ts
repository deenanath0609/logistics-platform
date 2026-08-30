/**
 * Session subject namespacing.
 *
 * Three populations sign in to this product and none of them may be
 * mistaken for another, so the subject claim has to say which one an id
 * belongs to. A staff subject is a bare cuid; a customer subject carries
 * the `customer:` prefix and a platform operator the `platform:` prefix,
 * neither of which a cuid can ever contain.
 *
 * That prefix is the structural half of the boundary: `getCurrentUser()`
 * looks a subject up in `app_user`, and a prefixed subject cannot collide
 * with a row there even by accident. The type half is the other — a
 * `CustomerSession` has no `permissions` set, so `can()` and `authorize()`
 * do not typecheck against it, and neither does a `PlatformOperator`.
 *
 * Kept in its own module so `session.ts`, `customer-session.ts` and
 * `lib/platform/session.ts` can all import it without a cycle.
 */

export const CUSTOMER_SUBJECT_PREFIX = "customer:";

/**
 * The operator console's namespace.
 *
 * The operator does not share the tenant cookie at all — it has its own,
 * on its own hostname (see `lib/platform/session.ts`). Namespacing the
 * subject anyway costs nothing and means that if the two cookies ever do
 * meet, through a future single-sign-on or a copied token, the prefix
 * alone stops a support login from resolving against `app_user`.
 */
export const PLATFORM_SUBJECT_PREFIX = "platform:";

/** Wraps a `CustomerUser.id` for storage in the JWT `sub` claim. */
export function customerSubject(customerUserId: string): string {
  return `${CUSTOMER_SUBJECT_PREFIX}${customerUserId}`;
}

export function isCustomerSubject(subject: string | null | undefined): boolean {
  return typeof subject === "string" && subject.startsWith(CUSTOMER_SUBJECT_PREFIX);
}

/**
 * The `CustomerUser.id` inside a subject, or null when the subject belongs
 * to staff. Callers must treat null as "not a customer", never as "any
 * customer".
 */
export function readCustomerSubject(
  subject: string | null | undefined,
): string | null {
  if (!isCustomerSubject(subject)) return null;
  const id = subject!.slice(CUSTOMER_SUBJECT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Wraps a `PlatformAdmin.id` for storage in the operator cookie's `sub`. */
export function platformSubject(platformAdminId: string): string {
  return `${PLATFORM_SUBJECT_PREFIX}${platformAdminId}`;
}

export function isPlatformSubject(subject: string | null | undefined): boolean {
  return typeof subject === "string" && subject.startsWith(PLATFORM_SUBJECT_PREFIX);
}

/**
 * The `PlatformAdmin.id` inside a subject, or null when the subject belongs
 * to tenant staff or a portal customer.
 *
 * Null means "not an operator" and never "any operator" — the refusal is
 * the point, in both directions: this returns null for a staff subject, and
 * `getCurrentUser()` returns null for a platform one.
 */
export function readPlatformSubject(
  subject: string | null | undefined,
): string | null {
  if (!isPlatformSubject(subject)) return null;
  const id = subject!.slice(PLATFORM_SUBJECT_PREFIX.length);
  return id.length > 0 ? id : null;
}
