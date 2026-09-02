import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coverageGaps } from "@/lib/pricing/rerate";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { EntityFormDialog, type EntityField } from "@/components/finance/entity-form";
import { StatTiles } from "@/components/finance/finance-shell";
import { formatDate, formatPercent } from "@/components/finance/format";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createRateCardAction, saveFuelRuleAction } from "./actions";

export const metadata: Metadata = { title: "Rate cards" };
export const dynamic = "force-dynamic";

function cardFields(
  customers: Array<{ value: string; label: string }>,
): EntityField[] {
  return [
    {
      type: "text",
      name: "code",
      label: "Code",
      required: true,
      half: true,
      mono: true,
      placeholder: "ACME-2026",
    },
    {
      type: "date",
      name: "effectiveFrom",
      label: "Effective from",
      required: true,
      half: true,
      help: "The first version starts here.",
    },
    {
      type: "text",
      name: "name",
      label: "Name",
      required: true,
      placeholder: "Acme Industries — FY 2026-27",
    },
    {
      type: "select",
      name: "customerId",
      label: "Customer",
      options: customers,
      placeholder: "Published tariff (no customer)",
      help: "Leave blank for the published tariff. A customer card always outranks it.",
    },
    { type: "textarea", name: "notes", label: "Notes" },
  ];
}

const FUEL_FIELDS: EntityField[] = [
  {
    type: "number",
    name: "percent",
    label: "Percent of base freight",
    required: true,
    half: true,
    step: "0.001",
    placeholder: "9.5",
  },
  { type: "date", name: "effectiveFrom", label: "Effective from", required: true, half: true },
  {
    type: "date",
    name: "effectiveTo",
    label: "Effective to",
    half: true,
    help: "Leave blank to run until superseded.",
  },
  { type: "text", name: "notes", label: "Note", placeholder: "Diesel revision, Aug 2026" },
];

