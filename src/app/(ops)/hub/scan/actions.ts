"use server";

import { z } from "zod";
import type { ScanType } from "@/generated/prisma/client";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordScan, SCAN_PERMISSION, type ScanOutcome } from "@/lib/hub/scan";
import { recordAudit } from "@/server/services/audit";

/**
 * The dock's one server action.
 *
 * Deliberately narrow and deliberately fast: everything the screen needs
 * comes back from a single round trip, because a clerk holding a box
 * cannot wait for a page revalidation. Nothing is revalidated here — the
 * console updates from the returned outcome.
 */

const schema = z.object({
  barcode: z.string().trim().min(1, "Nothing was scanned").max(120),
  scanType: z.enum([
    "INBOUND",
    "OUTBOUND",
    "SORT",
    "LOAD",
    "UNLOAD",
    "AUDIT",
  ]),
  branchId: z.string().min(1),
  idempotencyKey: z.string().uuid("A scan must carry an idempotency key"),
  binId: z.string().nullish(),
  deviceId: z.string().nullish(),
  /** Device clock, ISO. Kept distinct from the server's recordedAt. */
  scannedAt: z.string().datetime().nullish(),
});

export type ScanActionResult =
  | { ok: true; outcome: ScanOutcome }
  | { ok: false; error: string };

export async function submitScan(
  input: z.input<typeof schema>,
): Promise<ScanActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad scan." };
  }

  const data = parsed.data;
  const scanType = data.scanType as ScanType;

  try {
    const actor = await authorize(SCAN_PERMISSION[scanType]);

    const outcome = await recordScan(
      {
        barcode: data.barcode,
        scanType,
        branchId: data.branchId,
        idempotencyKey: data.idempotencyKey,
        // A device clock ahead of or behind the server is recorded as it
        // was; `appendShipmentEvent` measures the drift rather than
        // silently trusting either one.
        scannedAt: data.scannedAt ? new Date(data.scannedAt) : undefined,
        deviceId: data.deviceId ?? null,
        binId: data.binId ?? null,
      },
      actor,
    );

    // Audited at the record, not per session: a scan is a custody event
    // and the audit trail is where a dispute is settled.
    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "ScanRecord",
      entityId: outcome.scanRecordId ?? "rejected",
      entityRef: outcome.barcode,
      branchId: data.branchId,
      after: {
        scanType,
        recognised: outcome.recognised,
        isExpected: outcome.isExpected,
        lrNumber: outcome.lrNumber,
        newStatus: outcome.newStatus,
      },
    });

    return { ok: true, outcome };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: "You do not have permission for that scan." };
    }
    console.error("[hub/scan]", error);
    return { ok: false, error: "The scan could not be recorded. Try again." };
  }
}
