import { prisma } from "@/lib/prisma";
import { can, type SessionUser } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { recordAudit } from "@/server/services/audit";

/**
 * What the company pays to run a lane.
 *
 * This lives outside the server action for the same reason `field-staff.ts`
 * does: the rule has to be callable by the action, by a test, and by the
 * verification script, and a rule that only exists inside an action is one
 * nobody can prove. The action above it is a permission gate and a form
 * parse; every refusal below is here.
 *
 * ── Three things were trusted that should not have been ─────────────────
 *
 * `contractId` and `vendorId` both arrive from hidden inputs and nothing
 * checked that the contract belonged to the vendor, so within one
 * organisation a stale tab could write a lane rate onto a different
 * transporter's contract while reporting success against the page it came
 * from. And the branch options feeding the form were fetched unscoped —
 * compare `field-staff/page.tsx`, which does `...branchScope(actor, "id")`
 * on the identical query — so a branch-scoped user was shown the whole
 * network and could set the rate the company pays on lanes they do not
 * cover. The query is now scoped and the write is now checked; either
 * alone is a half-measure, because the query is what a person sees and the
 * check is what a POST meets.
 */

export type SaveRateLineInput = {
  contractId: string;
  vendorId: string;
  originBranchId: string | null;
  destinationBranchId: string | null;
  vehicleTypeId: string | null;
  basis: "PER_TRIP" | "PER_KM" | "PER_KG" | "PER_PACKAGE" | "FLAT" | "PER_VEHICLE";
  rate: number;
  minimumAmount: number | null;
};

export type SaveRateLineResult =
  | { ok: true; rateLineId: string }
  | { ok: false; error: string; field?: string };

export async function saveVendorRateLine(
  input: SaveRateLineInput,
  actor: SessionUser,
): Promise<SaveRateLineResult> {
  if (!can(actor, "vendor.update")) {
    return { ok: false, error: "You do not have permission to change vendor rates." };
  }

  const contract = await prisma.vendorRateContract.findUnique({
    where: { id: input.contractId },
    select: { id: true, vendorId: true, code: true },
  });

  if (!contract || contract.vendorId !== input.vendorId) {
    return { ok: false, error: "That rate contract is not on this vendor." };
  }

  const named = [input.originBranchId, input.destinationBranchId].filter(
    (id): id is string => Boolean(id),
  );

  if (named.length > 0) {
    const branches = await prisma.branch.findMany({
      where: { id: { in: named }, deletedAt: null },
      select: { id: true, code: true },
    });

    for (const id of named) {
      const branch = branches.find((row) => row.id === id);
      if (!branch) {
        return {
          ok: false,
          error: "One of those branches does not exist.",
          field: "originBranchId",
        };
      }
      if (!coversBranch(actor, branch.id)) {
        return {
          ok: false,
          error: `${branch.code} is outside the branches you cover. A rate on a lane you do not run is not yours to set.`,
          field: "originBranchId",
        };
      }
    }
  }

  if (input.vehicleTypeId) {
    const vehicleType = await prisma.vehicleType.findUnique({
      where: { id: input.vehicleTypeId },
      select: { id: true },
    });
    if (!vehicleType) {
      return {
        ok: false,
        error: "That vehicle type does not exist.",
        field: "vehicleTypeId",
      };
    }
  }

  const created = await prisma.vendorRateLine.create({
    data: {
      orgId: actor.orgId,
      contractId: contract.id,
      originBranchId: input.originBranchId,
      destinationBranchId: input.destinationBranchId,
      vehicleTypeId: input.vehicleTypeId,
      basis: input.basis,
      rate: String(input.rate),
      minimumAmount: input.minimumAmount === null ? null : String(input.minimumAmount),
    },
    select: { id: true },
  });

  await recordAudit({
    user: actor,
    action: "CREATE",
    entity: "VendorRateLine",
    entityId: created.id,
    entityRef: `${contract.code} · ${input.basis} @ ${input.rate}`,
    branchId: input.originBranchId ?? undefined,
    after: {
      contractId: contract.id,
      vendorId: contract.vendorId,
      originBranchId: input.originBranchId,
      destinationBranchId: input.destinationBranchId,
      vehicleTypeId: input.vehicleTypeId,
      basis: input.basis,
      rate: input.rate,
      minimumAmount: input.minimumAmount,
    },
  });

  return { ok: true, rateLineId: created.id };
}