export default async function RateCardsPage() {
  const user = await requirePermission("ratecard.read");
  const writable = can(user, "ratecard.manage");

  const [cards, customers, fuelRules, gaps] = await Promise.all([
    prisma.rateCard.findMany({
      where: { orgId: user.orgId },
      orderBy: [{ isActive: "desc" }, { customerId: "asc" }, { code: "asc" }],
      include: {
        customer: { select: { code: true, name: true } },
        versions: {
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            isApproved: true,
            effectiveFrom: true,
            effectiveTo: true,
            _count: { select: { slabs: true, rules: true } },
          },
        },
      },
    }),
    prisma.customer.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
      take: 500,
    }),
    prisma.fuelSurchargeRule.findMany({
      where: { orgId: user.orgId },
      orderBy: { effectiveFrom: "desc" },
      take: 6,
    }),
    /*
      The same list the coverage-gap screen draws, not a different count.

      This was `freightCalculation.count({ trace.unrated = true })`, which
      is every unrated calculation ever written: not one row per
      consignment, not scoped to the reader's branches, and never dropping
      a lane that has since been priced — because an append-only record
      keeps the unrated calculation forever. So the tile climbed for good
      and a Gurugram manager was counting Jaipur's misses. Clicking through
      to a screen showing three rows under a tile reading forty-seven is
      how a worklist stops being believed.

      `coverageGaps` applies the branch scope and the latest-calculation
      rule, so the number is now the number of rows behind the link.
    */
    coverageGaps({ orgId: user.orgId, take: 400 }, user),
  ]);

  const gapCount = gaps.length;

  const approvedVersions = cards.reduce(
    (sum, card) => sum + card.versions.filter((v) => v.isApproved).length,
    0,
  );
  const draftVersions = cards.reduce(
    (sum, card) => sum + card.versions.filter((v) => !v.isApproved).length,
    0,
  );
  const liveFuel = fuelRules.find(
    (rule) => rule.effectiveFrom <= new Date() && (!rule.effectiveTo || rule.effectiveTo >= new Date()),
  );

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Rate cards"
        description="What a customer pays, versioned by effective date so a historical invoice always reprices at what was agreed at the time. A customer card outranks the published tariff on every lane it covers."
        actions={
          writable && (
            <div className="flex items-center gap-2">
              <EntityFormDialog
                title="Fuel surcharge"
                description="A dated rule rather than a constant, so a diesel revision is a data change. It applies as a percent of base freight to every card that does not price fuel itself."
                fields={FUEL_FIELDS}
                action={saveFuelRuleAction}
                submitLabel="Save"
                trigger={{ label: "Fuel surcharge", icon: "fuel", variant: "outline" }}
              />
              <EntityFormDialog
                title="New rate card"
                description="A card starts as a draft v1. Add slabs, then approve it — approving freezes it."
                fields={cardFields(
                  customers.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
                )}
                action={createRateCardAction}
                submitLabel="Create"
                trigger={{ label: "New rate card", icon: "plus" }}
              />
            </div>
          )
        }
      />

      <StatTiles
        items={[
          { label: "Rate cards", value: String(cards.length) },
          { label: "Approved versions", value: String(approvedVersions), tone: "ok" },
          {
            label: "Drafts open",
            value: String(draftVersions),
            tone: draftVersions > 0 ? "warn" : "default",
            hint: draftVersions > 0 ? "Not pricing anything until approved" : undefined,
          },
          {
            label: "Fuel surcharge",
            value: liveFuel ? formatPercent(liveFuel.percent.toString(), 3) : "—",
            hint: liveFuel ? `From ${formatDate(liveFuel.effectiveFrom)}` : "None in force",
          },
          {
            label: "Coverage gaps",
            value: String(gapCount),
            tone: gapCount > 0 ? "warn" : "ok",
            hint: "Consignments that booked unrated",
            // The only way in. `/finance/coverage-gaps` is in no nav group
            // and hung off `/finance`, which is itself linked from nowhere,
            // so until this tile became a link the screen that surfaces
            // unpriced lanes could only be reached by typing the URL.
            href: "/finance/coverage-gaps",
          },
        ]}
      />

      <TableFrame>
        {cards.length === 0 ? (
          <EmptyState
            title="No rate cards yet"
            description="Start with the published tariff — a card with no customer — so every lane has a fallback price before customer contracts are loaded."
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Live version</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead className="text-right">Slabs</TableHead>
                <TableHead className="text-right">Rules</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.map((card) => {
                const live =
                  card.versions.find((v) => v.isApproved) ?? card.versions[0] ?? null;
                const hasDraft = card.versions.some((v) => !v.isApproved);

                return (
                  <TableRow key={card.id} className={card.isActive ? "" : "opacity-55"}>
                    <TableCell className="font-mono text-xs font-medium">
                      <Link href={`/finance/rate-cards/${card.id}`} className="hover:underline">
                        {card.code}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">{card.name}</TableCell>
                    <TableCell className="text-xs">
                      {card.customer ? (
                        <span className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-accent-foreground">
                          {card.customer.code}
                        </span>
                      ) : (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                          Published
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {live ? `v${live.version}` : "—"}
                      {hasDraft && (
                        <span className="ml-1.5 rounded-sm bg-warn-muted px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-warn">
                          draft
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {live
                        ? `${formatDate(live.effectiveFrom)} – ${live.effectiveTo ? formatDate(live.effectiveTo) : "open"}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {live?._count.slabs ?? 0}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {live?._count.rules ?? 0}
                    </TableCell>
                    <TableCell>
                      <Badge variant={card.isActive ? "secondary" : "outline"}>
                        {card.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/finance/rate-cards/${card.id}`}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${card.code}`}
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      {fuelRules.length > 0 && (
        <section className="pt-8">
          <h2 className="pb-3 text-sm font-semibold">Fuel surcharge history</h2>
          <TableFrame>
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Percent</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fuelRules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium tabular">
                      {formatPercent(rule.percent.toString(), 3)}
                    </TableCell>
                    <TableCell className="text-xs">{formatDate(rule.effectiveFrom)}</TableCell>
                    <TableCell className="text-xs">
                      {rule.effectiveTo ? formatDate(rule.effectiveTo) : "Open"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {rule.notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </section>
      )}
    </>
  );
}
