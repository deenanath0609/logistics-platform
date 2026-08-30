import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { planRefusalCopy } from "@/lib/modules/refusal";

export const metadata: Metadata = { title: "Not on your plan" };

/**
 * The sibling of `/forbidden`, and the reason there are two pages.
 *
 * A 403 says "your role does not include this permission" and points at a
 * branch manager or an administrator, both of whom can fix it. Neither can
 * fix this one: no permission exists to grant, and no role change would
 * produce the screen. Saying so, and naming the capability, is the whole
 * difference between an actionable refusal and a wasted support call.
 *
 * Lives at the app root rather than inside `(ops)` on purpose — the ops
 * layout is what redirected here, so rendering inside it would loop.
 *
 * `?module=` is read as a hint and never as a claim: `planRefusalCopy`
 * resolves it against the registry and falls back to a generic sentence, so
 * a typed or tampered URL cannot put arbitrary text on the page.
 */
export default async function NotOnPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>;
}) {
  const { module } = await searchParams;
  const refusal = planRefusalCopy(module);

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-start gap-4">
        <span className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Lock className="size-5" />
        </span>

        <h1 className="text-2xl font-semibold tracking-tight">
          {refusal.title}
        </h1>

        <p className="text-sm text-muted-foreground">{refusal.body}</p>

        {refusal.moduleDescription && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {refusal.moduleDescription}
          </p>
        )}

        <p className="text-sm text-muted-foreground">{refusal.remedy}</p>

        <Button variant="secondary" render={<Link href="/dashboard" />}>
          Back to dashboard
        </Button>
      </div>
    </main>
  );
}
