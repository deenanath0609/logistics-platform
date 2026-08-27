/**
 * Session subject namespacing.
 *
 * Staff and portal customers share one cookie, so the subject claim has to
 * say which population an id belongs to. A staff subject is a bare cuid; a
 * customer subject carries the `customer:` prefix, which no cuid can ever
 * contain.
 *
 * That prefix is the structural half of the boundary: `getCurrentUser()`
 * looks a subject up in `app_user`, and a prefixed subject cannot collide
 * with a row there even by accident. The type half is the other — a
 * `CustomerSession` has no `permissions` set, so `can()` and `authorize()`
 * do not typecheck against it.
 *
 * Kept in its own module so `session.ts` and `customer-session.ts` can both
 * import it without a cycle.
 */

export const CUSTOMER_SUBJECT_PREFIX = "customer:";

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
