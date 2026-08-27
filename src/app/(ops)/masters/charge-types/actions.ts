"use server";

import { z } from "zod";
import {
  createMasterCrud,
  zBool,
  zCode,
  zOptionalText,
} from "@/server/services/master-crud";

const schema = z.object({
  code: zCode(),
  name: z.string().trim().min(2, "Required").max(80),
  nature: z.enum(
    ["FREIGHT", "SURCHARGE", "HANDLING", "STATUTORY", "PENALTY", "DISCOUNT"],
    { message: "Choose a nature" },
  ),
  defaultBasis: z.enum(
    [
      "FLAT",
      "PER_KG",
      "PER_PACKAGE",
      "PER_KM",
      "PER_HOUR",
      "PERCENT_OF_FREIGHT",
      "PERCENT_OF_DECLARED_VALUE",
      "PERCENT_OF_COD",
    ],
    { message: "Choose a basis" },
  ),
  taxRateId: zOptionalText(40),
  isTaxable: zBool,
  isCustomerVisible: zBool,
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "chargeType",
  entity: "ChargeType",
  refField: "code",
  label: "Charge head",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/charge-types",
});

export const createChargeType = crud.create;
export const updateChargeType = crud.update;
export const setChargeTypeActive = crud.setActive;
