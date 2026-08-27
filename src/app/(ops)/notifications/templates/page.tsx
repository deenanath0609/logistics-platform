import type { Metadata } from "next";
import Link from "next/link";
import { ScrollText, TriangleAlert } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { ToggleActive } from "@/components/data/toggle-active";
import {
  TemplateFormDialog,
  type TemplateRecord,
} from "@/components/notifications/template-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EVENT_LABEL, TRIGGER_EVENTS } from "@/lib/notifications/variables";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createTemplate, setTemplateActive, updateTemplate } from "./actions";

export const metadata: Metadata = { title: "Notification templates" };
export const dynamic = "force-dynamic";

const CHANNEL_TONE: Record<string, string> = {
  SMS: "bg-info-muted text-info",
  EMAIL: "bg-accent text-accent-foreground",
  WHATSAPP: "bg-ok-muted text-ok",
  PUSH: "bg-warn-muted text-warn",
  IN_APP: "bg-muted text-muted-foreground",
};

const RECIPIENT_LABEL: Record<string, string> = {
  CONSIGNOR: "Consignor",
  CONSIGNEE: "Consignee",
  CUSTOMER_USER: "Portal users",
  STAFF: "Staff",
  BRANCH: "Branch",
};

export default async function NotificationTemplatesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");

  const rows = await prisma.notificationTemplate.findMany({
    orderBy: [{ eventType: "asc" }, { channel: "asc" }, { code: "asc" }],
  });

  // Grouped by trigger rather than listed flat: the question this screen
  // gets asked is "what does a customer receive when a parcel is
  // delivered", and that answer is a group, not a row.
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.eventType) ?? [];
    list.push(row);
    grouped.set(row.eventType, list);
  }

  const order = TRIGGER_EVENTS.map((event) => event.value);
  const groups = [...grouped.entries()].sort(
    (a, b) => indexOf(order, a[0]) - indexOf(order, b[0]),
  );

  const undeliverable = rows.filter(
    (row) => row.isActive && row.channel === "SMS" && !row.dltTemplateId,
  );

  return (
    <>
      <PageHeader
        eyebrow="Notifications"
        title="Templates"
        description="What the customer actually receives, and when. Operations owns this text — changing a message must never need a release."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" render={<Link href="/notifications/log" />}>
              <ScrollText />
              Send log
            </Button>
            {writable && (
              <TemplateFormDialog mode="create" action={createTemplate} />
            )}
          </div>
        }
      />

      {undeliverable.length > 0 && (
        <div className="mb-6 flex gap-3 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              {undeliverable.length} active SMS template
              {undeliverable.length === 1 ? " has" : "s have"} no DLT id
            </p>
            <p className="leading-relaxed">
              Indian transactional SMS requires both the sender header and the
              exact template text to be registered on DLT. Until the id is
              recorded here, the operator accepts the submission and drops the
              message without a delivery report — nobody finds out except the
              customer who never got it. Registration takes one to three weeks:{" "}
              <span className="font-mono">
                {undeliverable.map((row) => row.code).join(", ")}
              </span>
              .
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="No templates yet"
            description="Nothing is sent until a template exists for a trigger. The default set covering the notification matrix can be seeded from src/lib/notifications/default-templates.ts."
          />
        </TableFrame>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(([eventType, list]) => (
            <section key={eventType} className="flex flex-col gap-3">
              <div className="flex items-baseline gap-3">
                <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
                  {EVENT_LABEL[eventType] ?? eventType}
                </h2>
                <span className="font-mono text-[0.6rem] text-muted-foreground">
                  {eventType}
                </span>
              </div>

              <TableFrame>
                <Table className="min-w-[880px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>DLT</TableHead>
                      <TableHead>Status</TableHead>
                      {writable && (
                        <TableHead className="w-24 text-right">Actions</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((row) => (
                      <TableRow
                        key={row.id}
                        className={row.isActive ? "" : "opacity-55"}
                      >
                        <TableCell className="font-mono text-xs font-medium">
                          {row.code}
                          {row.language !== "en" && (
                            <span className="ml-1 text-muted-foreground">
                              /{row.language}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${CHANNEL_TONE[row.channel]}`}
                          >
                            {row.channel}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {RECIPIENT_LABEL[row.recipientKind] ?? row.recipientKind}
                        </TableCell>
                        <TableCell className="max-w-[380px]">
                          {row.subject && (
                            <p className="truncate text-xs font-medium">
                              {row.subject}
                            </p>
                          )}
                          <p className="truncate text-xs text-muted-foreground">
                            {row.body}
                          </p>
                        </TableCell>
                        <TableCell>
                          {row.channel !== "SMS" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : row.dltTemplateId ? (
                            <span className="font-mono text-[0.65rem] text-muted-foreground">
                              {row.dltSenderId ?? "—"} · {row.dltTemplateId}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                              <TriangleAlert className="size-3" />
                              Not registered
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.isActive ? "secondary" : "outline"}>
                            {row.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        {writable && (
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <TemplateFormDialog
                                mode="edit"
                                action={updateTemplate}
                                record={toRecord(row)}
                              />
                              <ToggleActive
                                id={row.id}
                                isActive={row.isActive}
                                label={row.code}
                                action={setTemplateActive}
                              />
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function indexOf(order: string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

/** Plain data across the server/client boundary — no Dates, no Decimals. */
function toRecord(row: {
  id: string;
  code: string;
  channel: string;
  eventType: string;
  name: string;
  language: string;
  subject: string | null;
  body: string;
  variables: string[];
  recipientKind: string;
  dltTemplateId: string | null;
  dltSenderId: string | null;
  isActive: boolean;
}): TemplateRecord {
  return {
    id: row.id,
    code: row.code,
    channel: row.channel,
    eventType: row.eventType,
    name: row.name,
    language: row.language,
    subject: row.subject,
    body: row.body,
    variables: row.variables,
    recipientKind: row.recipientKind,
    dltTemplateId: row.dltTemplateId,
    dltSenderId: row.dltSenderId,
    isActive: row.isActive,
  };
}
