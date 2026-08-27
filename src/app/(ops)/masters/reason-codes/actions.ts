"use server";

import { z } from "zod";
import {
  createMasterCrud,
  zBool,
  zCode,
  zOptionalText,
} from "@/server/services/master-crud";

const schema = z.object({
  category: z.enum(
    [
      "PICKUP_FAILURE",
      "DELIVERY_FAILURE",
      "EXCEPTION",
      "CANCELLATION",
      "HOLD",
      "DAMAGE",
      "SHORTAGE",
      "RTO",
      "STATUS_CORRECTION",
    ],
    { message: "Choose a category" },
  ),
  code: zCode(2, 30),
  name: z.string().trim().min(2, "Required").max(120),
  description: zOptionalText(),
  isChargeable: zBool,
  triggersReattempt: zBool,
  triggersException: zBool,
  notifiesConsignor: zBool,
  notifiesConsignee: zBool,
  requiresPhoto: zBool,
  requiresRemarks: zBool,
  isActive: zBool,
});

const crud = createMasterCrud({
  model: "reasonCode",
  entity: "ReasonCode",
  refField: "code",
  label: "Reason code",
  readPermission: "master.read",
  writePermission: "master.manage",
  schema,
  path: "/masters/reason-codes",
});

export const createReasonCode = crud.create;
export const updateReasonCode = crud.update;
export const setReasonCodeActive = crud.setActive;
