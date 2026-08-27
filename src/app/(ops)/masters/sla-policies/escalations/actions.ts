"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  createMasterCrud,
  zBool,
  zOptionalText,
} from "@/server/services/master-crud";
import { KIND_ORDER } from "@/lib/exceptions/kinds";

/**
 * Server actions for the escalation ladder.
 *
 * A rung says: if nobody has touched this kind of exception `afterMinutes`
 * after it was *detected*, tell this role or this person. Minutes are from
 * detection rather than from the previous rung because §A.11 states total
 * tolerance ("2 h → regional"), and a chain of relative delays would not
 * mean what anyone reading the rule expects.
 */

const KINDS = KIND_ORDER as [string, ...string[]];

const schema = z.object({
  kind: z.enum(KINDS, { message: "Choose an exception kind" }),
  level: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z
      .number()
      .int()
      .min(1, "Levels start at 1")
      .max(9, "Nine people is not an escalation, it is a mailing list"),
  ),
  afterMinutes: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z
      .number()
      .int("Whole minutes")
      .min(1, "At least a minute")
      // Ten days. Past that nobody is being escalated to, they are being
      // told about something that has already been forgotten.
      .max(14_400, "Longer than ten days is not an escalation"),
  ),
  notifyRoleCode: zOptionalText(40),
  notifyUserId: zOptionalText(40),
  isActive: zBool,
});

async function orgDefaults() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true },
  });
  return { orgId: org.id };
}

const crud = createMasterCrud({
  model: "escalationRule",
  entity: "EscalationRule",
  refField: "kind",
  label: "Escalation rule",
  readPermission: "master.read",
  writePermission: "sla.manage",
  schema,
  path: "/masters/sla-policies/escalations",
  createDefaults: orgDefaults,
});

export const createEscalationRule = crud.create;
export const updateEscalationRule = crud.update;
export const setEscalationRuleActive = crud.setActive;
