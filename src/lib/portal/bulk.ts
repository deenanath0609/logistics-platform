import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { CustomerSession } from "@/lib/auth/customer-session";
import {
  createBulkBatch,
  readRowNotes,
  revalidateBatch,
  updateBatchRow,
  type UploadResult,
} from "@/lib/bulk/batch";
import { commitBatch, type CommitResult } from "@/lib/bulk/commit";
import { COLUMN_BY_FIELD, COLUMNS } from "@/lib/bulk/columns";
import { bookingActorFor } from "./service-actor";
import { customerOwnedFilter } from "./visibility";

/**
 * Bulk booking from the portal.
 *
 * The validator, the staging table, the marked-up grid and the partial
 * commit are `src/lib/bulk/**` exactly as the branch counter uses them.
 * Duplicating any of it would mean a customer's file being judged by a
 * second copy of the rules that drifts from the first — which is the
 * failure this whole module exists to avoid.
 *
 * What the portal adds is one thing, and it is the only thing that matters
 * here: **the account is not an input.**
 *
 *  · The consignor is the signed-in account, welded on server-side. There
 *    is no column for it in the template, the parser discards any column
 *    it does not recognise, and `consignorForSession` ignores the row
 *    entirely rather than reading a field from it. A file cannot book on
 *    somebody else's account because there is no path by which a file's
 *    contents reach that decision.
 *  · The booking branch follows the account, not the file.
 *  · Every read of a batch is scoped by `customerId` in the WHERE clause.
 *
 * The consignor is stamped after the commit rather than passed through it:
 * `commitBatch` is shared with operations and takes no account argument.
 * See `stampConsignor` for why that is safe and why it is also repaired on
 * every read.
 */

// ────────────────────────────────────────────────────────────
// The account is not an input
// ────────────────────────────────────────────────────────────

/**
 * Column headers that look like an attempt to name an account.
 *
 * The parser already discards unknown headers, so none of these has any
 * effect. They are recognised only so the upload screen can *say* it
 * ignored them — a customer whose own system exports a "Customer Code"
 * column deserves to be told it was disregarded rather than left to assume
 * it was honoured.
 */
const ACCOUNT_HEADERS = [
  "customer",
  "customercode",
  "customerid",
  "customername",
  "account",
  "accountcode",
  "accountid",
  "consignor",
  "consignorcode",
  "consignorid",
  "consignoraccount",
  "billto",
  "billtoparty",
  "billingaccount",
];

/**
 * The columns the portal writes itself, from the PIN codes. Never taken
 * from the file and never editable in the grid — see `applyPortalRouting`.
 */
export const ROUTED_FIELDS: ReadonlySet<string> = new Set([
  "originBranchCode",
  "destinationBranchCode",
]);

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Which of the file's unknown headers named an account we ignored. */
export function ignoredAccountColumns(
  unknownHeaders: readonly string[],
): string[] {
  return unknownHeaders.filter((header) =>
    ACCOUNT_HEADERS.includes(normaliseHeader(header)),
  );
}

/**
 * The consignor a portal-booked row belongs to.
 *
 * Takes the row deliberately, and deliberately does not read it. Written
 * this way so the property is a testable fact rather than an absence
 * somebody has to notice: hand it a row claiming `consignorId:
 * "cust_rival"` and it still returns the session's own account.
 */
export function consignorForSession(
  session: CustomerSession,
  _row?: Record<string, unknown>,
): { consignorId: string; bookedByCustomerUserId: string } {
  const consignorId = session.customerId?.trim();
  if (!consignorId) {
    // Same discipline as `customerShipmentFilter`: fail closed rather than
    // book an unattributed consignment.
    throw new Error(
      "A portal bulk commit needs an account. Refusing to book unattributed.",
    );
  }
  return { consignorId, bookedByCustomerUserId: session.id };
}

// ────────────────────────────────────────────────────────────
// Upload
// ────────────────────────────────────────────────────────────

export type PortalUploadResult =
  | (Extract<UploadResult, { ok: true }> & {
      /** Rows whose branch codes the portal filled in from the PIN codes. */
      routedRows: number;
      /** Account columns the parser discarded, named so we can say so. */
      ignoredAccountColumns: string[];
    })
  | { ok: false; error: string; missingHeaders?: string[] };

