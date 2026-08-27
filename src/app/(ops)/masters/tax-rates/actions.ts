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
  kind: z.enum(["GST", "IGST", "CGST", "SGST", "CESS", "TDS"], {
    message: "Choose a tax kind",
  }),
  ratePercent: z.coerce
    .number()
    .min(0, "Cannot be negative")
    .max(100, "Cannot exceed 100%"),
  isReverseCharge: zBool,
  hsnSac: zOptionalText(20),
  effectiveFrom: z.coerce.date({ message: "Enter a valid date" }),
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "taxRate",
  entity: "TaxRate",
  refField: "code",
  label: "Tax rate",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/tax-rates",
});

export const createTaxRate = crud.create;
export const updateTaxRate = crud.update;
export const setTaxRateActive = crud.setActive;
