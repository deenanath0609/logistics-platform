import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not permitted" };

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-start gap-4">
        <span className="flex size-10 items-center justify-center rounded-md bg-bad-muted text-bad">
          <ShieldAlert className="size-5" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          You do not have access to this
        </h1>
        <p className="text-sm text-muted-foreground">
          Your role does not include this permission. If you need it, ask your
          branch manager or an administrator to grant it — they can do that
          without a system change.
        </p>
        <Button variant="secondary" render={<Link href="/dashboard" />}>
          Back to dashboard
        </Button>
      </div>
    </main>
  );
}
