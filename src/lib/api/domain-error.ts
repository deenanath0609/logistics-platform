/**
 * What a partner is allowed to be told about a domain failure.
 *
 * Domain services in this codebase answer `{ ok: false, error, field? }`,
 * and the two halves of that union are not equally safe to forward. A
 * failure that names a `field` was written by hand for a person to read:
 * "COD is not offered on EXP", "that PIN code is not serviceable". A
 * failure with no field may be either an author's sentence or an
 * exception's — `createBooking` ends in a `catch` that returns
 * `error.message` verbatim, which is how a Prisma error naming a model and
 * a column, or a `TenantContextError` carrying two organisation ids, ends
 * up in an HTTP body on the public internet.
 *
 * So the rule is the presence of `field`, not a list of forbidden words. A
 * denylist of "prisma", "constraint", "TenantContext" would have to be
 * kept in step with every library the services grow, and would be wrong
 * the first time it was not.
 *
 * Pure, so both branches are ordinary unit tests.
 */

export type DomainFailure = { error: string; field?: string };

export type PartnerFacingError = {
  /** Safe to put in a response body. */
  message: string;
  field?: string;
  /**
   * The original text, present only when it was withheld. Log it against
   * the request id — a partner quoting that id must still be answerable.
   */
  withheld?: string;
};

const GENERIC =
  "That booking could not be accepted. Quote the request id and we can say why.";

export function partnerFacingError(
  failure: DomainFailure,
  generic: string = GENERIC,
): PartnerFacingError {
  if (failure.field) {
    return { message: failure.error, field: failure.field };
  }
  return { message: generic, withheld: failure.error };
}
