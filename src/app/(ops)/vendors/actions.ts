"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit, changedFields } from "@/server/services/audit";
import { saveVendorRateLine } from "@/lib/billing/vendor-rates";
import {
  createVendorBill,
  approveVendorBill,
  disputeVendorBill,
  recordVendorPayment,
} from "@/lib/billing/vendor";
import type { FinanceActionState } from "../finance/action-state";

const PATH = "/vendors";

function guard(error: unknown): FinanceActionState {
  if (error instanceof PermissionError) {
    return { error: "You do not have permission to do that." };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unique constraint")) {
    return { error: "Another vendor already uses that code." };
  }
  console.error("[vendors]", error);
  return { error: "Something went wrong. Nothing was saved." };
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

const optionalText = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

/**
 * A field that may be blank *or absent*.
 *
 * `optionalText` only maps an empty string to null, so a key missing from
 * the FormData altogether arrives as `undefined` and is refused with
 * "Check the highlighted fields" against a field the form never rendered.
 */
const absentOrText = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null),
    z.string().max(max).nullable(),
  );

/** A blank date field is null; anything present has to be a real day. */
const optionalDay = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date")
    .refine((value) => !Number.isNaN(new Date(value).getTime()), "That is not a real date")
    .nullable(),
);

const vendorSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphen and underscore only")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, "Required").max(120),
  legalName: optionalText(160),
  kind: z.enum(["TRANSPORTER", "BROKER", "ATTACHED_OWNER", "SERVICE"]),
  phone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  email: optionalText(120),
  gstin: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : String(v).toUpperCase()),
    z
      .string()
      .regex(
        /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/,
        "That is not a valid GSTIN",
      )
      .nullable(),
  ),
  pan: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : String(v).toUpperCase()),
    z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "That is not a valid PAN").nullable(),
  ),
  address: optionalText(300),
  // Bounded, because both of these flow straight into money.
  //
  // `paymentTermDays` was a bare nullable number: `-5` was accepted, and
  // `dueDate` is `billDate + days`, so the bill was born five days overdue
  // and sorted to the top of every payment run. A fractional term is
  // meaningless against a `@db.Date` column. A year is a generous ceiling
  // for a credit period nobody would agree to.
  paymentTermDays: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .int("Whole days only")
      .min(0, "A payment term cannot be negative")
      .max(365, "Longer than a year is not a payment term")
      .nullable(),
  ),
  // TDS 194C is 1% or 2%. The column is `Decimal(5,2)`, so 100 is the
  // arithmetic ceiling; `200` was accepted and deducted twice the bill.
  tdsPercent: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .min(0, "A TDS rate cannot be negative")
      .max(100, "A TDS rate cannot exceed 100%")
      .nullable(),
  ),
  notes: optionalText(500),
});

export async function createVendorAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.create");
    const parsed = vendorSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const created = await prisma.vendor.create({
      data: { orgId: actor.orgId, ...parsed.data },
      select: { id: true, code: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Vendor",
      entityId: created.id,
      entityRef: created.code,
      after: parsed.data,
    });

    revalidatePath(PATH);
    return { ok: true, message: "Vendor created.", redirectTo: `${PATH}/${created.id}` };
  } catch (error) {
    return guard(error);
  }
}

export async function updateVendorAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    const parsed = vendorSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const before = await prisma.vendor.findUnique({ where: { id } });
    if (!before || before.deletedAt) return { error: "That vendor no longer exists." };

    const after = await prisma.vendor.update({ where: { id }, data: parsed.data });
    const diff = changedFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );

    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        user: actor,
        action: "UPDATE",
        entity: "Vendor",
        entityId: id,
        entityRef: before.code,
        before: diff.before,
        after: diff.after,
      });
    }

    revalidatePath(`${PATH}/${id}`);
    return { ok: true, message: "Vendor updated." };
  } catch (error) {
    return guard(error);
  }
}

/**
 * ── Standing a vendor down ───────────────────────────────────────────────
 *
 * The list rendered a "Blocked" badge, the detail page rendered "This
 * vendor is blocked and cannot be billed", and `createVendorBill` enforced
 * both flags — while nothing in the product could set either one. A
 * transporter who started losing consignments stayed permanently billable,
 * and two branches of UI could never be reached.
 *
 * Blocking and deactivating are separate on purpose, exactly as they are
 * for customers. **Blocked** is a live commercial decision — stop paying
 * this transporter while a claim is open — and it is reversible in the
 * same breath. **Inactive** retires a party we no longer work with.
 * `createVendorBill` refuses on either, so the distinction is about what
 * the operator means, not about what it prevents.
 *
 * The reason is not stored on the row — `Vendor` has no `blockReason`
 * column, unlike `Customer` — so it goes to the audit trail, which is the
 * record that cannot be edited afterwards. Adding the column would be
 * better and is a migration; see the report.
 */
