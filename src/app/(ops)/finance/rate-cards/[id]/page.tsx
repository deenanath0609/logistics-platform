import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  EntityFormDialog,
  ConfirmButton,
  type EntityField,
} from "@/components/finance/entity-form";
import { ReasonAction } from "@/components/finance/reason-action";
import { BackLink } from "@/components/finance/finance-shell";
import { formatDate, formatMoney, isoDate } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SHIPMENT_MODES, SHIPMENT_MODE_SHORT } from "@/lib/shipment/modes";
import {
  createVersionAction,
  approveVersionAction,
  updateRateCardAction,
  updateVersionDatesAction,
  saveSlabAction,
  deleteSlabAction,
  saveChargeRuleAction,
  deleteChargeRuleAction,
} from "../actions";

export const metadata: Metadata = { title: "Rate card" };
export const dynamic = "force-dynamic";

const SLAB_BASIS = [
  { value: "PER_KG", label: "Per kg" },
  { value: "PER_PACKAGE", label: "Per package" },
  { value: "FLAT", label: "Flat" },
  { value: "PER_KM", label: "Per km" },
  { value: "PER_TRIP", label: "Per trip (FTL)" },
  { value: "PER_VEHICLE", label: "Per vehicle (FTL)" },
];

const RULE_BASIS = [
  { value: "FLAT", label: "Flat" },
  { value: "PER_KG", label: "Per kg" },
  { value: "PER_PACKAGE", label: "Per package" },
  { value: "PER_KM", label: "Per km" },
  { value: "PER_HOUR", label: "Per hour (detention)" },
  { value: "PERCENT_OF_FREIGHT", label: "% of base freight" },
  { value: "PERCENT_OF_DECLARED_VALUE", label: "% of declared value" },
  { value: "PERCENT_OF_COD", label: "% of COD" },
];

const FROZEN_REASON =
  "This version is approved and frozen — invoices reference it. Open a new version to change rates.";

function slabFields(options: {
  serviceTypes: Array<{ value: string; label: string }>;
  cities: Array<{ value: string; label: string }>;
  zones: Array<{ value: string; label: string }>;
  vehicleTypes: Array<{ value: string; label: string }>;
}): EntityField[] {
  return [
    {
      type: "select",
      name: "basis",
      label: "Basis",
      required: true,
      half: true,
      options: SLAB_BASIS,
      placeholder: "Per kg",
    },
    {
      type: "number",
      name: "rate",
      label: "Rate (₹)",
      required: true,
      half: true,
      step: "0.0001",
    },
    {
      type: "number",
      name: "weightFromKg",
      label: "Weight from (kg)",
      half: true,
      step: "0.001",
      help: "Inclusive.",
    },
    {
      type: "number",
      name: "weightToKg",
      label: "Weight to (kg)",
      half: true,
      step: "0.001",
      help: "Exclusive — a shipment exactly on the edge falls in the band above.",
    },
    {
      type: "number",
      name: "minimumCharge",
      label: "Minimum charge (₹)",
      half: true,
      step: "0.01",
      help: "Applied after the slab calculation.",
    },
    {
      type: "number",
      name: "minimumChargeableKg",
      label: "Minimum chargeable (kg)",
      half: true,
      step: "0.001",
    },
    {
      type: "select",
      name: "serviceTypeId",
      label: "Service type",
      half: true,
      options: options.serviceTypes,
    },
    {
      type: "select",
      name: "mode",
      label: "Mode",
      half: true,
      options: SHIPMENT_MODES.map((mode) => ({
        value: mode,
        label: SHIPMENT_MODE_SHORT[mode],
      })),
    },
    {
      type: "select",
      name: "originCityId",
      label: "Origin city",
      half: true,
      options: options.cities,
    },
    {
      type: "select",
      name: "destinationCityId",
      label: "Destination city",
      half: true,
      options: options.cities,
    },
    {
      type: "select",
      name: "originZoneId",
      label: "Origin zone",
      half: true,
      options: options.zones,
    },
    {
      type: "select",
      name: "destinationZoneId",
      label: "Destination zone",
      half: true,
      options: options.zones,
    },
    {
      type: "select",
      name: "vehicleTypeId",
      label: "Vehicle type",
      half: true,
      options: options.vehicleTypes,
      help: "FTL only.",
    },
    {
      type: "number",
      name: "priority",
      label: "Priority",
      half: true,
      defaultValue: "0",
      help: "Breaks a tie between two rules of the same specificity. Higher wins.",
    },
    {
      type: "number",
      name: "transitHours",
      label: "Transit hours",
      half: true,
    },
  ];
}

