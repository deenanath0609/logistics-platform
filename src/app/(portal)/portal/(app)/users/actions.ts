"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  authorizeCustomer,
  CustomerAuthError,
  isAccountOwner,
  type CustomerSession,
} from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";
import { assertWithinLimit, isPlanLimitError } from "@/lib/plan-limits";
import {
  generateTemporaryPassword,
  hashPassword,
} from "@/lib/portal/passwords";

export type SubUserState = {
  ok?: boolean;
  message?: string;
  /** Shown once, to be read to the invited colleague. Never stored. */
  temporaryPassword?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const PATH = "/portal/users";

const inviteSchema = z.object({
  name: z.string().trim().min(2, "Required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  mobile: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").nullable(),
  ),
  // OWNER is deliberately absent: an account has one owner, and handing
  // that over is a conversation with the account manager, not a dropdown.
  role: z.enum(["MEMBER", "VIEWER"]),
  visibleBranchIds: z.string().optional(),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Only the account owner manages logins, and only for their own account.
 *
 * Both halves matter: the role check stops a MEMBER inviting colleagues,
 * and `customerOwnedFilter` stops any of them reaching a login that
 * belongs to a different customer.
 */
async function requireOwner(): Promise<CustomerSession> {
  const session = await authorizeCustomer();
  if (!isAccountOwner(session)) {
    throw new CustomerAuthError("Only the account owner can manage logins.");
  }
  return session;
}

function describe(error: unknown): string {
  if (error instanceof CustomerAuthError) return error.message;

  // The one place a plan-limit message is *not* passed through.
  //
  // `PlanLimitError` names the carrier's plan and its numbers, and the
  // reader here is the carrier's customer. The product is white-label: the
  // consignor booking through this portal is not supposed to know the
  // carrier buys it from anyone, let alone on which plan. They also cannot
  // act on it — no amount of upgrading on their side adds a login. So the
  // refusal is rewritten as something true and actionable for them, and
  // the number stays on the carrier's own usage panel where it belongs.
  if (isPlanLimitError(error)) {
    return "No more logins can be added to this account. Ask your account manager to raise the limit.";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return "That email address already has a login.";
  }
  console.error("[portal sub-users]", error);
  return "Something went wrong. Nothing was saved.";
}

export async function inviteSubUser(
  _prev: SubUserState,
  formData: FormData,
): Promise<SubUserState> {
  try {
    const session = await requireOwner();

    const parsed = inviteSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { visibleBranchIds, ...data } = parsed.data;
    const branchIds = await ownBranchIds(session, visibleBranchIds);

    // The cap belongs to the carrier, not to this customer account: the
    // carrier bought a plan with room for so many portal logins, and every
    // one of their customers draws on the same pool. `describe` below
    // rewrites the refusal before it is shown — see the note there.
    await assertWithinLimit("portalUsers");

    const temporary = generateTemporaryPassword();

    const created = await prisma.customerUser.create({
      data: {
        ...data,
        mobile: data.mobile,
        // Both from the session, never from the form: the account the owner
        // is signed in to, and the carrier that account belongs to.
        orgId: session.orgId,
        ...customerOwnedFilter(session),
        passwordHash: await hashPassword(temporary),
        // The password the owner reads down the phone must not outlive
        // the first session.
        mustChangePassword: true,
        invitedAt: new Date(),
        createdById: session.id,
        visibleBranchIds: branchIds,
      },
      select: { name: true },
    });

    revalidatePath(PATH);
    return {
      ok: true,
      message: `${created.name} can now sign in.`,
      temporaryPassword: temporary,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

const updateSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["MEMBER", "VIEWER"]),
  isActive: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
  visibleBranchIds: z.string().optional(),
});

export async function updateSubUser(
  _prev: SubUserState,
  formData: FormData,
): Promise<SubUserState> {
  try {
    const session = await requireOwner();

    const parsed = updateSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { id, visibleBranchIds, ...data } = parsed.data;

    if (id === session.id) {
      return { error: "You cannot change your own role or status." };
    }

    // Scoped in the same statement that writes: an id from another
    // account matches nothing rather than being fetched and then checked.
    const result = await prisma.customerUser.updateMany({
      where: { id, ...customerOwnedFilter(session), role: { not: "OWNER" } },
      data: {
        ...data,
        // Absent means "not on this form", not "clear it". A disable
        // button must not silently widen someone's visibility to the
        // whole account.
        ...(visibleBranchIds === undefined
          ? {}
          : { visibleBranchIds: await ownBranchIds(session, visibleBranchIds) }),
      },
    });

    if (result.count === 0) {
      return { error: "That login is not one you can change." };
    }

    revalidatePath(PATH);
    return { ok: true, message: "Login updated." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function resetSubUserPassword(
  _prev: SubUserState,
  formData: FormData,
): Promise<SubUserState> {
  try {
    const session = await requireOwner();

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };
    if (id === session.id) {
      return {
        error: "Change your own password under Change password.",
      };
    }

    const temporary = generateTemporaryPassword();

    const result = await prisma.customerUser.updateMany({
      where: { id, ...customerOwnedFilter(session), role: { not: "OWNER" } },
      data: {
        passwordHash: await hashPassword(temporary),
        mustChangePassword: true,
        // A reset clears the lockout the forgotten password earned.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    if (result.count === 0) {
      return { error: "That login is not one you can reset." };
    }

    revalidatePath(PATH);
    return {
      ok: true,
      message: "Password reset.",
      temporaryPassword: temporary,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

/**
 * Filters posted branch ids down to branches that actually touch this
 * account's traffic — otherwise "per-branch visibility" would become a way
 * to probe which branch ids exist.
 */
async function ownBranchIds(
  session: CustomerSession,
  raw: string | undefined,
): Promise<string[]> {
  const posted = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (posted.length === 0) return [];

  const branches = await prisma.branch.findMany({
    where: {
      id: { in: posted },
      OR: [
        { customers: { some: { id: session.customerId } } },
        { originShipments: { some: { consignorId: session.customerId } } },
        { bookedShipments: { some: { consignorId: session.customerId } } },
      ],
    },
    select: { id: true },
  });

  return branches.map((branch) => branch.id);
}
