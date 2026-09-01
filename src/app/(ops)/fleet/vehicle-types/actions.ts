"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  createMasterCrud,
  zBool,
  zCode,
  zOptionalDecimal,
  zOptionalInt,
} from "@/server/services/master-crud";

/**
 * Vehicle types are fleet configuration, not general master data: the
 * capacity recorded here is what manifest utilisation and vehicle selection
 * are measured against. Writes are therefore gated on `vehicle.create`,
 * which only the fleet manager holds, rather than on the broader
 * `vehicle.update` that a transport supervisor also has.
 */
const schema = z.object({
  code: zCode(2, 20),
  name: z.string().trim().min(2, "Required").max(120),
  capacityKg: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z
      .number({ message: "Payload capacity is required" })
      .positive("Must be more than zero")
      .max(99_999_999),
  ),
  capacityCft: zOptionalDecimal(0, 99_999_999),
  lengthFt: zOptionalDecimal(0, 9999),
  widthFt: zOptionalDecimal(0, 9999),
  heightFt: zOptionalDecimal(0, 9999),
  axles: zOptionalInt(1, 12),
  // The overspeed threshold. The column existed, the tracking detector
  // reads it, and no form or schema could ever set it — so it was null on
  // every class and, in the schema's own words, "a detector with no
  // threshold is worse than none, because it looks like it is watching".
  // Bounded at a walking pace and at something no Indian goods vehicle
  // legally does, so a fat-fingered `8` or `800` is refused rather than
  // silently disabling or silently spamming the alert.
  maxSpeedKmph: zOptionalInt(5, 200),
  sortOrder: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 0 : Number(v)),
    z.number().int().min(0).max(9999),
  ),
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "vehicleType",
  entity: "VehicleType",
  refField: "code",
  label: "Vehicle type",
  readPermission: "vehicle.read",
  writePermission: "vehicle.create",
  schema,
  path: "/fleet/vehicle-types",
  /**
   * Deactivating a class the fleet is still running used to succeed in
   * silence. The class then vanished from the rate-line picker, which
   * filters `isActive: true`, so no payable rate could be expressed for
   * forty lorries that were still on the road — and nothing said why.
   * The button on the screen is disabled from the same count, so the
   * refusal is previewed rather than discovered.
   */
  blockDeactivate: async (id) => {
    const attached = await prisma.vehicle.count({
      where: { vehicleTypeId: id, deletedAt: null },
    });
    if (attached === 0) return null;
    return (
      `${attached} vehicle${attached === 1 ? " is" : "s are"} still on this class. ` +
      `Move ${attached === 1 ? "it" : "them"} to another class or retire ` +
      `${attached === 1 ? "it" : "them"} first — deactivating now would leave no rate ` +
      `expressible for a class the fleet is running.`
    );
  },
});

export const createVehicleType = crud.create;
export const updateVehicleType = crud.update;
export const setVehicleTypeActive = crud.setActive;
