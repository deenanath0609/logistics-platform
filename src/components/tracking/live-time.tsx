"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Ages that keep counting, and a page that reloads itself.
 *
 * Both exist for the same reason: a tracking screen left open on a wall
 * display is the normal case, not the exception, and a "last ping 2 min
 * ago" frozen at whatever it said when the page rendered is worse than no
 * number at all — it reads as fresh when it is an hour stale.
 *
 * The first render must match the server's, or React replaces the whole
 * tree on hydration. So the server-computed string is what renders first,
 * and the ticking starts only after mount.
 */

export function Age({
  at,
  initial,
  className,
}: {
  /** ISO timestamp. */
  at: string | null;
  /** What the server rendered, used until the client takes over. */
  initial: string;
  className?: string;
}) {
  const [label, setLabel] = useState(initial);

  useEffect(() => {
    if (!at) return;

    const tick = () => setLabel(formatAge(Date.now() - new Date(at).getTime()));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [at]);

  return <span className={className}>{label}</span>;
}

/** Minutes to something a person reads without doing arithmetic. */
export function formatAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * Pulls fresh server data on an interval.
 *
 * `router.refresh()` re-runs the server component and patches the tree in
 * place, so the scroll position, the selected vehicle and any open panel
 * survive — which a full reload would not, and which matters when somebody
 * is watching one truck.
 *
 * Pauses while the tab is hidden. A dispatcher's browser has thirty tabs
 * open and none of the other twenty-nine should be polling the database.
 */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);

    return () => clearInterval(timer);
  }, [router, seconds]);

  return null;
}
