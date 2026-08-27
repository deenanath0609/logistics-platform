import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PAUSE_AFTER_FAILURES } from "@/lib/webhooks/dispatch";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "@/lib/webhooks/signature";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PauseButton } from "../pause-button";
import { RetryButton, RotateSecret } from "./delivery-actions";

export const metadata: Metadata = { title: "Webhook deliveries" };
export const dynamic = "force-dynamic";

const DELIVERY_TONE: Record<string, string> = {
  PENDING: "bg-muted text-muted-foreground",
  DELIVERED: "bg-ok-muted text-ok",
  FAILED: "bg-warn-muted text-warn",
  DEAD: "bg-bad-muted text-bad",
};

export default async function WebhookDeliveriesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("apikey.manage");
  const { id } = await params;

  const subscription = await prisma.webhookSubscription.findUnique({
    where: { id },
    // `secret` stays out of the page. It exists to sign with, not to read.
    select: {
      id: true,
      name: true,
      url: true,
      events: true,
      isActive: true,
      failureCount: true,
      pausedAt: true,
      createdAt: true,
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          eventType: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          nextAttemptAt: true,
          responseStatus: true,
          responseBody: true,
          error: true,
          deliveredAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!subscription) notFound();

  const paused = subscription.pausedAt !== null;

  return (
    <>
      <Link
        href="/integrations/webhooks"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All subscriptions
      </Link>

      <PageHeader
        eyebrow="Integrations"
        title={subscription.name}
        description={subscription.url}
        actions={<PauseButton subscriptionId={subscription.id} paused={paused} />}
      />

      <div className="flex flex-col gap-5">
        {paused && (
          <p className="rounded-lg border border-bad/30 bg-bad-muted px-3 py-2 text-sm text-bad">
            Paused after {subscription.failureCount} consecutive failures.
            Deliveries are queued, not lost — resuming sends them. The pause
            exists so a dead endpoint cannot starve everyone else&rsquo;s.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <div className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Recent deliveries
            </h2>

            {subscription.deliveries.length === 0 ? (
              <TableFrame>
                <EmptyState
                  title="Nothing sent yet"
                  description="Deliveries appear here as soon as a subscribed event fires."
                />
              </TableFrame>
            ) : (
              <TableFrame>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead>Response</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subscription.deliveries.map((delivery) => (
                      <TableRow key={delivery.id}>
                        <TableCell className="font-mono text-xs">
                          {delivery.eventType}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              DELIVERY_TONE[delivery.status] ?? "bg-muted"
                            }`}
                          >
                            {delivery.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {delivery.attempts}/{delivery.maxAttempts}
                        </TableCell>
                        <TableCell className="max-w-[20rem] whitespace-normal text-xs text-muted-foreground">
                          {delivery.responseStatus ? (
                            <span className="font-mono">{delivery.responseStatus}</span>
                          ) : null}
                          {delivery.error && (
                            <span className="block text-bad">{delivery.error}</span>
                          )}
                          {delivery.responseBody && (
                            <span className="block truncate font-mono text-[0.7rem]">
                              {delivery.responseBody}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {delivery.deliveredAt
                            ? format(delivery.deliveredAt, "dd MMM, HH:mm:ss")
                            : delivery.status === "PENDING"
                              ? `next ${format(delivery.nextAttemptAt, "dd MMM, HH:mm")}`
                              : format(delivery.createdAt, "dd MMM, HH:mm")}
                        </TableCell>
                        <TableCell className="text-right">
                          {delivery.status !== "DELIVERED" && (
                            <RetryButton deliveryId={delivery.id} />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </div>

          <aside className="flex flex-col gap-4 rounded-lg border bg-card p-5">
            <div className="flex flex-col gap-1">
              <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
                How to verify
              </h2>
              <p className="text-sm text-muted-foreground">
                Recompute the HMAC-SHA256 of{" "}
                <code className="font-mono text-xs">
                  &lt;timestamp&gt;.&lt;raw body&gt;
                </code>{" "}
                with the signing secret and compare it in constant time. Reject a
                timestamp older than five minutes, or a captured request can be
                replayed.
              </p>
            </div>

            <dl className="flex flex-col gap-1.5 text-xs">
              {[
                [SIGNATURE_HEADER, "v1=<hex digest>"],
                [TIMESTAMP_HEADER, "unix seconds, signed with the body"],
                [EVENT_HEADER, "the event name"],
                [DELIVERY_HEADER, "delivery id, for de-duplication"],
              ].map(([header, note]) => (
                <div key={header} className="flex flex-col">
                  <dt className="font-mono text-foreground">{header}</dt>
                  <dd className="text-muted-foreground">{note}</dd>
                </div>
              ))}
            </dl>

            <p className="text-xs text-muted-foreground">
              Retries use exponential backoff and a delivery is repeated on
              failure, so treat the delivery id as an idempotency key.
              {" "}
              {PAUSE_AFTER_FAILURES} consecutive failures pause the
              subscription.
            </p>

            <RotateSecret
              subscriptionId={subscription.id}
              subscriptionName={subscription.name}
            />
          </aside>
        </div>
      </div>
    </>
  );
}
