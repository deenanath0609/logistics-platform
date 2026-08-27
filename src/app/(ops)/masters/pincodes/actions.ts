"use server";

import { z } from "zod";
import {
  createMasterCrud,
  zBool,
  zOptionalDecimal,
  zOptionalText,
} from "@/server/services/master-crud";

const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "A PIN code is exactly six digits"),
  cityId: z.string().min(1, "Choose a city"),
  areaName: zOptionalText(120),
  /// Which branch delivers here. Unassigned PINs are bookable but nobody
  /// owns the last mile, so the list flags them.
  servingBranchId: zOptionalText(40),
  latitude: zOptionalDecimal(-90, 90),
  longitude: zOptionalDecimal(-180, 180),
  isServiceable: zBool,
  isOda: zBool,
});

const crud = createMasterCrud({
  model: "pincode",
  entity: "Pincode",
  refField: "code",
  label: "PIN code",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/pincodes",
});

export const createPincode = crud.create;
export const updatePincode = crud.update;
