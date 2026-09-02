import type { SessionUser } from "@/lib/auth/session";
import type { ShipmentMode, SlaState } from "@/generated/prisma/client";

/**
 * The shape every report in the library shares.
 *
 * One type, nineteen reports. The alternative — each screen fetching and
 * rendering its own way — is how a report library becomes nineteen
 * half-maintained pages where only four of them export properly and none
 * of them agree on what "branch" means.
 */

// ────────────────────────────────────────────────────────────
// Filters
// ────────────────────────────────────────────────────────────

export type FilterKey =
  | "dates"
  | "branch"
  | "customer"
  | "lane"
  | "serviceType"
  | "mode"
  /** SLA state, so a dashboard tile can link to the rows it counted. */
  | "sla"
  | "search";

export type ReportFilters = {
  /** Inclusive start, at the branch's local midnight. */
  from: Date;
  /** Inclusive end, at the branch's local end of day. */
  to: Date;
  branchId: string | null;
  customerId: string | null;
  originBranchId: string | null;
  destinationBranchId: string | null;
  serviceTypeId: string | null;
  mode: ShipmentMode | null;
  /**
   * The SLA verdict, when a reader asked for one slice of it.
   *
   * Exists because the operations dashboard counts "SLA breached" and had
   * nowhere to send anyone who clicked it: the nearest report showed
   * everything in the network, so the tile said 14 and the page it opened
   * said 900. A tile that cannot be drilled into is a tile nobody trusts
   * twice.
   */
  slaState: SlaState | null;
  q: string | null;
};

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────

export type ColumnType =
  | "text"
  /** Monospaced: LR numbers, codes, registrations. */
  | "code"
  | "number"
  | "money"
  | "weight"
  | "percent"
  /** Minutes, rendered as "2 d 4 h". */
  | "duration"
  | "date"
  | "datetime"
  /** A coloured pill. The cell value is the label. */
  | "state";

export type ReportColumn = {
  key: string;
  label: string;
  type?: ColumnType;
  /** Dropped from CSV and XLSX when false — links and pills, mostly. */
  exportable?: boolean;
};

export type Cell = string | number | null;

export type ReportRow = {
  key: string;
  cells: Record<string, Cell>;
  /** Deep link on the first column, so a row leads somewhere. */
  href?: string;
  /** Semantic tone for a `state` cell, keyed by column. */
  tones?: Record<string, "ok" | "warn" | "bad" | "info" | "muted">;
};

export type ReportResult = {
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Rows matching the filters, not rows on this page. */
  total: number;
  /** A footer row of totals, keyed by column. */
  totals?: Record<string, Cell>;
  /**
   * Set when the report cannot be produced yet — an honest sentence, not
   * a table of zeroes. Phase 6 billing lands separately, and a revenue
   * report reading zero because invoicing does not exist is a lie the
   * reader has no way to detect.
   */
  unavailable?: string;
  /** A caveat worth reading before acting on the numbers. */
  note?: string;
};

export type ReportContext = {
  user: SessionUser;
  filters: ReportFilters;
  page: number;
  pageSize: number;
};

export type ReportGroup = "operations" | "financial" | "people";

export type ReportDef = {
  /** Stable: it is in URLs, `SavedReport.reportKey`, and `ReportRun`. */
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  permission: "report.operations" | "report.financial" | "report.management";
  /**
   * Lucide icon NAME, not the component. A server component may not hand
   * a function to a client one, and passing the name keeps the boundary
   * honest rather than accidentally making every report page a client
   * component.
   */
  icon: string;
  /** Which filter controls to show. Others are hidden, not ignored. */
  filters: FilterKey[];
  run(context: ReportContext): Promise<ReportResult>;
};

export const GROUP_LABEL: Record<ReportGroup, string> = {
  operations: "Operations",
  financial: "Financial",
  people: "Customer & people",
};

export const GROUP_DESCRIPTION: Record<ReportGroup, string> = {
  operations:
    "What moved, what did not, and where it is stuck. Built from the shipment event log.",
  financial:
    "Money in and money out. Some of these fill in as Phase 6 billing lands.",
  people:
    "Who the network served and how well the people in it performed.",
};

/** Rows per page on screen. Exports page through the same runner. */
export const PAGE_SIZE = 50;
