"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize, PermissionError } from "@/lib/auth/session";
import {
  addShipmentsToRun,
  createDeliveryRun,
  removeTaskFromRun,
  resequenceRun,
} from "@/lib/delivery/runs";
import { initiateRto } from "@/lib/delivery/execute";
import { recordAudit } from "@/server/services/audit";

const PATH = "/delivery/runs";

export type RunActionState = {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  console.error("[delivery/runs]", error);
  return "Something went wrong. Nothing was changed.";
}

const createSchema = z.object({
  branchId: z.string().min(1, "Choose a branch"),
  agentId: z.string().min(1, "Choose an agent"),
  vehicleId: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().nullable(),
  ),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
});

export async function createRunAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  try {
    const actor = await authorize("delivery.assign");
    const parsed = createSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { fieldErrors };
    }

    // The date arrives as `yyyy-mm-dd` from the picker and must land on
    // local midnight — a UTC parse puts an Indian morning run on yesterday.
    const [year, month, day] = parsed.data.runDate.split("-").map(Number);
    const runDate = new Date(year, month - 1, day);

    const result = await createDeliveryRun(
      {
        branchId: parsed.data.branchId,
        agentId: parsed.data.agentId,
        vehicleId: parsed.data.vehicleId,
        runDate,
      },
      actor,
    );

    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "DeliveryRun",
      entityId: result.runId,
      entityRef: result.number,
      branchId: parsed.data.branchId,
      after: { agentId: parsed.data.agentId, runDate: parsed.data.runDate },
    });

    revalidatePath(PATH);
    return { message: `Run ${result.number} created.` };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function addStopsAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  try {
    const actor = await authorize("delivery.assign");
    const runId = String(formData.get("runId") ?? "");
    const shipmentIds = formData.getAll("shipmentIds").map(String).filter(Boolean);

    if (!runId) return { error: "Which run?" };
    if (shipmentIds.length === 0) {
      return { error: "Select at least one shipment." };
    }

    const result = await addShipmentsToRun(runId, shipmentIds, actor);
    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "UPDATE",
      entity: "DeliveryRun",
      entityId: runId,
      after: { added: result.added, skipped: result.skipped },
    });

    revalidatePath(`${PATH}/${runId}`);

    // Skipped rows are named, not counted. "3 could not be added" is not
    // something a branch can act on at seven in the morning.
    const skipped = result.skipped.length
      ? ` Not added: ${result.skipped.map((s) => `${s.lrNumber} (${s.reason})`).join(", ")}.`
      : "";

    return {
      message: `${result.added} stop${result.added === 1 ? "" : "s"} added.${skipped}`,
      error: result.added === 0 && result.skipped.length ? `Nothing was added.${skipped}` : undefined,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function removeStopAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  try {
    const actor = await authorize("delivery.reassign");
    const taskId = String(formData.get("taskId") ?? "");
    const runId = String(formData.get("runId") ?? "");

    const result = await removeTaskFromRun(taskId, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${runId}`);
    return { message: "Stop removed. The shipment stays at the branch." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function resequenceAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  try {
    const actor = await authorize("delivery.assign");
    const runId = String(formData.get("runId") ?? "");
    const order = String(formData.get("order") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    const result = await resequenceRun(runId, order, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath(`${PATH}/${runId}`);
    return { message: "Stops resequenced." };
  } catch (error) {
    return { error: describe(error) };
  }
}

export async function initiateRtoAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  try {
    const actor = await authorize("delivery.rto");
    const shipmentId = String(formData.get("shipmentId") ?? "");
    const reasonCodeId = String(formData.get("reasonCodeId") ?? "");
    const remarks = String(formData.get("remarks") ?? "").trim() || null;

    if (!reasonCodeId) return { error: "Choose a return reason." };

    const result = await initiateRto(shipmentId, reasonCodeId, actor, remarks);
    if (!result.ok) return { error: result.error };

    await recordAudit({
      user: actor,
      action: "STATUS_CHANGE",
      entity: "Shipment",
      entityId: shipmentId,
      reason: remarks ?? "Return to origin initiated",
    });

    revalidatePath(PATH);
    revalidatePath(`/shipments/${shipmentId}`);
    return { message: "Return to origin initiated." };
  } catch (error) {
    return { error: describe(error) };
  }
}
