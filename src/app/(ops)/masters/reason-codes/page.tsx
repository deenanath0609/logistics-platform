import type { Metadata } from "next";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createReasonCode,
  updateReasonCode,
  setReasonCodeActive,
} from "./actions";

export const metadata: Metadata = { title: "Reason codes" };
export const dynamic = "force-dynamic";

const CATEGORIES = [
  { value: "PICKUP_FAILURE", label: "Pickup failure" },
  { value: "DELIVERY_FAILURE", label: "Delivery failure" },
  { value: "EXCEPTION", label: "Exception" },
  { value: "CANCELLATION", label: "Cancellation" },
  { value: "HOLD", label: "Hold" },
  { value: "DAMAGE", label: "Damage" },
  { value: "SHORTAGE", label: "Shortage / excess" },
  { value: "RTO", label: "Return to origin" },
  { value: "STATUS_CORRECTION", label: "Status correction" },
];

const CATEGORY_LABEL = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

const FIELDS: FieldDef[] = [
  {
    type: "select",
    name: "category",
    label: "Category",
    required: true,
    half: true,
    options: CATEGORIES,
  },
  { type: "text", name: "code", label: "Code", required: true, half: true, mono: true, placeholder: "DF-UNAVAILABLE" },
  { type: "text", name: "name", label: "Reason shown to staff", required: true, placeholder: "Consignee not available" },
  { type: "textarea", name: "description", label: "Description" },
  {
    type: "switch",
    name: "triggersReattempt",
    label: "Create a re-attempt task",
    help: "The next attempt is scheduled automatically.",
  },
  {
    type: "switch",
    name: "triggersException",
    label: "Open an exception",
    help: "Appears in the control tower with an owner.",
  },
  { type: "switch", name: "isChargeable", label: "Chargeable to the customer" },
  { type: "switch", name: "notifiesConsignor", label: "Notify consignor" },
  { type: "switch", name: "notifiesConsignee", label: "Notify consignee" },
  {
    type: "switch",
    name: "requiresPhoto",
    label: "Photo mandatory",
    help: "The field app will not submit without one.",
  },
  { type: "switch", name: "requiresRemarks", label: "Remarks mandatory" },
  { type: "switch", name: "isActive", label: "Active" },
];

const FLAGS = [
  { key: "triggersReattempt", label: "Re-attempt", tone: "bg-info-muted text-info" },
  { key: "triggersException", label: "Exception", tone: "bg-bad-muted text-bad" },
  { key: "isChargeable", label: "Chargeable", tone: "bg-warn-muted text-warn" },
  { key: "requiresPhoto", label: "Photo", tone: "bg-muted text-muted-foreground" },
  { key: "requiresRemarks", label: "Remarks", tone: "bg-muted text-muted-foreground" },
] as const;

export default async function ReasonCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const user = await requirePermission("master.read");
  const writable = can(user, "master.manage");
  const { category } = await searchParams;

  const rows = await prisma.reasonCode.findMany({
    where: category ? { category: category as never } : undefined,
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
  });

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.category) ?? [];
    list.push(row);
    grouped.set(row.category, list);
  }

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="Reason codes"
        description="Operations owns this list. Adding a failure reason, or changing what it triggers, must never need a release — which is why the automation lives on the row, not in code."
        actions={
          writable && (
            <MasterFormDialog
              title="New reason code"
              fields={FIELDS}
              action={createReasonCode}
              submitLabel="Create"
              trigger={{ label: "New reason code", icon: "plus" }}
            />
          )
        }
      />

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState title="No reason codes yet" />
        </TableFrame>
      ) : (
        <div className="flex flex-col gap-8">
          {[...grouped.entries()].map(([cat, list]) => (
            <section key={cat} className="flex flex-col gap-3">
              <div className="flex items-baseline gap-3">
                <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
                  {CATEGORY_LABEL[cat] ?? cat}
                </h2>
                <span className="text-xs text-muted-foreground tabular">
                  {list.length}
                </span>
              </div>

              <TableFrame>
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Automatic behaviour</TableHead>
                      <TableHead>Notifies</TableHead>
                      <TableHead>Status</TableHead>
                      {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((row) => (
                      <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                        <TableCell className="font-mono text-xs font-medium">
                          {row.code}
                        </TableCell>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {FLAGS.filter((flag) => row[flag.key]).map((flag) => (
                              <span
                                key={flag.key}
                                className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${flag.tone}`}
                              >
                                {flag.label}
                              </span>
                            ))}
                            {!FLAGS.some((flag) => row[flag.key]) && (
                              <span className="text-xs text-muted-foreground">
                                None
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {[
                            row.notifiesConsignor && "Consignor",
                            row.notifiesConsignee && "Consignee",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.isActive ? "secondary" : "outline"}>
                            {row.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        {writable && (
                          <TableCell>
                            <div className="flex items-center justify-end gap-0.5">
                              <MasterFormDialog
                                title={`Edit ${row.code}`}
                                fields={FIELDS}
                                action={updateReasonCode}
                                record={row as unknown as Record<string, unknown>}
                                trigger={{
                                  label: `Edit ${row.code}`,
                                  icon: "pencil",
                                  variant: "ghost",
                                  size: "icon-sm",
                                  iconOnly: true,
                                }}
                              />
                              <ToggleActive
                                id={row.id}
                                isActive={row.isActive}
                                label={row.code}
                                action={setReasonCodeActive}
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
