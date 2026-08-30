"use server";

import { z } from "zod";
import {
  createMasterCrud,
  orgDefaults,
  zBool,
  zCode,
  zOptionalDecimal,
  zOptionalText,
} from "@/server/services/master-crud";

const timeOfDay = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm")
    .nullable(),
);

const schema = z.object({
  code: zCode(2, 20),
  name: z.string().trim().min(2, "Required").max(120),
  type: z.enum(["HEAD_OFFICE", "HUB", "BRANCH", "WAREHOUSE", "FRANCHISE"], {
    message: "Choose a type",
  }),
  parentId: zOptionalText(40),
  cityId: z.string().min(1, "Choose a city"),
  address: z.string().trim().min(4, "Required").max(300),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Six digits"),
  phone: zOptionalText(20),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  gstin: zOptionalText(20),
  latitude: zOptionalDecimal(-90, 90),
  longitude: zOptionalDecimal(-180, 180),
  bookingCutoff: timeOfDay,
  openingTime: timeOfDay,
  closingTime: timeOfDay,
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "branch",
  entity: "Branch",
  refField: "code",
  label: "Branch",
  readPermission: "branch.read",
  writePermission: "branch.manage",
  schema,
  path: "/masters/branches",
  createDefaults: orgDefaults,
  planLimit: "branches",
});

export const createBranch = crud.create;
export const updateBranch = crud.update;
export const setBranchActive = crud.setActive;
