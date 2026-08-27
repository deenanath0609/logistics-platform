import { formatMoney, formatDate } from "./format";

/**
 * The stored calculation trace, rendered.
 *
 * This is the answer to "why is this ₹4,280?" — read months later, from
 * stored JSON, without re-running the engine. It is deliberately verbose:
 * the rules that did *not* apply are as much of the answer as the ones
 * that did, and a customer arguing about an ODA charge wants to see that
 * the PIN was classified out-of-area, not just that a line appeared.
 *
 * Written against a loose shape so a trace stored by an older engine
 * version still renders rather than throwing.
 */

export type StoredTraceEntry = {
  kind?: string;
  ruleId?: string | null;
  label?: string;
  outcome?: string;
  reason?: string;
  specificity?: string;
  rank?: number;
  detail?: Record<string, string>;
};

export type StoredTrace = {
  version?: number;
  calculatedAt?: string;
  pricedOn?: string;
  shipment?: Record<string, string>;
  candidates?: Array<{
    versionId?: string;
    rateCardCode?: string;
    scope?: string;
    version?: string;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }>;
  selectedVersionId?: string | null;
  selectedSlabId?: string | null;
  unrated?: boolean;
  unratedReason?: string | null;
  entries?: StoredTraceEntry[];
  narrative?: string[];
};

const OUTCOME_TONE: Record<string, string> = {
  MATCHED: "bg-ok-muted text-ok",
  APPLIED: "bg-ok-muted text-ok",
  SKIPPED: "bg-muted text-muted-foreground",
  UNAVAILABLE: "bg-warn-muted text-warn",
};

const KIND_LABEL: Record<string, string> = {
  SLAB: "Rate slab",
  CHARGE_RULE: "Charge rule",
  FUEL: "Fuel",
  MINIMUM: "Minimum",
  TAX: "Tax",
  NOTE: "Note",
};

export function TracePanel({
  trace,
  totals,
  stage,
  calculatedAt,
}: {
  trace: StoredTrace | null | undefined;
  totals?: {
    chargeableWeight?: string;
    freightAmount?: string;
    chargesTotal?: string;
    taxAmount?: string;
    grandTotal?: string;
  };
  stage?: string;
  calculatedAt?: Date | string;
}) {
  if (!trace) {
    return (
      <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
        No calculation was stored for this consignment. It was priced by hand,
        or booked before the rating engine was switched on.
      </p>
    );
  }

  const entries = trace.entries ?? [];
  const applied = entries.filter(
    (entry) => entry.outcome === "MATCHED" || entry.outcome === "APPLIED",
  );
  const skipped = entries.filter(
    (entry) => entry.outcome === "SKIPPED" || entry.outcome === "UNAVAILABLE",
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {stage && (
          <span className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-accent-foreground">
            {stage}
          </span>
        )}
        {trace.unrated && (
          <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
            Unrated lane
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          Priced on {formatDate(trace.pricedOn)}
          {calculatedAt ? ` · calculated ${formatDate(calculatedAt)}` : ""}
        </span>
      </div>

      {trace.unrated && (
        <p className="rounded-lg border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
          {trace.unratedReason ??
            "No rate rule matched this lane, so the consignment booked unrated rather than at zero."}
        </p>
      )}

      {/* The narrative first — most questions are answered by four lines. */}
      {trace.narrative && trace.narrative.length > 0 && (
        <ol className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
          {trace.narrative.map((step, index) => (
            <li key={index} className="flex gap-3 text-sm">
              <span className="font-mono text-xs text-muted-foreground tabular">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ol>
      )}

      {totals && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border bg-card p-4 sm:grid-cols-5">
          <Figure label="Chargeable" value={`${totals.chargeableWeight ?? "0"} kg`} />
          <Figure label="Base freight" value={formatMoney(totals.freightAmount)} />
          <Figure label="Charges" value={formatMoney(totals.chargesTotal)} />
          <Figure label="Tax" value={formatMoney(totals.taxAmount)} />
          <Figure label="Total" value={formatMoney(totals.grandTotal)} strong />
        </dl>
      )}

      {trace.candidates && trace.candidates.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <p className="pb-2 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            Rate cards considered
          </p>
          <ul className="flex flex-col gap-1">
            {trace.candidates.map((candidate) => (
              <li
                key={candidate.versionId ?? candidate.rateCardCode}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="font-mono text-xs">{candidate.rateCardCode}</span>
                <span className="text-xs text-muted-foreground">
                  v{candidate.version} · {candidate.scope?.toLowerCase()} ·{" "}
                  {formatDate(candidate.effectiveFrom)} –{" "}
                  {candidate.effectiveTo ? formatDate(candidate.effectiveTo) : "open"}
                </span>
                {candidate.versionId === trace.selectedVersionId && (
                  <span className="rounded-sm bg-ok-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-ok">
                    Used
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <EntryList title="Rules that applied" entries={applied} />

      {skipped.length > 0 && (
        <details className="rounded-lg border bg-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            {skipped.length} rule{skipped.length === 1 ? "" : "s"} considered and
            skipped
          </summary>
          <div className="border-t px-4 pb-4 pt-3">
            <EntryList entries={skipped} bare />
          </div>
        </details>
      )}

      {trace.shipment && (
        <details className="rounded-lg border bg-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            The inputs it priced
          </summary>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 border-t px-4 pb-4 pt-3 sm:grid-cols-3">
            {Object.entries(trace.shipment).map(([key, value]) => (
              <div key={key} className="flex flex-col">
                <dt className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                  {key}
                </dt>
                <dd className="truncate font-mono text-xs">{value || "—"}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

function EntryList({
  title,
  entries,
  bare = false,
}: {
  title?: string;
  entries: StoredTraceEntry[];
  bare?: boolean;
}) {
  if (entries.length === 0) return null;

  const body = (
    <ul className="flex flex-col divide-y">
      {entries.map((entry, index) => (
        <li
          key={`${entry.ruleId ?? "x"}-${index}`}
          className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
        >
          <span
            className={`mt-0.5 rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
              OUTCOME_TONE[entry.outcome ?? ""] ?? "bg-muted text-muted-foreground"
            }`}
          >
            {entry.outcome ?? "—"}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-medium">
              {entry.label ?? "—"}
              <span className="ml-2 font-mono text-[0.65rem] font-normal uppercase tracking-wider text-muted-foreground">
                {KIND_LABEL[entry.kind ?? ""] ?? entry.kind}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">{entry.reason}</p>
            {entry.detail && Object.keys(entry.detail).length > 0 && (
              <p className="font-mono text-[0.65rem] text-muted-foreground">
                {Object.entries(entry.detail)
                  .filter(([, value]) => value !== undefined && value !== "")
                  .map(([key, value]) => `${key}=${value}`)
                  .join("  ·  ")}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );

  if (bare) return body;

  return (
    <div className="rounded-lg border bg-card p-4">
      {title && (
        <p className="pb-2 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          {title}
        </p>
      )}
      {body}
    </div>
  );
}

function Figure({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className={`tabular ${strong ? "text-base font-semibold" : "text-sm"}`}>
        {value}
      </dd>
    </div>
  );
}
