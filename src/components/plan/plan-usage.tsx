import { planUsage, type LimitUsage } from "@/lib/plan-limits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Where a carrier stands against their own plan.
 *
 * ── Why it lives on /admin/users ────────────────────────────────────────
 *
 * The caps are not the operator's private business: the whole design
 * decision behind them is that a carrier is told before they hit one
 * rather than after, and a refusal at the moment somebody is filling in a
 * new joiner's details is later than it needs to be. Somewhere the
 * carrier's own admin can read "8 of 10 users" turns a wall into a warning.
 *
 * Administration is the only section of the app that is about the account
 * rather than about the freight, and Users is its landing page — the same
 * screen an admin is already on when they think about adding one, and one
 * whose `user.read` permission is held by exactly the people who provision
 * staff, branches and portal logins. There is no Settings or Organisation
 * page to put it on; the navigation is closed to new entries here, and
 * inventing a route with no way to reach it would be worse than none.
 *
 * All four caps are shown together rather than each next to the thing it
 * limits, because an admin asking "have we room to grow" is asking one
 * question, not four, and because three of the four have no obvious screen
 * of their own to sit on.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function PlanUsagePanel() {
  const usage = await planUsage();

  return (
    <Card size="sm" className="mb-6">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2">
          <span>Plan usage</span>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            {usage.planName ?? "No plan attached"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {usage.limits.map((limit) => (
            <UsageRow key={limit.key} limit={limit} />
          ))}
        </dl>
        {usage.planName === null && (
          <p className="pt-4 text-xs text-muted-foreground">
            Nothing is capped until a plan is attached to your account.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Three presentations, because the three states of a stored cap are three
 * different things to tell somebody — unlimited, switched off, and a number
 * you are some way along.
 */
function UsageRow({ limit }: { limit: LimitUsage }) {
  const off = limit.limit !== null && limit.limit <= 0;

  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs text-muted-foreground">{limit.label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums leading-none">
          {limit.current}
        </span>
        <span className="text-xs text-muted-foreground">
          {off
            ? "not included"
            : limit.limit === null
              ? "no limit"
              : `of ${limit.limit}`}
        </span>
      </dd>
      {limit.fraction !== null && !off && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="presentation"
        >
          <div
            className={`h-full rounded-full ${barTone(limit.fraction)}`}
            style={{ width: `${Math.round(limit.fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Amber before the wall, not at it. The point of showing this at all is
 * that somebody notices while there is still time to ring their account
 * manager, so the colour changes with a tenth of the plan left rather than
 * when the next creation is already going to be refused.
 */
function barTone(fraction: number): string {
  if (fraction >= 1) return "bg-bad";
  if (fraction >= 0.9) return "bg-warn";
  return "bg-primary";
}
