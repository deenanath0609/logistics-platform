import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

function Tile({
  href,
  title,
  description,
  stat,
}: {
  href: string;
  title: string;
  description: string;
  stat: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-2 rounded-lg border bg-card p-5 transition-colors hover:bg-muted/50"
    >
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-primary">
        {stat}
      </span>
      <span className="text-base font-medium">{title}</span>
      <span className="max-w-prose text-sm text-muted-foreground">
        {description}
      </span>
    </Link>
  );
}

export default async function IntegrationsPage() {
  await requirePermission("apikey.manage");

  const [liveKeys, liveHooks, pausedHooks, pendingDeliveries] = await Promise.all([
    prisma.apiKey.count({ where: { revokedAt: null } }),
    prisma.webhookSubscription.count({ where: { isActive: true, pausedAt: null } }),
    prisma.webhookSubscription.count({ where: { pausedAt: { not: null } } }),
    prisma.webhookDelivery.count({ where: { status: "PENDING" } }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Integrations"
        description="Partner systems talk to us two ways: they call /api/v1 with a key, and we call them back with signed webhooks. Both are managed here."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Tile
          href="/integrations/api-keys"
          title="API keys"
          description="Issue and revoke keys for /api/v1. Scoped, optionally address-restricted, optionally tied to one customer. Only the digest is stored."
          stat={`${liveKeys} live`}
        />
        <Tile
          href="/integrations/webhooks"
          title="Webhooks"
          description="Push status events to a customer's own system, signed and retried with backoff. Inspect every delivery and its response."
          stat={`${liveHooks} live · ${pausedHooks} paused · ${pendingDeliveries} queued`}
        />
      </div>
    </>
  );
}
