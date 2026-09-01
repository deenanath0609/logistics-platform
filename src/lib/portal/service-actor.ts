import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import type { CustomerSession } from "@/lib/auth/customer-session";

/**
 * The on-behalf-of actor for customer-originated writes.
 *
 * `createBooking` and `appendShipmentEvent` take a `SessionUser` and write
 * `bookedById` / `ShipmentEvent.userId`, both of which are foreign keys
 * into `app_user`. A `CustomerUser` is not a row in that table and must
 * never become one, so a portal booking needs a staff principal to be
 * attributed to — the standard service-principal pattern.
 *
 * Three properties make that safe:
 *
 *  1. The row is created `INACTIVE` and with no password hash, so it can
 *     never sign in. `getCurrentUser` rejects any status but ACTIVE, and
 *     both credential providers require a hash or an OTP the account can
 *     never be issued.
 *  2. It is only ever built *after* `authorizeCustomer()` has resolved a
 *     real portal session, and the permission set is exactly the two
 *     permissions a booking needs — not a role, and not `NETWORK` scope
 *     for anything else.
 *  3. The portal customer who actually did it is recorded on the event
 *     payload, so attribution is not lost by borrowing the principal.
 */

/** Reserved. A real employee can never hold this number. */
const PORTAL_ACTOR_MOBILE = "0000000000";
const PORTAL_ACTOR_NAME = "Customer portal";

/**
 * The narrowest set that lets `createBooking` and its opening
 * `BOOKING_CREATED` event through. Nothing else is granted, so this actor
 * cannot cancel, correct a status, or override serviceability.
 */
const PORTAL_ACTOR_PERMISSIONS = ["shipment.create"] as const;

/**
 * The narrowest set that lets a `BOOKING_AMENDED` event through, and
 * nothing else.
 *
 * Deliberately a *second* set rather than a wider first one. The only
 * customer-side act that has to touch a consignment already booked is
 * calling off its collection — `cancelPortalPickup` — and that records
 * `BOOKING_AMENDED`, whose rule in `TRANSITIONS` asks for
 * `shipment.update`. Adding that permission to `PORTAL_ACTOR_PERMISSIONS`
 * would have handed it to every portal booking and every bulk commit as
 * well, for the sake of one call site.
 */
const PORTAL_AMENDMENT_PERMISSIONS = ["shipment.update"] as const;

/**
 * Finds or creates the portal service principal for an organisation.
 *
 * Idempotent: `(orgId, mobile)` is unique, so concurrent first bookings
 * converge on one row rather than racing. Every tenant gets its own portal
 * principal, which is what keeps the reserved number usable for all of them.
 */
async function portalServiceUser(orgId: string) {
  const existing = await prisma.user.findFirst({
    where: { mobile: PORTAL_ACTOR_MOBILE },
    select: { id: true, orgId: true, primaryBranchId: true },
  });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      orgId,
      mobile: PORTAL_ACTOR_MOBILE,
      name: PORTAL_ACTOR_NAME,
      employeeCode: "SYS-PORTAL",
      // Cannot authenticate: no password, and inactive besides.
      passwordHash: null,
      status: "INACTIVE",
      isFieldUser: false,
    },
    select: { id: true, orgId: true, primaryBranchId: true },
  });
}

/**
 * Builds the actor a portal booking is written as.
 *
 * Takes the customer session it is acting for, so the call site cannot
 * construct one without first having proved a portal login.
 */
export async function bookingActorFor(
  session: CustomerSession,
): Promise<SessionUser> {
  return portalActorFor(session, PORTAL_ACTOR_PERMISSIONS);
}

/**
 * The actor a customer-side amendment is written as.
 *
 * The same service principal — one row per carrier, still unable to sign
 * in — carrying one permission instead of the booking one. The portal
 * customer who actually did it travels separately, on the event's
 * `customerUserId`, so borrowing the principal does not lose the person.
 */
export async function amendmentActorFor(
  session: CustomerSession,
): Promise<SessionUser> {
  return portalActorFor(session, PORTAL_AMENDMENT_PERMISSIONS);
}

async function portalActorFor(
  session: CustomerSession,
  permissions: readonly string[],
): Promise<SessionUser> {
  const service = await portalServiceUser(session.orgId);

  return {
    id: service.id,
    orgId: session.orgId,
    name: `${PORTAL_ACTOR_NAME} · ${session.customerName}`,
    mobile: PORTAL_ACTOR_MOBILE,
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [],
    permissions: new Set<string>(permissions),
    // A booking's origin branch is chosen from the customer's own account,
    // never from this actor's scope — see `resolveBookingBranches`.
    scope: "OWN",
    branchIds: [],
  };
}

/**
 * Decides which branches a portal booking belongs to.
 *
 * The customer does not get to name a branch: origin follows the account's
 * own branch or the PIN code they are shipping from, and destination
 * follows the PIN code they are shipping to. Letting the portal post a
 * branch id would be handing an unauthenticated-ish caller a lever on the
 * network's routing.
 */
export async function resolveBookingBranches(input: {
  customerId: string;
  consignorPincode: string;
  consigneePincode: string;
}): Promise<
  | { ok: true; bookingBranchId: string; originBranchId: string; destinationBranchId: string }
  | { ok: false; error: string; field?: string }
> {
  const [customer, origin, destination] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { branchId: true, isBlocked: true, blockReason: true },
    }),
    // Geography is per-tenant master data, so a PIN code is unique only
    // within the tenant — `findFirst` under the tenant filter, not
    // `findUnique`.
    prisma.pincode.findFirst({
      where: { code: input.consignorPincode },
      select: { servingBranchId: true },
    }),
    prisma.pincode.findFirst({
      where: { code: input.consigneePincode },
      select: { servingBranchId: true, isServiceable: true },
    }),
  ]);

  if (!customer) return { ok: false, error: "That account no longer exists." };
  if (customer.isBlocked) {
    return {
      ok: false,
      error:
        customer.blockReason ??
        "Bookings on this account are on hold. Please speak to your account manager.",
    };
  }

  const originBranchId = customer.branchId ?? origin?.servingBranchId ?? null;
  if (!originBranchId) {
    return {
      ok: false,
      error: "We do not collect from that PIN code. Please raise a pickup request instead.",
      field: "consignorPincode",
    };
  }

  if (!destination?.servingBranchId) {
    return {
      ok: false,
      error: "That destination PIN code is not in our network.",
      field: "consigneePincode",
    };
  }
  if (!destination.isServiceable) {
    // The staff override permission is deliberately not reachable from the
    // portal — a customer cannot force a booking into a blocked PIN code.
    return {
      ok: false,
      error: "That destination PIN code is not currently serviceable.",
      field: "consigneePincode",
    };
  }

  return {
    ok: true,
    bookingBranchId: originBranchId,
    originBranchId,
    destinationBranchId: destination.servingBranchId,
  };
}
