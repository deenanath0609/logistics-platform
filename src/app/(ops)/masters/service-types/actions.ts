"use server";

import { z } from "zod";
import {
  createMasterCrud,
  zBool,
  zCode,
  zOptionalInt,
  zOptionalText,
} from "@/server/services/master-crud";

const schema = z.object({
  code: zCode(),
  name: z.string().trim().min(2, "Required").max(80),
  mode: z.enum(["FTL", "PTL", "COURIER"], { message: "Choose a mode" }),
  description: zOptionalText(),
  volumetricDivisor: z.coerce
    .number()
    .int()
    .min(1000, "Road freight divisors are typically 4000–6000")
    .max(10000),
  defaultTransitHours: zOptionalInt(1, 720),
  maxDeliveryAttempts: z.coerce.number().int().min(1).max(10),
  allowsCod: zBool,
  allowsToPay: zBool,
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "serviceType",
  entity: "ServiceType",
  refField: "code",
  label: "Service type",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/service-types",
});

export const createServiceType = crud.create;
export const updateServiceType = crud.update;
export const setServiceTypeActive = crud.setActive;