function ruleFields(
  chargeTypes: Array<{ value: string; label: string }>,
): EntityField[] {
  return [
    {
      type: "select",
      name: "chargeTypeId",
      label: "Charge head",
      required: true,
      options: chargeTypes,
      placeholder: "Pick a head",
      help: "The name that prints on the invoice line.",
    },
    {
      type: "select",
      name: "basis",
      label: "Basis",
      required: true,
      half: true,
      options: RULE_BASIS,
    },
    { type: "number", name: "rate", label: "Rate or percent", required: true, half: true, step: "0.0001" },
    { type: "number", name: "minimumAmount", label: "Minimum (₹)", half: true, step: "0.01" },
    { type: "number", name: "maximumAmount", label: "Maximum (₹)", half: true, step: "0.01" },
    { type: "number", name: "sortOrder", label: "Sort order", half: true, defaultValue: "0" },
    {
      type: "switch",
      name: "isAutomatic",
      label: "Applied automatically",
      defaultChecked: true,
      help: "Off means a clerk adds it by hand; the engine will skip it and say so.",
    },
    {
      type: "switch",
      name: "odaOnly",
      label: "Only when the destination is ODA",
      help: "Triggered by the destination PIN's out-of-area classification.",
    },
    { type: "switch", name: "codOnly", label: "Only on COD consignments" },
    {
      type: "switch",
      name: "requiresDeclaredValue",
      label: "Only when a value is declared",
      help: "For risk cover charged as a percent of declared value.",
    },
    { type: "switch", name: "fragileOnly", label: "Only on fragile consignments" },
  ];
}

