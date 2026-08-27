"use server";

import { z } from "zod";
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
});

export const createVehicleType = crud.create;
export const updateVehicleType = crud.update;
export const setVehicleTypeActive = crud.setActive;
