import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLATFORM_ROLE_LABEL } from "@/lib/platform/roles";
import { requireOperator } from "@/lib/platform/session";

export const metadata: Metadata = { title: "Not permitted" };

/**
 * The console's own 403.
 *
 * Says which role the login holds, because the usual cause is a SUPPORT or
 * BILLING operator following a link somebody else sent them — and "ask for
 * a different login" is more useful than "access denied".
 */
export default async function ConsoleForbiddenPage() {
  const operator = await requireOperator();

  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="size-5" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">
          That is outside your role
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          You are signed in as {operator.name} —{" "}
          {PLATFORM_ROLE_LABEL[operator.role]}. Ask an owner to make the change,
          or to widen the role if you need it regularly.
        </p>
      </div>
      <Button variant="outline" render={<Link href="/platform" />}>
        Back to the overview
      </Button>
    </div>
  );
}