/**
 * Stages a customer's file.
 *
 * The branch the batch books against is resolved from the account — its
 * own branch first, then the branch serving its default pickup PIN code.
 * A branch posted from a browser would be a customer with a lever on the
 * network's routing, so there is no parameter for it.
 */
export async function createPortalBulkBatch(
  session: CustomerSession,
  input: { fileName: string; contentType: string; bytes: Buffer },
): Promise<PortalUploadResult> {
  const customer = await prisma.customer.findUnique({
    where: { id: session.customerId },
    select: { branchId: true, isBlocked: true, blockReason: true },
  });

  if (!customer) return { ok: false, error: "That account no longer exists." };
  if (customer.isBlocked) {
    return {
      ok: false,
      error:
        customer.blockReason ??
        "Bookings on this account are on hold. Please speak to your account manager.",
    };
  }

  const branchId = customer.branchId ?? (await defaultBranchForAccount(session));
  if (!branchId) {
    return {
      ok: false,
      error:
        "We could not work out which branch should handle this file. Please speak to your account manager.",
    };
  }

  const actor = await bookingActorFor(session);
  const result = await createBulkBatch(
    {
      fileName: input.fileName,
      contentType: input.contentType,
      bytes: input.bytes,
      branchId,
    },
    actor,
  );

  if (!result.ok) return result;

  // Ownership is stamped immediately, and before anything can be read: a
  // batch with no `customerId` is invisible to `portalBatchScope`, so a
  // failure here loses the customer their batch rather than exposing it.
  await prisma.bulkUploadBatch.update({
    where: { id: result.batchId },
    data: {
      customerId: session.customerId,
      uploadedByCustomerUserId: session.id,
    },
  });

  // Routing is decided here, not in the file. This also revalidates, so
  // the tallies below are refreshed from it.
  const routed = await applyPortalRouting(session, result.batchId);
  const revalidated = await revalidateBatch(result.batchId, actor);

  return {
    ...result,
    validRows: revalidated.ok ? revalidated.summary.validCount : result.validRows,
    invalidRows: revalidated.ok
      ? revalidated.summary.invalidCount
      : result.invalidRows,
    routedRows: routed,
    ignoredAccountColumns: ignoredAccountColumns(result.unknownHeaders),
  };
}

/**
 * Fills in the branch codes from the PIN codes, overriding the file.
 *
 * The shared column schema requires an origin and a destination branch
 * code, because a booking clerk knows them and a lane sometimes has to be
 * forced. A customer knows neither, and should not: which branch handles
 * a consignment is the network's decision, exactly as it is for a single
 * portal booking — see `resolveBookingBranches`, which applies the same
 * rule one shipment at a time.
 *
 * So the portal derives both and writes them over whatever the file said:
 * origin from the account's own branch (falling back to the collection
 * PIN), destination from the delivery PIN. A customer's spreadsheet
 * therefore never has to carry a branch code, and cannot route around the
 * network by carrying one.
 *
 * Written straight to the staged row rather than through `updateBatchRow`
 * on purpose: that function audits every cell change, and a five-thousand
 * row file would put five thousand rows into the audit log for a
 * normalisation the customer never made. The change is recorded once, on
 * the batch, by the upload audit `createBulkBatch` already wrote.
 */