const statusSchema = z.object({
  id: z.string().min(1),
  isActive: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  isBlocked: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  reason: optionalText(300),
});

export async function setVendorStatusAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = statusSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const before = await prisma.vendor.findUnique({
      where: { id: parsed.data.id },
      select: { id: true, code: true, name: true, isActive: true, isBlocked: true, deletedAt: true },
    });
    if (!before || before.deletedAt) return { error: "That vendor no longer exists." };

    const stoppingWork =
      (parsed.data.isBlocked && !before.isBlocked) ||
      (!parsed.data.isActive && before.isActive);

    // Money stops moving on somebody's say-so, so somebody says why. Not
    // demanded for lifting a block: restoring a party to normal working is
    // the state the record is supposed to be in.
    if (stoppingWork && !parsed.data.reason) {
      return {
        error: "Say why this vendor is being stood down.",
        fieldErrors: { reason: "A blocked or retired vendor needs a reason on the record." },
      };
    }

    if (
      parsed.data.isActive === before.isActive &&
      parsed.data.isBlocked === before.isBlocked
    ) {
      return { ok: true, message: "Nothing changed." };
    }

    await prisma.vendor.update({
      where: { id: before.id },
      data: { isActive: parsed.data.isActive, isBlocked: parsed.data.isBlocked },
    });

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "Vendor",
      entityId: before.id,
      entityRef: before.code,
      before: { isActive: before.isActive, isBlocked: before.isBlocked },
      after: { isActive: parsed.data.isActive, isBlocked: parsed.data.isBlocked },
      reason: parsed.data.reason ?? "Vendor status changed.",
    });

    revalidatePath(PATH, "layout");
    return {
      ok: true,
      message: parsed.data.isBlocked
        ? `${before.name} is blocked. No new bill can be raised against them.`
        : parsed.data.isActive
          ? `${before.name} is back in normal working.`
          : `${before.name} is retired.`,
    };
  } catch (error) {
    return guard(error);
  }
}

/**
 * Retires a vendor from the list.
 *
 * A soft delete, because bills, payments, trips and attached vehicles all
 * keep pointing at the row and a hard delete would take a year of
 * settlement history with it. The list already filters `deletedAt: null`
 * and nothing wrote it — so the filter was decoration.
 *
 * Refused while money is still open between us. Removing a vendor with an
 * unpaid bill hides the liability rather than settling it, and the
 * payables total on the finance screens would silently stop including it.
 */
export async function deleteVendorAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const id = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!id) return { error: "Nothing selected." };
    if (reason.length < 4) {
      return {
        error: "Say why this vendor is being removed.",
        fieldErrors: { reason: "A removal needs a reason on the record." },
      };
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, deletedAt: true },
    });
    if (!vendor || vendor.deletedAt) return { error: "That vendor no longer exists." };

    const [openBills, openTrips] = await Promise.all([
      prisma.vendorBill.count({
        where: {
          vendorId: vendor.id,
          status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_PAID", "DISPUTED"] },
        },
      }),
      prisma.trip.count({
        where: { vendorId: vendor.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      }),
    ]);

    if (openBills > 0) {
      return {
        error: `${vendor.name} has ${openBills} unsettled bill${openBills === 1 ? "" : "s"}. Pay or cancel them before removing the vendor — removing it now would hide the liability, not settle it.`,
      };
    }
    if (openTrips > 0) {
      return {
        error: `${vendor.name} is running ${openTrips} open trip${openTrips === 1 ? "" : "s"}. Close them first.`,
      };
    }

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await recordAudit({
      user: actor,
      action: "DELETE",
      entity: "Vendor",
      entityId: vendor.id,
      entityRef: vendor.code,
      before: { deletedAt: null, isActive: true },
      after: { deletedAt: new Date().toISOString(), isActive: false },
      reason,
    });

    revalidatePath(PATH, "layout");
    return { ok: true, message: `${vendor.name} removed.`, redirectTo: PATH };
  } catch (error) {
    return guard(error);
  }
}

const bankSchema = z.object({
  vendorId: z.string().min(1),
  /** Present when an existing row is being corrected rather than added. */
  id: absentOrText(40),
  accountName: z.string().trim().min(2, "Required").max(120),
  accountNumber: z.string().trim().min(6, "Too short").max(24),
  ifsc: z
    .string()
    .trim()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/i, "That is not a valid IFSC")
    .transform((v) => v.toUpperCase()),
  bankName: optionalText(120),
  isPrimary: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
});

