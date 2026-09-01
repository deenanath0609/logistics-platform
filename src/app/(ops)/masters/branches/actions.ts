"use server";

import { z } from "zod";
import { authorize } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import {
  createMasterCrud,
  orgDefaults,
  zBool,
  zCode,
  zOptionalDecimal,
  zOptionalText,
  type ActionState,
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

/**
 * ── A branch is the one master that is also a boundary ───────────────────
 *
 * `createMasterCrud` looks a row up by the id on the form and rewrites it.
 * That is right for a charge head or a package type, which belong to the
 * carrier as a whole. It is wrong here: `Branch` is the column every other
 * scope check in the product points at, and this listing is itself scoped —
 * `/masters/branches` only shows nodes the reader covers.
 *
 * Nothing could reach it before, because `branch.manage` shipped only on
 * network-wide roles. Roles can now be created and scoped from
 * `/admin/roles`, so a branch-scoped role holding `branch.manage` is a
 * thing a carrier can make — and without this, such a person could rename
 * another branch, move its address, or deactivate it outright by posting
 * its id. Deactivating one is not cosmetic: it drops out of every picker,
 * and the freight already routed to it stops having a destination anybody
 * can choose.
 *
 * Creation is not guarded the same way. A new branch has no id to be
 * outside anyone's scope, and the plan cap is what limits it.
 */
function outsideScope(): ActionState {
  return { error: "That branch is outside the branches you cover." };
}

async function guardBranchId(formData: FormData): Promise<ActionState | null> {
  let actor;
  try {
    actor = await authorize("branch.manage");
  } catch {
    // Let the CRUD answer it: it authorises again and words the refusal the
    // same way every other master does. Swallowed rather than rethrown so
    // this guard can only ever *add* a refusal, never change an existing one.
    return null;
  }

  const id = String(formData.get("id") ?? "");
  if (!id) return null; // The CRUD refuses that too, with its own wording.
  return coversBranch(actor, id) ? null : outsideScope();
}

export const createBranch = crud.create;

export async function updateBranch(
  prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const refusal = await guardBranchId(formData);
  return refusal ?? crud.update(prev, formData);
}

export async function setBranchActive(
  prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const refusal = await guardBranchId(formData);
  return refusal ?? crud.setActive(prev, formData);
}