async function applyPortalRouting(
  session: CustomerSession,
  batchId: string,
): Promise<number> {
  const rows = await prisma.bulkUploadRow.findMany({
    where: { batchId },
    select: { id: true, raw: true },
  });
  if (rows.length === 0) return 0;

  const pins = new Set<string>();
  for (const row of rows) {
    const raw = asRawCells(row.raw);
    for (const key of ["consignorPincode", "consigneePincode"] as const) {
      const value = (raw[key] ?? "").trim();
      if (/^\d{6}$/.test(value)) pins.add(value);
    }
  }

  const [customer, pincodes] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: session.customerId },
      select: { branch: { select: { code: true } } },
    }),
    pins.size === 0
      ? Promise.resolve([])
      : prisma.pincode.findMany({
          where: { code: { in: [...pins] } },
          select: { code: true, servingBranch: { select: { code: true } } },
        }),
  ]);

  const branchForPin = new Map(
    pincodes.map((pincode) => [pincode.code, pincode.servingBranch?.code ?? null]),
  );
  const accountBranchCode = customer?.branch?.code ?? null;

  const patches: Array<{ id: string; raw: Record<string, string> }> = [];

  for (const row of rows) {
    const raw = asRawCells(row.raw);
    const origin =
      accountBranchCode ??
      branchForPin.get((raw.consignorPincode ?? "").trim()) ??
      null;
    const destination =
      branchForPin.get((raw.consigneePincode ?? "").trim()) ?? null;

    // Where we cannot derive a branch the row keeps what it had, so the
    // validator's complaint lands on the PIN code — which is the thing the
    // customer can actually do something about.
    const next = {
      ...raw,
      originBranchCode: origin ?? raw.originBranchCode ?? "",
      destinationBranchCode: destination ?? raw.destinationBranchCode ?? "",
    };

    if (
      next.originBranchCode === (raw.originBranchCode ?? "") &&
      next.destinationBranchCode === (raw.destinationBranchCode ?? "")
    ) {
      continue;
    }
    patches.push({ id: row.id, raw: next });
  }

  // Chunked, and never in one transaction: a staging rewrite must not hold
  // a lock across five thousand rows.
  const CHUNK = 100;
  for (let i = 0; i < patches.length; i += CHUNK) {
    await Promise.all(
      patches.slice(i, i + CHUNK).map((patch) =>
        prisma.bulkUploadRow.update({
          where: { id: patch.id },
          data: { raw: patch.raw as Prisma.InputJsonValue },
        }),
      ),
    );
  }

  return patches.length;
}

function asRawCells(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, cell]) => [
      key,
      cell === null || cell === undefined ? "" : String(cell),
    ]),
  );
}

async function defaultBranchForAccount(
  session: CustomerSession,
): Promise<string | null> {
  const address = await prisma.customerAddress.findFirst({
    where: { ...customerOwnedFilter(session), isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { pincode: true },
  });
  if (!address) return null;

  // PIN codes are per-tenant geography, so the code alone is no longer a
  // unique key — the tenant filter is the rest of it.
  const pincode = await prisma.pincode.findFirst({
    where: { code: address.pincode },
    select: { servingBranchId: true },
  });
  return pincode?.servingBranchId ?? null;
}

// ────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────

/**
 * The `where` fragment every portal batch read starts from.
 *
 * `customerId` is written last and unconditionally, and an empty account
 * throws rather than matching every batch in the network — the same
 * discipline as `customerShipmentFilter`, for the same reason.
 *
 * Scoped to the *account*, not to the login: colleagues on one account
 * share a queue, and a bulk file uploaded by someone who has since left
 * must not become unreachable.
 */
export function portalBatchScope(session: CustomerSession): {
  customerId: string;
} {
  return customerOwnedFilter(session);
}

export type PortalBatchRow = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  committedRows: number;
  createdAt: Date;
  uploadedBy: string | null;
};

export async function listPortalBatches(
  session: CustomerSession,
  options: { take?: number } = {},
): Promise<PortalBatchRow[]> {
  const rows = await prisma.bulkUploadBatch.findMany({
    where: { ...portalBatchScope(session) },
    orderBy: { createdAt: "desc" },
    take: options.take ?? 25,
    select: {
      id: true,
      fileName: true,
      status: true,
      totalRows: true,
      validRows: true,
      invalidRows: true,
      committedRows: true,
      createdAt: true,
      uploadedByCustomerUser: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    totalRows: row.totalRows,
    validRows: row.validRows,
    invalidRows: row.invalidRows,
    committedRows: row.committedRows,
    createdAt: row.createdAt,
    uploadedBy: row.uploadedByCustomerUser?.name ?? null,
  }));
}

export type PortalGridRow = {
  rowNumber: number;
  status: "PENDING" | "VALID" | "INVALID" | "COMMITTED" | "SKIPPED";
  cells: Record<string, string>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  lrNumber: string | null;
  shipmentId: string | null;
};

export type PortalBatchDetail = {
  id: string;
  fileName: string;
  status: string;
  createdAt: Date;
  editable: boolean;
  rows: PortalGridRow[];
  readyRows: number;
  invalidRows: number;
  committedRows: number;
  /** The commonest rejection reasons, so a big file has a headline. */
  topReasons: Array<{ message: string; count: number }>;
};

