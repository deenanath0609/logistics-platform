"use server";

import { revalidatePath } from "next/cache";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { recordAudit } from "@/server/services/audit";
import {
  parsePincodeCsv,
  validatePincodeRows,
  summarise,
  type ValidatedRow,
} from "@/lib/masters/pincode-import";

export type ImportState = {
  error?: string;
  rows?: ValidatedRow[];
  summary?: { total: number; create: number; update: number; invalid: number };
  committed?: { created: number; updated: number; skipped: number };
  /** Echoed back so Commit works on exactly what was previewed. */
  csv?: string;
};

async function loadContext() {
  const [cities, branches, existing] = await Promise.all([
    prisma.city.findMany({ select: { id: true, name: true, code: true } }),
    prisma.branch.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true },
    }),
    prisma.pincode.findMany({ select: { code: true } }),
  ]);

  const cityByKey = new Map<string, string>();
  for (const city of cities) {
    cityByKey.set(city.name.toLowerCase(), city.id);
    cityByKey.set(city.code.toLowerCase(), city.id);
  }

  return {
    cityByKey,
    branchByCode: new Map(branches.map((b) => [b.code.toLowerCase(), b.id])),
    existing: new Set(existing.map((p) => p.code)),
  };
}

function describe(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to change master data.";
  }
  console.error("[pincode import]", error);
  return "Something went wrong. Nothing was imported.";
}

/** Parses and checks the file without writing anything. */
export async function previewImport(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  try {
    await authorize("master.manage");

    const csv = String(formData.get("csv") ?? "");
    if (!csv.trim()) {
      return { error: "Paste the CSV, or choose a file." };
    }

    const parsed = parsePincodeCsv(csv);
    if (!parsed.ok) return { error: parsed.error, csv };

    const rows = validatePincodeRows(parsed.rows, await loadContext());
    return { rows, summary: summarise(rows), csv };
  } catch (error) {
    return { error: describe(error) };
  }
}

/**
 * Writes the valid rows. Invalid rows are left alone and reported.
 *
 * Partial commit is deliberate: a file of five thousand PIN codes with
 * nine bad rows should load 4,991 of them, not refuse the lot. The nine
 * come back named so they can be fixed and re-uploaded — re-importing is
 * safe because a PIN that already exists is updated, not duplicated.
 */
export async function commitImport(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  try {
    const actor = await authorize("master.manage");

    const csv = String(formData.get("csv") ?? "");
    const parsed = parsePincodeCsv(csv);
    if (!parsed.ok) return { error: parsed.error, csv };

    const rows = validatePincodeRows(parsed.rows, await loadContext());
    const usable = rows.filter((r) => r.status !== "INVALID");

    let created = 0;
    let updated = 0;

    // Chunked so a very large file does not hold one enormous transaction
    // open, which would block every other write on the table.
    const CHUNK = 200;
    for (let i = 0; i < usable.length; i += CHUNK) {
      const chunk = usable.slice(i, i + CHUNK);

      // Awaited in sequence rather than batched, so that two rows for the
      // same PIN in one file settle in the order the file listed them.
      await tenantTransaction(async (tx) => {
        for (const row of chunk) {
          await tx.pincode.upsert({
            // The compound key: an upsert needs a genuinely unique `where`,
            // and a PIN is only unique within a carrier's own geography now.
            where: { orgId_code: { orgId: actor.orgId, code: row.code } },
            create: {
              orgId: actor.orgId,
              code: row.code,
              cityId: row.cityId!,
              areaName: row.area,
              servingBranchId: row.branchId,
              isServiceable: row.serviceable,
              isOda: row.oda,
            },
            update: {
              cityId: row.cityId!,
              areaName: row.area,
              servingBranchId: row.branchId,
              isServiceable: row.serviceable,
              isOda: row.oda,
            },
          });
        }
      });

      created += chunk.filter((r) => r.status === "NEW").length;
      updated += chunk.filter((r) => r.status === "UPDATE").length;
    }

    const summary = summarise(rows);

    await recordAudit({
      user: actor,
      action: "CREATE",
      entity: "Pincode",
      entityId: "bulk-import",
      entityRef: `${created} created, ${updated} updated`,
      reason: "Bulk pincode import",
      after: {
        created,
        updated,
        skipped: summary.invalid,
        total: summary.total,
      },
    });

    revalidatePath("/masters/pincodes");

    return {
      rows,
      summary,
      committed: { created, updated, skipped: summary.invalid },
      csv,
    };
  } catch (error) {
    return { error: describe(error) };
  }
}