export default async function RateCardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const user = await requirePermission("ratecard.read");
  const writable = can(user, "ratecard.manage");
  const { id } = await params;
  const { v } = await searchParams;

  const card = await prisma.rateCard.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, code: true, name: true } },
      versions: {
        orderBy: { version: "desc" },
        include: { _count: { select: { slabs: true, rules: true } } },
      },
    },
  });

  if (!card || card.orgId !== user.orgId) notFound();

  const selectedVersion =
    card.versions.find((version) => version.id === v) ?? card.versions[0] ?? null;

  const [detail, serviceTypes, cities, zones, vehicleTypes, chargeTypes] =
    await Promise.all([
      selectedVersion
        ? prisma.rateCardVersion.findUnique({
            where: { id: selectedVersion.id },
            include: {
              slabs: { orderBy: [{ priority: "desc" }, { weightFromKg: "asc" }] },
              rules: {
                orderBy: { sortOrder: "asc" },
                include: { chargeType: { select: { code: true, name: true } } },
              },
            },
          })
        : null,
      prisma.serviceType.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true },
      }),
      prisma.city.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true },
        take: 500,
      }),
      prisma.zone.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true },
      }),
      prisma.vehicleType.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true },
      }),
      prisma.chargeType.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, code: true, name: true },
      }),
    ]);

  const cityLabel = new Map(cities.map((c) => [c.id, c.code]));
  const zoneLabel = new Map(zones.map((z) => [z.id, z.code]));
  const serviceLabel = new Map(serviceTypes.map((s) => [s.id, s.code]));

  const frozen = selectedVersion?.isApproved ?? false;

  const slabOptions = {
    serviceTypes: serviceTypes.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })),
    cities: cities.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
    zones: zones.map((z) => ({ value: z.id, label: `${z.code} — ${z.name}` })),
    vehicleTypes: vehicleTypes.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })),
  };

  const chargeOptions = chargeTypes.map((t) => ({
    value: t.id,
    label: `${t.code} — ${t.name}`,
  }));

  return (
    <>
      <BackLink href="/finance/rate-cards" label="All rate cards" />

      <PageHeader
        eyebrow={card.customer ? `Customer · ${card.customer.code}` : "Published tariff"}
        title={`${card.code} — ${card.name}`}
        description={
          card.notes ??
          "Versions are frozen on approval. A version already referenced by an invoice cannot be edited; the way to change a rate is a new version."
        }
        actions={
          writable && (
            <div className="flex flex-wrap items-center gap-2">
            {/*
              Retiring a tariff.

              `updateRateCardAction` existed, permission-checked and audited,
              and no control ever reached it — so `isActive` could be set at
              creation and never again. `resolveRateCards` filters on it, and
              it is the only switch that takes a card out of pricing: a card
              raised against the wrong customer priced that account forever,
              and there was no screen anywhere that could stop it.
            */}
            <EntityFormDialog
              title="Edit rate card"
              description="Retiring a card takes it out of pricing altogether — the engine stops considering it from the next booking. Existing invoices are untouched; they reference the frozen version they were priced on."
              fields={[
                { type: "text", name: "name", label: "Name", required: true },
                { type: "textarea", name: "notes", label: "Notes" },
                {
                  type: "switch",
                  name: "isActive",
                  label: "In use",
                  defaultChecked: card.isActive,
                  help: "Off retires the card. Nothing prices against it again, and it stops competing with the published tariff.",
                },
              ]}
              // `isActive` as the string the switch compares against: when a
              // `record` is supplied it wins over `defaultChecked`, so
              // leaving it out would render an active card's switch as off.
              record={{
                name: card.name,
                notes: card.notes,
                isActive: card.isActive ? "true" : "false",
              }}
              hidden={{ rateCardId: card.id }}
              action={updateRateCardAction}
              submitLabel="Save"
              trigger={{ label: "Edit card", icon: "pencil", variant: "outline" }}
            />
            <EntityFormDialog
              title="New version"
              description="Slabs and charge rules are copied forward from the version you pick, so a revision is a handful of edits rather than a retype."
              fields={[
                {
                  type: "date",
                  name: "effectiveFrom",
                  label: "Effective from",
                  required: true,
                  half: true,
                  defaultValue: isoDate(new Date()),
                },
                { type: "date", name: "effectiveTo", label: "Effective to", half: true },
                {
                  type: "select",
                  name: "copyFromVersionId",
                  label: "Copy rates from",
                  options: card.versions.map((version) => ({
                    value: version.id,
                    label: `v${version.version} (${version._count.slabs} slabs)`,
                  })),
                  placeholder: "Latest version",
                },
                { type: "textarea", name: "notes", label: "What changed" },
              ]}
              hidden={{ rateCardId: card.id }}
              action={createVersionAction}
              submitLabel="Open draft"
              trigger={{ label: "New version", icon: "version" }}
            />
            </div>
          )
        }
      />

      {/* ── Versions ───────────────────────────────────────── */}
      <section className="pb-8">
        <h2 className="pb-3 text-sm font-semibold">Versions</h2>
        <TableFrame>
          {card.versions.length === 0 ? (
            <EmptyState title="No versions yet" />
          ) : (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Slabs</TableHead>
                  <TableHead className="text-right">Rules</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {card.versions.map((version) => (
                  <TableRow
                    key={version.id}
                    className={version.id === selectedVersion?.id ? "bg-muted/50" : ""}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      <a href={`?v=${version.id}`} className="hover:underline">
                        v{version.version}
                      </a>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(version.effectiveFrom)} –{" "}
                      {version.effectiveTo ? formatDate(version.effectiveTo) : "open"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {version._count.slabs}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">
                      {version._count.rules}
                    </TableCell>
                    <TableCell>
                      {version.isApproved ? (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-ok-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-ok">
                          <Lock className="size-2.5" />
                          Approved
                        </span>
                      ) : (
                        <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                          Draft
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {version.notes ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {writable && !version.isApproved && (
                        <EntityFormDialog
                          title={`v${version.version} dates`}
                          description="A draft's dates can still be corrected. Effective-to is what closes a tariff — leave it open and this version prices until another supersedes it."
                          fields={[
                            {
                              type: "date",
                              name: "effectiveFrom",
                              label: "Effective from",
                              required: true,
                              half: true,
                              defaultValue: isoDate(version.effectiveFrom),
                            },
                            {
                              type: "date",
                              name: "effectiveTo",
                              label: "Effective to",
                              half: true,
                              defaultValue: version.effectiveTo
                                ? isoDate(version.effectiveTo)
                                : undefined,
                              help: "Blank leaves it open-ended.",
                            },
                            {
                              type: "textarea",
                              name: "notes",
                              label: "What changed",
                              defaultValue: version.notes ?? undefined,
                            },
                          ]}
                          hidden={{ rateCardId: card.id, versionId: version.id }}
                          action={updateVersionDatesAction}
                          submitLabel="Save dates"
                          trigger={{
                            label: "Dates",
                            icon: "pencil",
                            size: "xs",
                            variant: "ghost",
                          }}
                        />
                      )}
                      {writable && !version.isApproved && (
                        <ReasonAction
                          id={version.id}
                          title={`Approve v${version.version}?`}
                          description="Approving freezes this version. Invoices will reference it, and it cannot be edited afterwards — the only way to change a rate is a new version."
                          reasonLabel="What changed, and who agreed it"
                          reasonPlaceholder="Annual revision agreed with the customer on 20 Aug; FSC moved to 9.5%."
                          confirmLabel="Approve & freeze"
                          icon="approve"
                          size="xs"
                          variant="outline"
                          action={approveVersionAction}
                        />
                      )}
                      {version.isApproved && version.approvedAt && (
                        <span className="text-xs text-muted-foreground">
                          {formatDate(version.approvedAt)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {frozen && (
        <p className="mb-6 flex items-center gap-2 rounded-lg border border-ok/40 bg-ok-muted px-3 py-2 text-sm text-ok">
          <Lock className="size-4 shrink-0" />
          {FROZEN_REASON}
        </p>
      )}

      {/* ── Slabs ──────────────────────────────────────────── */}
      <section className="pb-8">
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-sm font-semibold">
            Rate slabs
            {selectedVersion && (
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                v{selectedVersion.version}
              </span>
            )}
          </h2>
          {writable && selectedVersion && (
            <EntityFormDialog
              title="Add a slab"
              description="Leave a dimension blank to mean 'any'. The most specific matching slab wins: a city pair beats a zone pair beats a blanket rate."
              fields={slabFields(slabOptions)}
              hidden={{ versionId: selectedVersion.id }}
              action={saveSlabAction}
              submitLabel="Add slab"
              trigger={{
                label: "Add slab",
                icon: "plus",
                size: "sm",
                disabled: frozen,
                disabledReason: FROZEN_REASON,
              }}
            />
          )}
        </div>

        <TableFrame>
          {!detail || detail.slabs.length === 0 ? (
            <EmptyState
              title="No slabs on this version"
              description="A version with no slabs prices every lane as unrated, so it cannot be approved."
            />
          ) : (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Lane</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Weight band</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Min charge</TableHead>
                  <TableHead className="text-right">Min kg</TableHead>
                  <TableHead className="text-right">Priority</TableHead>
                  {writable && <TableHead className="w-20 text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.slabs.map((slab) => (
                  <TableRow key={slab.id}>
                    <TableCell className="text-xs">
                      {describeLane(slab, cityLabel, zoneLabel)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {slab.serviceTypeId ? serviceLabel.get(slab.serviceTypeId) : "Any"}
                      {slab.mode ? ` · ${slab.mode}` : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular">
                      {slab.weightFromKg ? Number(slab.weightFromKg).toFixed(3) : "0.000"} –{" "}
                      {slab.weightToKg ? Number(slab.weightToKg).toFixed(3) : "∞"}
                    </TableCell>
                    <TableCell className="text-xs">{slab.basis.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-right tabular">
                      {formatMoney(slab.rate.toString())}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular text-muted-foreground">
                      {slab.minimumCharge ? formatMoney(slab.minimumCharge.toString()) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular text-muted-foreground">
                      {slab.minimumChargeableKg
                        ? Number(slab.minimumChargeableKg).toFixed(3)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">{slab.priority}</TableCell>
                    {writable && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-0.5">
                          <EntityFormDialog
                            title="Edit slab"
                            fields={slabFields(slabOptions)}
                            record={slab as unknown as Record<string, unknown>}
                            hidden={{ versionId: detail.id }}
                            action={saveSlabAction}
                            trigger={{
                              label: "Edit slab",
                              icon: "pencil",
                              variant: "ghost",
                              size: "icon-sm",
                              iconOnly: true,
                              disabled: frozen,
                              disabledReason: FROZEN_REASON,
                            }}
                          />
                          <ConfirmButton
                            id={slab.id}
                            label="Remove"
                            title="Remove this slab?"
                            description="Only draft versions can be changed. Invoices already raised are unaffected."
                            action={deleteSlabAction}
                            disabled={frozen}
                            disabledReason={FROZEN_REASON}
                          />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {/* ── Charge rules ───────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-sm font-semibold">Charge rules</h2>
          {writable && selectedVersion && (
            <EntityFormDialog
              title="Add a charge rule"
              description="Everything that is not base freight: surcharges, handling, ODA, insurance, COD fee. A rule that does not apply is still recorded on the trace, with the reason."
              fields={ruleFields(chargeOptions)}
              hidden={{ versionId: selectedVersion.id }}
              action={saveChargeRuleAction}
              submitLabel="Add rule"
              trigger={{
                label: "Add rule",
                icon: "plus",
                size: "sm",
                disabled: frozen,
                disabledReason: FROZEN_REASON,
              }}
            />
          )}
        </div>

        <TableFrame>
          {!detail || detail.rules.length === 0 ? (
            <EmptyState
              title="No charge rules"
              description="Without one, only base freight is priced. The org fuel surcharge still applies on top."
            />
          ) : (
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Charge head</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Min</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead>Applies when</TableHead>
                  <TableHead>Auto</TableHead>
                  {writable && <TableHead className="w-20 text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">
                      {rule.chargeType.name}
                      <span className="ml-1.5 font-mono text-[0.65rem] text-muted-foreground">
                        {rule.chargeType.code}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{rule.basis.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-right tabular">
                      {isPercent(rule.basis)
                        ? `${Number(rule.rate).toFixed(3)}%`
                        : formatMoney(rule.rate.toString())}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular text-muted-foreground">
                      {rule.minimumAmount ? formatMoney(rule.minimumAmount.toString()) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular text-muted-foreground">
                      {rule.maximumAmount ? formatMoney(rule.maximumAmount.toString()) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {describeCondition(rule.appliesWhen)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {rule.isAutomatic ? "Yes" : "Manual"}
                    </TableCell>
                    {writable && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-0.5">
                          <EntityFormDialog
                            title="Edit charge rule"
                            fields={ruleFields(chargeOptions)}
                            record={ruleRecord(rule)}
                            hidden={{ versionId: detail.id }}
                            action={saveChargeRuleAction}
                            trigger={{
                              label: "Edit rule",
                              icon: "pencil",
                              variant: "ghost",
                              size: "icon-sm",
                              iconOnly: true,
                              disabled: frozen,
                              disabledReason: FROZEN_REASON,
                            }}
                          />
                          <ConfirmButton
                            id={rule.id}
                            label="Remove"
                            title="Remove this charge rule?"
                            action={deleteChargeRuleAction}
                            disabled={frozen}
                            disabledReason={FROZEN_REASON}
                          />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>
    </>
  );
}

function isPercent(basis: string): boolean {
  return basis.startsWith("PERCENT_OF_");
}

function describeLane(
  slab: {
    originCityId: string | null;
    destinationCityId: string | null;
    originZoneId: string | null;
    destinationZoneId: string | null;
  },
  cityLabel: Map<string, string>,
  zoneLabel: Map<string, string>,
): string {
  const from =
    (slab.originCityId && cityLabel.get(slab.originCityId)) ??
    (slab.originZoneId && zoneLabel.get(slab.originZoneId)) ??
    "Any";
  const to =
    (slab.destinationCityId && cityLabel.get(slab.destinationCityId)) ??
    (slab.destinationZoneId && zoneLabel.get(slab.destinationZoneId)) ??
    "Any";

  if (from === "Any" && to === "Any") return "Any lane";
  return `${from} → ${to}`;
}

function describeCondition(condition: unknown): string {
  if (!condition || typeof condition !== "object") return "Always";

  const flags = condition as Record<string, unknown>;
  const parts: string[] = [];
  if (flags.odaOnly) parts.push("ODA destination");
  if (flags.codOnly) parts.push("COD only");
  if (flags.requiresDeclaredValue) parts.push("value declared");
  if (flags.fragileOnly) parts.push("fragile");

  return parts.length > 0 ? parts.join(", ") : "Always";
}

/** Flattens the stored condition back into the switch names the form uses. */
function ruleRecord(rule: {
  id: string;
  chargeTypeId: string;
  basis: string;
  rate: unknown;
  minimumAmount: unknown;
  maximumAmount: unknown;
  sortOrder: number;
  isAutomatic: boolean;
  appliesWhen: unknown;
}): Record<string, unknown> {
  const condition = (rule.appliesWhen ?? {}) as Record<string, unknown>;

  return {
    id: rule.id,
    chargeTypeId: rule.chargeTypeId,
    basis: rule.basis,
    rate: rule.rate?.toString() ?? "",
    minimumAmount: rule.minimumAmount?.toString() ?? "",
    maximumAmount: rule.maximumAmount?.toString() ?? "",
    sortOrder: rule.sortOrder,
    isAutomatic: String(rule.isAutomatic),
    odaOnly: String(Boolean(condition.odaOnly)),
    codOnly: String(Boolean(condition.codOnly)),
    requiresDeclaredValue: String(Boolean(condition.requiresDeclaredValue)),
    fragileOnly: String(Boolean(condition.fragileOnly)),
  };
}