/** One batch, if and only if it belongs to this account. */
export async function getPortalBatch(
  session: CustomerSession,
  batchId: string,
): Promise<PortalBatchDetail | null> {
  const batch = await prisma.bulkUploadBatch.findFirst({
    where: { ...portalBatchScope(session), id: batchId },
    select: {
      id: true,
      fileName: true,
      status: true,
      createdAt: true,
      rows: {
        orderBy: { rowNumber: "asc" },
        select: {
          rowNumber: true,
          raw: true,
          status: true,
          errors: true,
          lrNumber: true,
          shipmentId: true,
        },
      },
    },
  });

  if (!batch) return null;

  // Repairs any consignment booked by an earlier commit that died between
  // the booking and the stamp. Cheap, idempotent, and it means the window
  // is measured in seconds rather than for ever.
  await stampConsignor(
    session,
    batch.rows.map((row) => row.shipmentId).filter((id): id is string => Boolean(id)),
  );

  const rows: PortalGridRow[] = batch.rows.map((row) => {
    const notes = readRowNotes(row.errors);
    const raw = (row.raw ?? {}) as Record<string, unknown>;

    return {
      rowNumber: row.rowNumber,
      status: row.status,
      cells: Object.fromEntries(
        COLUMNS.map((column) => [
          column.field,
          raw[column.field] === null || raw[column.field] === undefined
            ? ""
            : String(raw[column.field]),
        ]),
      ),
      errors: notes.errors,
      warnings: notes.warnings,
      lrNumber: row.lrNumber,
      shipmentId: row.shipmentId,
    };
  });

  const reasons = new Map<string, number>();
  for (const row of rows) {
    for (const message of Object.values(row.errors)) {
      reasons.set(message, (reasons.get(message) ?? 0) + 1);
    }
  }

  return {
    id: batch.id,
    fileName: batch.fileName,
    status: batch.status,
    createdAt: batch.createdAt,
    editable: batch.status !== "ABANDONED",
    rows,
    // Counted from the rows rather than from the batch tallies, so a stale
    // tally can never hide work from the customer.
    readyRows: rows.filter((row) => row.status === "VALID").length,
    invalidRows: rows.filter((row) => row.status === "INVALID").length,
    committedRows: rows.filter((row) => row.status === "COMMITTED").length,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([message, count]) => ({ message, count })),
  };
}

// ────────────────────────────────────────────────────────────
// Correction and commit
// ────────────────────────────────────────────────────────────

/** Confirms a batch belongs to this account before anything writes to it. */
async function ownsBatch(
  session: CustomerSession,
  batchId: string,
): Promise<boolean> {
  const count = await prisma.bulkUploadBatch.count({
    where: { ...portalBatchScope(session), id: batchId },
  });
  return count > 0;
}

export type PortalRowPatchResult =
  | { ok: true; stillInvalid: Record<string, string> }
  | { ok: false; error: string };

/** Applies an inline correction to one staged row of this account's batch. */
export async function patchPortalBatchRow(
  session: CustomerSession,
  input: { batchId: string; rowNumber: number; patch: Record<string, string> },
): Promise<PortalRowPatchResult> {
  if (!(await ownsBatch(session, input.batchId))) {
    return { ok: false, error: "That batch is not on your account." };
  }

  // Only declared columns are writable — the same guard the ops screen
  // applies, restated here because this call site takes its patch from a
  // browser form rather than from the ops one.
  //
  // The two routing columns are excluded on top of that. `applyPortalRouting`
  // owns them, and a correction the next re-check silently overwrites is
  // worse than no field at all — but the real reason is that letting a
  // posted form set a branch code would put the network's routing back in
  // the customer's hands through the side door.
  const patch: Record<string, string> = {};
  for (const [field, value] of Object.entries(input.patch)) {
    if (!COLUMN_BY_FIELD.has(field)) continue;
    if (ROUTED_FIELDS.has(field)) continue;
    patch[field] = String(value ?? "").trim();
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Nothing was changed." };
  }

  const actor = await bookingActorFor(session);

  const updated = await updateBatchRow(
    { batchId: input.batchId, rowNumber: input.rowNumber, patch },
    actor,
  );
  if (!updated.ok) return updated;

  const revalidated = await revalidateBatch(input.batchId, actor);
  if (!revalidated.ok) return revalidated;

  const row = revalidated.summary.rows.find((r) => r.rowNumber === input.rowNumber);
  return { ok: true, stillInvalid: row?.errors ?? {} };
}