/**
 * ── Who may change where a vendor's money goes ───────────────────────────
 *
 * This writes the payment instruction every future payout to the vendor
 * will follow, and it was gated on `vendor.update` — which TRANSPORT_DESK
 * holds, so that the fleet desk can keep lorry papers and rate contracts
 * current. A clerk with no finance permission whatsoever could therefore
 * add an account, mark it primary, and be paid by the next payment run.
 *
 * The gate is now `settlement.approve`: the permission that already means
 * "may authorise money leaving the company to a vendor". ACCOUNTS and Super
 * Admin hold it and no operational role does, so the desk that answers for
 * a payout is the desk that decides where it lands. A dedicated
 * `vendor.manage_bank` code would read better, but a new permission is a
 * seed row and a role grant before anybody can use it, and this has to hold
 * on the database as deployed.
 *
 * It is still one person acting alone. Two-person control — an account
 * added as pending and confirmed by a second holder before any payout may
 * name it — needs columns this table does not have; see the report.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function saveBankAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const parsed = bankSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    // ── The vendor id is checked, not trusted ───────────────────────────
    //
    // It arrives from a hidden input. Within one organisation a stale tab
    // or a crafted post could otherwise land a payee instruction on a
    // different carrier's transporter — every future payout to whom would
    // then go to an account somebody else chose. The row is the money, so
    // the id that decides whose money it is gets read from the database.
    const vendor = await prisma.vendor.findUnique({
      where: { id: parsed.data.vendorId },
      select: { id: true, code: true, deletedAt: true },
    });
    if (!vendor || vendor.deletedAt) {
      return { error: "That vendor no longer exists." };
    }

    // The same for the row being corrected: it must belong to the vendor
    // the form says it does.
    // `vendorId` is deliberately dropped here: the row is written against
    // `vendor.id`, which came back from the database, never against the
    // value that was posted.
    const { id: accountId, vendorId: _posted, ...fields } = parsed.data;
    let existingNumber: string | null = null;

    if (accountId) {
      const owned = await prisma.vendorBankAccount.findUnique({
        where: { id: accountId },
        select: { id: true, vendorId: true, accountNumber: true },
      });
      if (!owned || owned.vendorId !== vendor.id) {
        return { error: "That bank account is not on this vendor." };
      }
      existingNumber = owned.accountNumber;
    }

    const { created, demoted } = await tenantTransaction(async (tx) => {
      // Read before the demotion, so the trail can say which account was
      // displaced as well as which one took its place.
      const previous = fields.isPrimary
        ? await tx.vendorBankAccount.findFirst({
            where: {
              vendorId: vendor.id,
              isPrimary: true,
              ...(accountId ? { NOT: { id: accountId } } : {}),
            },
            select: { id: true, accountName: true, accountNumber: true },
          })
        : null;

      if (fields.isPrimary) {
        await tx.vendorBankAccount.updateMany({
          where: { vendorId: vendor.id },
          data: { isPrimary: false },
        });
      }

      // Correcting rather than superseding. This action only ever
      // `create`d, so a typed-wrong IFSC could be answered only by adding a
      // second account and hoping the first was never picked — and a wrong
      // non-primary row could not even be demoted, because demotion only
      // happened as a side effect of adding another primary.
      const row = accountId
        ? await tx.vendorBankAccount.update({
            where: { id: accountId },
            data: fields,
            select: { id: true, accountNumber: true },
          })
        : await tx.vendorBankAccount.create({
            data: { ...fields, vendorId: vendor.id, orgId: actor.orgId },
            select: { id: true, accountNumber: true },
          });

      return { created: row, demoted: previous };
    });

    // The number is written to the trail in full, deliberately. It was
    // masked to `••••1234`, which reads like prudence and means that an
    // investigation into a redirected payout cannot say which account the
    // money was sent to — the one fact it needs. This is a payee
    // instruction, not a credential: it is already stored in plaintext on
    // the row, it is printed on every NEFT advice, and unlike the row —
    // which a later edit can supersede — the audit trail cannot be changed.
    // The masked form stays in `entityRef`, which is what the audit list
    // renders at a glance.
    await recordAudit({
      user: actor,
      action: accountId ? "UPDATE" : "CREATE",
      entity: "VendorBankAccount",
      entityId: created.id,
      entityRef: `••••${created.accountNumber.slice(-4)}`,
      before: {
        ...(existingNumber ? { accountNumber: existingNumber } : {}),
        ...(demoted
          ? {
              previousPrimary: {
                id: demoted.id,
                accountName: demoted.accountName,
                accountNumber: demoted.accountNumber,
              },
            }
          : {}),
      },
      after: {
        vendorId: vendor.id,
        accountName: fields.accountName,
        accountNumber: fields.accountNumber,
        ifsc: fields.ifsc,
        bankName: fields.bankName,
        isPrimary: fields.isPrimary,
      },
      reason: accountId
        ? "Vendor bank details corrected — payments will be sent here."
        : "Vendor bank details added — payments will be sent here.",
    });

    revalidatePath(`${PATH}/${vendor.id}`);
    return { ok: true, message: "Bank account saved." };
  } catch (error) {
    return guard(error);
  }
}

/**
 * Removes a payee instruction.
 *
 * Gated the same way as adding one, and audited with the account number in
 * full for the same reason: an investigation into a payout has to be able
 * to say what was on file and when it stopped being on file.
 *
 * The last account is removable. A vendor with no bank details cannot be
 * paid by transfer, which is exactly what the screen says and exactly the
 * right state for a transporter who has stopped performing.
 */
