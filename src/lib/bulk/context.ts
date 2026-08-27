import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import type { ParsedRow } from "./parse";
import type {
  BranchFact,
  PincodeFact,
  ServiceFact,
  ShipmentMode,
  ValidationContext,
} from "./validate";

/**
 * Assembles the facts the (pure) validator needs.
 *
 * The one thing worth noticing here is what is *not* loaded: every
 * customer reference ever issued. At fifty thousand shipments a day that
 * set is unbounded, so only the references actually present in the file
 * are looked up. Service types and branches are small masters and are
 * loaded whole.
 */
export async function loadValidationContext(
  rows: readonly ParsedRow[],
  actor: SessionUser,
): Promise<ValidationContext> {
  const pincodesInFile = new Set<string>();
  const referencesInFile = new Set<string>();

  for (const row of rows) {
    const consignor = (row.raw.consignorPincode ?? "").trim();
    const consignee = (row.raw.consigneePincode ?? "").trim();
    if (/^\d{6}$/.test(consignor)) pincodesInFile.add(consignor);
    if (/^\d{6}$/.test(consignee)) pincodesInFile.add(consignee);

    const reference = (row.raw.customerReference ?? "").trim();
    if (reference !== "") referencesInFile.add(reference);
  }

  const [serviceRows, branchRows, pincodeRows, referenceRows] = await Promise.all([
    prisma.serviceType.findMany({
      select: {
        id: true,
        code: true,
        mode: true,
        allowsCod: true,
        allowsToPay: true,
        isActive: true,
      },
    }),
    prisma.branch.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true, isActive: true },
    }),
    pincodesInFile.size === 0
      ? Promise.resolve([])
      : prisma.pincode.findMany({
          where: { code: { in: [...pincodesInFile] } },
          select: { code: true, cityId: true, isServiceable: true, isOda: true },
        }),
    referencesInFile.size === 0
      ? Promise.resolve([])
      : prisma.shipment.findMany({
          where: { customerReference: { in: [...referencesInFile] } },
          select: { customerReference: true },
        }),
  ]);

  const services = new Map<string, ServiceFact>(
    serviceRows.map((service) => [
      service.code.toUpperCase(),
      {
        id: service.id,
        code: service.code,
        mode: service.mode as ShipmentMode,
        allowsCod: service.allowsCod,
        allowsToPay: service.allowsToPay,
        isActive: service.isActive,
      },
    ]),
  );

  const branches = new Map<string, BranchFact>(
    branchRows.map((branch) => [
      branch.code.toUpperCase(),
      { id: branch.id, code: branch.code, isActive: branch.isActive },
    ]),
  );

  const pincodes = new Map<string, PincodeFact>(
    pincodeRows.map((pincode) => [
      pincode.code,
      {
        cityId: pincode.cityId,
        isServiceable: pincode.isServiceable,
        isOda: pincode.isOda,
      },
    ]),
  );

  const existingReferences = new Set<string>(
    referenceRows
      .map((shipment) => shipment.customerReference?.toUpperCase())
      .filter((reference): reference is string => Boolean(reference)),
  );

  return {
    services,
    branches,
    pincodes,
    existingReferences,
    canOverrideServiceability: can(actor, "shipment.override_serviceability"),
  };
}