export async function revalidatePortalBatch(
  session: CustomerSession,
  batchId: string,
): Promise<{ ok: true; valid: number; invalid: number } | { ok: false; error: string }> {
  if (!(await ownsBatch(session, batchId))) {
    return { ok: false, error: "That batch is not on your account." };
  }

  const actor = await bookingActorFor(session);
  const result = await revalidateBatch(batchId, actor);
  if (!result.ok) return result;

  return {
    ok: true,
    valid: result.summary.validCount,
    invalid: result.summary.invalidCount,
  };
}

export type PortalCommitResult =
  | (Extract<CommitResult, { ok: true }> & { stamped: number })
  | { ok: false; error: string };

/**
 * Books the valid rows of this account's batch.
 *
 * Straight through to the shared committer — same partial commit, same
 * per-row `bulk:<batchId>:<rowNumber>` idempotency key, so a customer who
 * presses Confirm twice on a flaky connection books their two hundred
 * consignments once.
 */
export async function commitPortalBatch(
  session: CustomerSession,
  input: { batchId: string; rowNumbers?: number[] },
): Promise<PortalCommitResult> {
  if (!(await ownsBatch(session, input.batchId))) {
    return { ok: false, error: "That batch is not on your account." };
  }

  const actor = await bookingActorFor(session);
  const result = await commitBatch(input, actor);
  if (!result.ok) return result;

  const stamped = await stampConsignor(
    session,
    result.outcomes
      .map((outcome) => outcome.shipmentId)
      .filter((id): id is string => Boolean(id)),
  );

  return { ...result, stamped };
}

/**
 * Welds an account onto consignments a bulk commit booked.
 *
 * `commitBatch` is shared with the branch counter and takes no account —
 * a clerk's file books walk-in consignors, so `Shipment.consignorId` is
 * left null there by design. Anything booked out of a *customer's* file
 * must set it: it is the column `customerShipmentFilter` pins on, so an
 * unstamped consignment is invisible to the very customer who booked it.
 *
 * Three properties make the after-the-fact stamp safe:
 *
 *  1. The ids come from *this* commit's outcomes, not from the file.
 *  2. `consignorId: null` is in the WHERE clause, so it can only ever fill
 *     a blank — it cannot move a consignment from one account to another,
 *     including one booked at a counter and matched by a guessed id.
 *  3. It is idempotent, so it can be re-run on every read of the batch and
 *     a process that died between the booking and the stamp leaves a gap
 *     measured in seconds.
 *
 * `currentStatus` is not touched. Attribution is not a state change, and
 * anything that is goes through `appendShipmentEvent`.
 *
 * Exported because there are two callers and there must not be two
 * copies. The portal's own commit is one; the other is the ops screen at
 * `/shipments/bulk`, where a clerk books a customer's file over the
 * telephone — that path had no stamp at all, so the consignments came out
 * with no consignor and the customer's portal showed them nothing until
 * somebody happened to open the batch page and trip the repair-on-read
 * below. `customerUserId` is null there: no portal login did it.
 */
export async function stampBulkConsignor(input: {
  customerId: string;
  /** The portal login who committed, when one did. */
  customerUserId?: string | null;
  shipmentIds: readonly string[];
}): Promise<number> {
  const consignorId = input.customerId?.trim();
  if (!consignorId || input.shipmentIds.length === 0) return 0;

  const ids = [...new Set(input.shipmentIds)];

  // Chunked so a five-thousand row batch does not become one statement
  // with a five-thousand element `IN` list every time somebody opens the
  // page.
  const CHUNK = 500;
  let stamped = 0;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const result = await prisma.shipment.updateMany({
      where: { id: { in: ids.slice(i, i + CHUNK) }, consignorId: null },
      data: {
        consignorId,
        // Absent rather than null when there is no portal login, so a
        // counter commit cannot blank an author a portal commit set.
        ...(input.customerUserId
          ? { bookedByCustomerUserId: input.customerUserId }
          : {}),
      },
    });
    stamped += result.count;
  }

  return stamped;
}

/** The portal's own call site — the account comes from the session. */
async function stampConsignor(
  session: CustomerSession,
  shipmentIds: readonly string[],
): Promise<number> {
  if (shipmentIds.length === 0) return 0;

  const { consignorId, bookedByCustomerUserId } = consignorForSession(session);
  return stampBulkConsignor({
    customerId: consignorId,
    customerUserId: bookedByCustomerUserId,
    shipmentIds,
  });
}
