import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { MessageSquareText, TriangleAlert } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { FilterSelect } from "@/components/fleet/filter-chips";
import { Button } from "@/components/ui/button";
import { maskRecipient } from "@/lib/notifications/mask";
import { transportStatus, wasSimulated } from "@/lib/notifications/transport";
import { EVENT_LABEL } from "@/lib/notifications/variables";
import { anyBranchScope, branchScope } from "@/server/repositories/scope";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Notification log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

const STATUS_TONE: Record<string, string> = {
  QUEUED: "bg-muted text-muted-foreground",
  SENT: "bg-info-muted text-info",
  DELIVERED: "bg-ok-muted text-ok",
  FAILED: "bg-bad-muted text-bad",
  BOUNCED: "bg-bad-muted text-bad",
  SKIPPED: "bg-muted text-muted-foreground",
};

const STATUSES = [
  { value: "QUEUED", label: "Queued" },
  { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "FAILED", label: "Failed" },
  { value: "BOUNCED", label: "Bounced" },
  { value: "SKIPPED", label: "Skipped" },
];

const CHANNELS = [
  { value: "SMS", label: "SMS" },
  { value: "EMAIL", label: "Email" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "PUSH", label: "Push" },
  { value: "IN_APP", label: "In-app" },
];

export default async function NotificationLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    channel?: string;
    event?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("master.read");

  const { q, status, channel, event, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  /**
   * What this user may see.
   *
   * This screen had no branch scoping at all, which meant a hub operator in
   * Jaipur could page through every message the network had ever sent a
   * customer, bodies and all. Two ways a row belongs to a branch, and either
   * will do: the branch stamped on the row — which the dispatcher fills from
   * the *destination* — or any branch of the consignment behind it, so the
   * booking branch can still see the confirmation it caused.
   *
   * Both halves produce an `OR`, and so does the search below, so all of it
   * goes in `AND` rather than being spread. See `anyBranchScope`.
   */
  const scope =
    user.branchIds === null
      ? {}
      : {
          OR: [
            branchScope(user, "branchId"),
            {
              shipment: anyBranchScope(user, [
                "bookingBranchId",
                "originBranchId",
                "destinationBranchId",
                "currentBranchId",
              ]),
            },
          ],
        };

  // Searched against the stored value, shown masked. A support agent has
  // the number in front of them on the call; the screen does not need to
  // repeat it back.
  const search = q
    ? {
        OR: [
          { recipient: { contains: q, mode: "insensitive" as const } },
          { shipment: { lrNumber: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const where = {
    ...(status ? { status: status as never } : {}),
    ...(channel ? { channel: channel as never } : {}),
    ...(event ? { eventType: event } : {}),
    AND: [scope, search],
  };

  // What is actually behind each channel. A screen of green SENT rows
  // written by the mock adapter says nothing at all unless this is next
  // to it.
  const dead = transportStatus().filter(
    (row) => !row.live && row.channel !== "PUSH" && row.channel !== "IN_APP",
  );

  const [rows, total, events] = await Promise.all([
    prisma.notificationLog.findMany({
      where,
      orderBy: { queuedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        channel: true,
        eventType: true,
        recipient: true,
        recipientKind: true,
        subject: true,
        body: true,
        status: true,
        attempts: true,
        providerRef: true,
        segments: true,
        costAmount: true,
        error: true,
        providerResponse: true,
        queuedAt: true,
        sentAt: true,
        template: { select: { code: true } },
        shipment: { select: { id: true, lrNumber: true } },
      },
    }),
    prisma.notificationLog.count({ where }),
    // Scoped the same way the list is: a filter offering a trigger that
    // produces an empty page is a filter that reads as a bug.
    prisma.notificationLog.groupBy({
      by: ["eventType"],
      where: { AND: [scope] },
      orderBy: { eventType: "asc" },
    }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Notifications"
        title="Send log"
        description="One row per attempted send, with the gateway's own answer. This is what makes 'the customer says they never got the SMS' a question the system can settle."
        actions={
          <Button variant="outline" render={<Link href="/notifications/templates" />}>
            <MessageSquareText />
            Templates
          </Button>
        }
      />

      {dead.length > 0 && (
        <div
          data-testid="no-transport-banner"
          className="mb-6 flex gap-3 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              No gateway is connected for {dead.map((row) => row.channel).join(", ")}
            </p>
            <p className="leading-relaxed">
              A row below marked <span className="font-mono">SENT</span> with{" "}
              <span className="font-mono">simulated</span> next to it was
              rendered, written down and thrown away. Nothing reached a
              customer. Read this screen as a record of what the system
              decided to send, not of what anybody received, until a provider
              is connected.
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-[0.72rem] leading-relaxed">
              {dead.map((row) => (
                <li key={row.channel}>
                  <span className="font-mono uppercase">{row.channel}</span> —{" "}
                  {row.note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput placeholder="Recipient or LR number" />
        <FilterSelect param="status" label="Any status" value={status} options={STATUSES} />
        <FilterSelect param="channel" label="Any channel" value={channel} options={CHANNELS} />
        <FilterSelect
          param="event"
          label="Any trigger"
          value={event}
          options={events.map((row) => ({
            value: row.eventType,
            label: EVENT_LABEL[row.eventType] ?? row.eventType,
          }))}
        />
      </div>

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="Nothing sent yet"
            description="Notifications appear here as soon as the dispatcher acts on an outbox event."
          />
        </TableFrame>
      ) : (
        <>
          <TableFrame>
            <Table className="min-w-[1040px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Queued</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>LR</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Provider</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap font-mono text-[0.68rem] text-muted-foreground tabular">
                      {format(row.queuedAt, "dd MMM HH:mm")}
                    </TableCell>
                    <TableCell className="text-xs">
                      <p>{EVENT_LABEL[row.eventType] ?? row.eventType}</p>
                      {row.template && (
                        <p className="font-mono text-[0.6rem] text-muted-foreground">
                          {row.template.code}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      {row.channel}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <p className="font-mono text-xs">
                        {row.recipient ? maskRecipient(row.recipient) : "—"}
                      </p>
                      <p className="text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                        {row.recipientKind.replace("_", " ").toLowerCase()}
                      </p>
                    </TableCell>
                    <TableCell>
                      {row.shipment ? (
                        <Link
                          href={`/shipments/${row.shipment.id}`}
                          className="font-mono text-xs underline-offset-4 hover:underline"
                        >
                          {row.shipment.lrNumber}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[340px]">
                      {row.subject && (
                        <p className="truncate text-xs font-medium">{row.subject}</p>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        {row.body || row.error || "—"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider ${STATUS_TONE[row.status]}`}
                      >
                        {row.status}
                      </span>
                      {row.attempts > 1 && (
                        <span className="ml-1 font-mono text-[0.6rem] text-muted-foreground">
                          ×{row.attempts}
                        </span>
                      )}
                      {(row.status === "FAILED" || row.status === "SKIPPED") &&
                        row.error && (
                          <p className="mt-0.5 max-w-[240px] text-[0.68rem] leading-snug text-muted-foreground">
                            {row.error}
                          </p>
                        )}
                    </TableCell>
                    <TableCell className="text-right">
                      {wasSimulated(row.providerResponse) && (
                        <p
                          data-testid="simulated"
                          title="Written by the mock adapter. Nothing was transmitted."
                          className="font-mono text-[0.6rem] uppercase tracking-wider text-warn"
                        >
                          simulated
                        </p>
                      )}
                      <p className="font-mono text-[0.65rem] text-muted-foreground">
                        {row.providerRef ?? "—"}
                      </p>
                      {row.segments !== null && (
                        <p className="text-[0.6rem] text-muted-foreground tabular">
                          {row.segments} seg
                          {row.costAmount !== null &&
                            ` · ${Number(row.costAmount).toFixed(2)}`}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            baseParams={{ q, status, channel, event }}
            pathname="/notifications/log"
          />
        </>
      )}
    </>
  );
}
