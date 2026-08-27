import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * One number on the portal overview.
 *
 * `value` is null for a figure nothing can currently answer — that renders
 * as "Coming soon" rather than as a confident zero, because a customer
 * reading "₹0 outstanding" from a module that could not answer would be
 * reading a lie.
 */
export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  href?: string;
  tone?: "default" | "ok" | "warn";
}) {
  const body = (
    <>
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      {value === null ? (
        <p className="text-sm text-muted-foreground">Coming soon</p>
      ) : (
        <p
          className={cn(
            "text-3xl font-semibold tabular tracking-tight",
            tone === "ok" && "text-ok",
            tone === "warn" && "text-warn",
          )}
        >
          {value}
        </p>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </>
  );

  const className =
    "flex flex-col gap-1 rounded-lg border bg-card p-4 transition-colors";

  if (!href) return <div className={className}>{body}</div>;

  return (
    <Link href={href} className={cn(className, "hover:border-primary/50")}>
      {body}
    </Link>
  );
}
