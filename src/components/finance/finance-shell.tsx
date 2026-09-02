import Link from "next/link";
import { AGEING_BUCKETS, BUCKET_LABEL, BUCKET_TONE, type AgeingBucket } from "@/lib/billing/ageing";
import { formatMoney, formatMoneyShort } from "./format";

/**
 * The small, repeated pieces of the finance screens.
 *
 * All server components: nothing here needs interactivity, and keeping
 * them off the client is what lets a receivables page with four hundred
 * rows render in one pass.
 */

export function StatTiles({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    hint?: string;
    tone?: "default" | "ok" | "warn" | "bad" | "info";
    /**
     * Makes the tile the way in to the screen it counts.
     *
     * A tile that states a number nobody can click is a dead end wherever
     * the screen behind it is not also in the nav — which is how
     * `/finance/coverage-gaps` came to be reachable only by typing the URL.
     */
    href?: string;
  }>;
}) {
  const tones: Record<string, string> = {
    default: "",
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
    info: "text-info",
  };

  return (
    <dl className="grid grid-cols-2 gap-3 pb-6 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => {
        const body = (
          <>
            <dt className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {item.label}
            </dt>
            <dd
              className={`pt-1 text-lg font-semibold tabular ${tones[item.tone ?? "default"]}`}
            >
              {item.value}
            </dd>
            {item.hint && (
              <p className="pt-0.5 text-xs text-muted-foreground">{item.hint}</p>
            )}
          </>
        );

        return item.href ? (
          <Link
            key={item.label}
            href={item.href}
            className="rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-foreground/25 hover:bg-muted/50"
          >
            {body}
          </Link>
        ) : (
          <div key={item.label} className="rounded-lg border bg-card px-3 py-2.5">
            {body}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The ageing profile as a bar.
 *
 * Proportional widths, because "₹3.2 lakh in 90+" means nothing without
 * knowing it is four-fifths of the book.
 */
export function AgeingBar({
  buckets,
  showLabels = true,
}: {
  buckets: Record<AgeingBucket, string>;
  showLabels?: boolean;
}) {
  const values = AGEING_BUCKETS.map((bucket) => ({
    bucket,
    amount: Math.max(0, Number(buckets[bucket] ?? 0)),
  }));
  const total = values.reduce((sum, entry) => sum + entry.amount, 0);

  if (total <= 0) {
    return (
      <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {values.map((entry) =>
          entry.amount > 0 ? (
            <span
              key={entry.bucket}
              className={BUCKET_TONE[entry.bucket]}
              style={{ width: `${(entry.amount / total) * 100}%` }}
              title={`${BUCKET_LABEL[entry.bucket]} — ${formatMoney(entry.amount)}`}
            />
          ) : null,
        )}
      </div>

      {showLabels && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1">
          {values.map((entry) => (
            <div key={entry.bucket} className="flex items-baseline gap-1.5">
              <dt className="text-xs text-muted-foreground">
                {BUCKET_LABEL[entry.bucket]}
              </dt>
              <dd className="text-xs font-medium tabular">
                {formatMoneyShort(entry.amount)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-info-muted text-info",
  ISSUED: "bg-info-muted text-info",
  APPROVED: "bg-ok-muted text-ok",
  PARTIALLY_PAID: "bg-warn-muted text-warn",
  PAID: "bg-ok-muted text-ok",
  CANCELLED: "bg-muted text-muted-foreground",
  CREDITED: "bg-warn-muted text-warn",
  DISPUTED: "bg-bad-muted text-bad",
};

/** One pill for every finance status, so they read the same everywhere. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
        STATUS_TONE[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden>←</span>
      {label}
    </Link>
  );
}

/** A right-aligned money cell with tabular figures. */
export function MoneyCell({
  value,
  strong = false,
  tone,
}: {
  value: string | number | null | undefined;
  strong?: boolean;
  tone?: string;
}) {
  return (
    <span
      className={`tabular ${strong ? "font-semibold" : ""} ${tone ?? ""}`}
    >
      {formatMoney(value)}
    </span>
  );
}