export async function removeBankAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const id = String(formData.get("id") ?? "");
    const vendorId = String(formData.get("vendorId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!id || !vendorId) return { error: "Nothing selected." };
    if (reason.length < 4) {
      return {
        error: "Say why this account is being removed.",
        fieldErrors: { reason: "Written to the audit trail against your name." },
      };
    }

    const account = await prisma.vendorBankAccount.findUnique({
      where: { id },
      select: {
        id: true,
        vendorId: true,
        accountName: true,
        accountNumber: true,
        ifsc: true,
        isPrimary: true,
      },
    });

    if (!account || account.vendorId !== vendorId) {
      return { error: "That bank account is not on this vendor." };
    }

    await prisma.vendorBankAccount.delete({ where: { id } });

    await recordAudit({
      user: actor,
      action: "DELETE",
      entity: "VendorBankAccount",
      entityId: account.id,
      entityRef: `••••${account.accountNumber.slice(-4)}`,
      before: {
        vendorId: account.vendorId,
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        ifsc: account.ifsc,
        isPrimary: account.isPrimary,
      },
      reason: `Vendor bank details removed — payments can no longer be sent here. ${reason}`,
    });

    revalidatePath(`${PATH}/${vendorId}`);
    return { ok: true, message: "Bank account removed." };
  } catch (error) {
    return guard(error);
  }
}

const contractSchema = z
  .object({
    vendorId: z.string().min(1),
    code: z.string().trim().min(2, "Required").max(20).transform((v) => v.toUpperCase()),
    name: z.string().trim().min(2, "Required").max(120),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date")
      .refine((value) => !Number.isNaN(new Date(value).getTime()), "That is not a real date"),
    // Was `optionalText(20)`: any twenty characters passed, `new Date` of
    // them gave `Invalid Date`, Prisma threw, and `guard` turned that into
    // "Something went wrong. Nothing was saved." — which never mentioned
    // the date. Validated as a day, and refused when it precedes the
    // start, because a contract that ends before it begins covers nothing
    // and silently makes every bill under it uncheckable.
    effectiveTo: optionalDay,
  })
  .refine(
    (data) => !data.effectiveTo || data.effectiveTo >= data.effectiveFrom,
    { path: ["effectiveTo"], message: "Cannot end before it starts" },
  );

export async function createRateContractAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = contractSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    // The vendor id comes from a hidden input; a contract landing on the
    // wrong transporter is what every bill from then on is checked against.
    const vendor = await prisma.vendor.findUnique({
      where: { id: parsed.data.vendorId },
      select: { id: true, deletedAt: true },
    });
    if (!vendor || vendor.deletedAt) return { error: "That vendor no longer exists." };

    const created = await prisma.vendorRateContract.create({
      data: {
        orgId: actor.orgId,
        vendorId: vendor.id,
        code: parsed.data.code,
        name: parsed.data.name,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
        effectiveTo: parsed.data.effectiveTo ? new Date(parsed.data.effectiveTo) : null,
      },
      select: { id: true, code: true },
    });

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "VendorRateContract",
      entityId: created.id,
      entityRef: created.code,
      after: parsed.data,
    });

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: "Rate contract created. Add lanes to it next." };
  } catch (error) {
    return guard(error);
  }
}

