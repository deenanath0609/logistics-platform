"use client";

import { useEffect, useState } from "react";
import { LogOut, PencilLine, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The bar that says an operator is inside a customer's data.
 *
 * The failure mode this exists to prevent is a support session that looks
 * like an ordinary one: somebody forgetting whose screen they are on and
 * "fixing" a consignment, or leaving a session open over lunch. So the bar
 * is loud, it is on every page, it names everybody involved, and the way
 * out is one click that is always visible.
 *
 * The button is a plain `<form method="post">`. It works with no
 * JavaScript, which matters because the one control that must never fail
 * is the one that ends the session — and it posts to a route that ends the
 * **grant**, not just this browser's cookie.
 */

/**
 * Icons arrive as names, not components.
 *
 * The server component that renders this one cannot pass a Lucide
 * component across the boundary — a function is not serialisable — so the
 * mapping lives here, on the client, and the server sends a string.
 */
const ICONS = {
  "shield-alert": ShieldAlert,
  "pencil-line": PencilLine,
} as const;

export type ImpersonationBannerProps = {
  iconName: keyof typeof ICONS;
  operatorName: string;
  operatorEmail: string;
  carrierName: string;
  /** What the session can actually do, after read-only rules are applied. */
  writesAllowed: boolean;
  /** The tenant user whose view was adopted, if any. */
  actingAs: string | null;
  reason: string;
  /** Rendered on the server so the first paint cannot mismatch. */
  expiresAtLabel: string;
  expiresAtIso: string;
  exitPath: string;
};

/**
 * Minutes left, or null before the first tick.
 *
 * Deliberately not computed during render: the answer depends on the
 * clock, so two renders of the same props would disagree — which is both a
 * hydration mismatch and what `react-hooks/purity` is warning about. The
 * absolute time is always shown; the countdown joins it after mount.
 */
function useMinutesLeft(expiresAtIso: string): number | null {
  const [minutes, setMinutes] = useState<number | null>(null);

  useEffect(() => {
    const expiry = new Date(expiresAtIso).getTime();
    const tick = () =>
      setMinutes(Math.max(0, Math.ceil((expiry - Date.now()) / 60_000)));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [expiresAtIso]);

  return minutes;
}

export function ImpersonationBanner({
  iconName,
  operatorName,
  operatorEmail,
  carrierName,
  writesAllowed,
  actingAs,
  reason,
  expiresAtLabel,
  expiresAtIso,
  exitPath,
}: ImpersonationBannerProps) {
  const Icon = ICONS[iconName];
  const minutes = useMinutesLeft(expiresAtIso);

  // A session that may write is a different order of danger from one that
  // may only look, and the bar should not use one colour for both.
  const tone = writesAllowed
    ? "border-bad/50 bg-bad-muted text-bad"
    : "border-warn/50 bg-warn-muted text-warn";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`sticky top-0 z-50 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2 ${tone}`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />

        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold tracking-tight">
            Support session — {operatorName} is inside {carrierName}
            {writesAllowed ? ", with write access" : ", read-only"}
          </p>

          <p className="font-mono text-[0.65rem] uppercase tracking-[0.12em] opacity-80">
            {operatorEmail}
            {actingAs ? ` · acting as ${actingAs}` : " · tenant-wide"} · expires{" "}
            {expiresAtLabel}
            {minutes === null ? "" : ` · ${minutes} min left`}
          </p>

          <p className="truncate text-xs opacity-80" title={reason}>
            {reason}
          </p>
        </div>
      </div>

      <form method="post" action={exitPath} className="shrink-0">
        <Button type="submit" size="sm" variant="outline">
          <LogOut />
          End session
        </Button>
      </form>
    </div>
  );
}
