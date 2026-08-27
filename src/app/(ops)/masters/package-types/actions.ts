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
  description: zOptionalText(),
  isFragile: zBool,
  isStackable: zBool,
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "packageType",
  entity: "PackageType",
  refField: "code",
  label: "Package type",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/package-types",
});

export const createPackageType = crud.create;
export const updatePackageType = crud.update;
export const setPackageTypeActive = crud.setActive;