const rateLineSchema = z.object({
  contractId: z.string().min(1),
  vendorId: z.string().min(1),
  originBranchId: optionalText(40),
  destinationBranchId: optionalText(40),
  vehicleTypeId: optionalText(40),
  basis: z.enum(["PER_TRIP", "PER_KM", "PER_KG", "PER_PACKAGE", "FLAT", "PER_VEHICLE"]),
  rate: z.preprocess(
    (v) => Number(v),
    z.number().min(0, "A rate cannot be negative").max(99_999_999, "That is not a rate"),
  ),
  minimumAmount: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0, "A minimum cannot be negative").max(99_999_999).nullable(),
  ),
});

export async function saveRateLineAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("vendor.update");
    const parsed = rateLineSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    // Both foreign keys and both branches are checked in
    // `saveVendorRateLine`, which is where the rule can be tested and
    // where the verification script reaches it. This stays a permission
    // gate and a form parse.
    const result = await saveVendorRateLine(parsed.data, actor);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: "Lane rate added." };
  } catch (error) {
    return guard(error);
  }
}

const billSchema = z.object({
  vendorId: z.string().min(1),
  billDate: z.string().min(1, "Pick the bill date"),
  tripId: optionalText(40),
  description: z.string().trim().min(2, "Say what is being billed").max(200),
  amount: z.preprocess(
    (v) => Number(v),
    z.number().positive("Enter the amount").max(99_999_999),
  ),
  // Bounded for the same reason as `tdsPercent` above: these three are
  // arithmetic on the bill total, and `optionalNumber` accepted anything
  // a number could be. A negative deduction *increases* what is paid,
  // which is the wrong direction for a field labelled "withheld".
  taxPercent: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0, "A tax rate cannot be negative").max(100).nullable(),
  ),
  deductions: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .min(0, "A deduction is withheld, so it cannot be negative")
      .max(99_999_999)
      .nullable(),
  ),
  advanceAdjusted: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .min(0, "An advance adjusted cannot be negative")
      .max(99_999_999)
      .nullable(),
  ),
  notes: optionalText(400),
});

export async function createVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("expense.record");
    const parsed = billSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await createVendorBill(
      {
        vendorId: parsed.data.vendorId,
        billDate: new Date(parsed.data.billDate),
        lines: [
          {
            tripId: parsed.data.tripId,
            description: parsed.data.description,
            amount: parsed.data.amount,
            taxPercent: parsed.data.taxPercent,
          },
        ],
        deductions: parsed.data.deductions,
        advanceAdjusted: parsed.data.advanceAdjusted,
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return {
      ok: true,
      message:
        result.variance && !result.variance.isZero()
          ? `${result.number} raised — it differs from the contract by ₹${result.variance.toFixed(2)}. Check before approving.`
          : `${result.number} raised.`,
    };
  } catch (error) {
    return guard(error);
  }
}

export async function approveVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("settlement.approve");
    const billId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!billId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return {
        error: "A reason is required.",
        fieldErrors: { reason: "Say what you checked, and how any variance was settled." },
      };
    }

    // A variance is accepted explicitly, in the same act that records why.
    const result = await approveVendorBill(
      { billId, reason, acceptVariance: true },
      actor,
    );
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: `${result.number} approved for payment.` };
  } catch (error) {
    return guard(error);
  }
}

export async function disputeVendorBillAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("expense.approve");
    const billId = String(formData.get("id") ?? "");
    const reason = String(formData.get("reason") ?? "");

    if (!billId) return { error: "Nothing selected." };
    if (!reason.trim()) {
      return { error: "Say what is disputed.", fieldErrors: { reason: "Required." } };
    }

    const result = await disputeVendorBill({ billId, reason }, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH, "layout");
    return { ok: true, message: "Bill parked as disputed." };
  } catch (error) {
    return guard(error);
  }
}

const vendorPaymentSchema = z.object({
  vendorId: z.string().min(1),
  amount: z.preprocess((v) => Number(v), z.number().positive("Enter the amount")),
  mode: z.enum(["CASH", "CHEQUE", "NEFT", "RTGS", "UPI", "CARD", "ADJUSTMENT"]),
  reference: optionalText(80),
  paidOn: z.string().min(1, "Pick the date"),
  notes: optionalText(300),
});

export async function recordVendorPaymentAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const actor = await authorize("payment.record");
    const parsed = vendorPaymentSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    }

    const result = await recordVendorPayment(
      {
        vendorId: parsed.data.vendorId,
        amount: parsed.data.amount,
        mode: parsed.data.mode,
        reference: parsed.data.reference,
        paidOn: new Date(parsed.data.paidOn),
        notes: parsed.data.notes,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${parsed.data.vendorId}`);
    return { ok: true, message: `${result.number} recorded and applied to the oldest bills.` };
  } catch (error) {
    return guard(error);
  }
}
