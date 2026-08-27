import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { startWebhookDispatch, PAUSE_AFTER_FAILURES } from "@/lib/webhooks/dispatch";
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
import { SubscriptionForm } from "./subscription-form";
import { PauseButton } from "./pause-button";

export const metadata: Metadata = { title: "Webhooks" };
export const dynamic = "force-dynamic";

/**
 * The events a subscription is most likely to want. Shown as hints rather
 * than as a closed list, because the outbox names events from code and a
 * hard-coded picker here would go stale the moment one is added.
 */
const SUGGESTED_EVENTS = [
  "shipment.booking_created",
  "shipment.picked_up",
  "shipment.in_transit_ping",
  "shipment.delivered",
  "shipment.delivery_attempted",
  "shipment.rto_initiated",
  "shipment.*",
  "*",
];

export default async function WebhooksPage() {
  await requirePermission("apikey.manage");

  // Arming the fan-out and the delivery timer here means an operator who
  // opens this screen has a live dispatcher, without waiting for a request
  // to /api/v1. Both calls are idempotent.
  startWebhookDispatch();

  const [subscriptions, customers, queued] = await Promise.all([
    prisma.webhookSubscription.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      // `secret` is not selected: it is needed to sign, never to display.
      select: {
        id: true,
        name: true,
        url: true,
        events: true,
        isActive: true,
        failureCount: true,
        pausedAt: true,
        customerId: true,
        createdAt: true,
        _count: { select: { deliveries: true } },
      },
    }),
    prisma.customer.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      take: 500,
      select: { id: true, code: true, name: true },
    }),
    prisma.webhookDelivery.count({ where: { status: "PENDING" } }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));

  return (
    <>
      <Link
        href="/integrations"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Integrations
      </Link>

      <PageHeader
        eyebrow="Integrations"
        title="Webhooks"
        description={`Status events are pushed to a partner's own system, signed and retried with backoff. A subscription that fails ${PAUSE_AFTER_FAILURES} times in a row is paused rather than retried forever against a dead endpoint.`}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            New subscription
          </h2>
          <SubscriptionForm
            customers={customers.map((customer) => ({
              id: customer.id,
              label: `${customer.code} — ${customer.name}`,
            }))}
            suggestedEvents={SUGGESTED_EVENTS}
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              Subscriptions
            </h2>
            <span className="text-xs text-muted-foreground tabular">
              {queued} queued for delivery
            </span>
          </div>

          {subscriptions.length === 0 ? (
            <TableFrame>
              <EmptyState
                title="Nothing subscribed"
                description="A corporate customer's ERP can receive status events as they happen instead of polling for them."
              />
            </TableFrame>
          ) : (
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Deliveries</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.map((subscription) => {
                    const paused = subscription.pausedAt !== null;
                    const customer = subscription.customerId
                      ? customerById.get(subscription.customerId)
                      : null;

                    return (
                      <TableRow key={subscription.id}>
                        <TableCell className="font-medium">
                          <Link
                            href={`/integrations/webhooks/${subscription.id}`}
                            className="hover:underline"
                          >
                            {subscription.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            since {format(subscription.createdAt, "dd MMM yyyy")}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                          {subscription.url}
                        </TableCell>
                        <TableCell className="max-w-[14rem] whitespace-normal">
                          <span className="flex flex-wrap gap-1">
                            {subscription.events.map((event) => (
                              <span
                                key={event}
                                className="rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground"
                              >
                                {event}
                              </span>
                            ))}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {customer ? customer.name : "All"}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {subscription._count.deliveries}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              paused
                                ? "bg-bad-muted text-bad"
                                : subscription.failureCount > 0
                                  ? "bg-warn-muted text-warn"
                                  : "bg-ok-muted text-ok"
                            }`}
                          >
                            {paused
                              ? "Paused"
                              : subscription.failureCount > 0
                                ? `${subscription.failureCount} failing`
                                : "Live"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <PauseButton
                            subscriptionId={subscription.id}
                            paused={paused}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableFrame>
          )}
        </div>
      </div>
    </>
  );
}
