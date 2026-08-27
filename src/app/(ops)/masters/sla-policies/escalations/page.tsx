import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import { PriorityPill } from "@/components/exceptions/pills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KIND_DEFS, KIND_ORDER } from "@/lib/exceptions/kinds";
import { formatDuration } from "@/lib/sla/policy";
import { DEFAULT_ESCALATION_RULES } from "@/lib/sla/defaults";
import {
  createEscalationRule,
  updateEscalationRule,
  setEscalationRuleActive,
} from "./actions";
import type { ExceptionKind } from "@/generated/prisma/client";

export const metadata: Metadata = { title: "Escalation rules" };
export const dynamic = "force-dynamic";

/**
 * Who gets told, and when — docs/BRD.html §A.11.
 *
 * Every kind of exception is listed whether or not it has a ladder,
 * because the gap is the interesting part: a kind with no rungs escalates
 * once on the built-in floor from `kinds.ts` and then sits at the top of
 * a ladder with nowhere to go, visible only to whoever noticed it. The
 * "not configured" row is the prompt to fix that.
 */
export default async function EscalationRulesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "sla.manage");

  const [rules, roles, users] = await Promise.all([
    prisma.escalationRule.findMany({
      where: { orgId: user.orgId },
      orderBy: [{ kind: "asc" }, { level: "asc" }],
    }),
    prisma.role.findMany({
      where: { orgId: user.orgId, isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.user.findMany({
      where: { orgId: user.orgId, status: "ACTIVE", deletedAt: null },
      orderBy: { name: "asc" },
      take: 200,
      select: { id: true, name: true },
    }),
  ]);

  const roleName = new Map(roles.map((role) => [role.code, role.name]));
  const userName = new Map(users.map((row) => [row.id, row.name]));

  const FIELDS: FieldDef[] = [
    {
      type: "select",
      name: "kind",
      label: "Exception kind",
      required: true,
      options: KIND_ORDER.map((kind) => ({
        value: kind,
        label: KIND_DEFS[kind].label,
      })),
    },
    {
      type: "number",
      name: "level",
      label: "Level",
      required: true,
      half: true,
      help: "1 is the first person told.",
    },
    {
      type: "number",
      name: "afterMinutes",
      label: "After (minutes)",
      required: true,
      half: true,
      help: "Measured from detection, not from the previous level.",
    },
    {
      type: "select",
      name: "notifyRoleCode",
      label: "Notify role",
      placeholder: "No role",
      options: roles.map((role) => ({
        value: role.code,
        label: `${role.code} — ${role.name}`,
      })),
    },
    {
      type: "select",
      name: "notifyUserId",
      label: "Notify person",
      placeholder: "Nobody in particular",
      help: "Use sparingly. A named person goes stale the day they change desk.",
      options: users.map((row) => ({ value: row.id, label: row.name })),
    },
    { type: "switch", name: "isActive", label: "Active" },
  ];

  const byKind = new Map<ExceptionKind, typeof rules>();
  for (const rule of rules) {
    const list = byKind.get(rule.kind) ?? [];
    list.push(rule);
    byKind.set(rule.kind, list);
  }

  const seedByKind = new Map<string, typeof DEFAULT_ESCALATION_RULES>();
  for (const seed of DEFAULT_ESCALATION_RULES) {
    const list = seedByKind.get(seed.kind) ?? [];
    seedByKind.set(seed.kind, [...list, seed]);
  }

  const configured = byKind.size;

  return (
    <>
      <PageHeader
        eyebrow="Masters · SLA"
        title="Escalation rules"
        description="If nobody acts, who hears about it next. Each level fires a fixed number of minutes after the exception was detected, so the ladder describes total tolerance rather than a chain of relative delays."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/masters/sla-policies" />}
            >
              <ArrowLeft />
              SLA policies
            </Button>
            {writable && (
              <MasterFormDialog
                title="New escalation rung"
                description="One row per level per kind. Level 2 at 120 minutes fires two hours after detection, whether or not level 1 fired."
                fields={FIELDS}
                action={createEscalationRule}
                submitLabel="Create"
                trigger={{ label: "New rung", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Every exception kind
        </h2>
        <span className="text-xs text-muted-foreground tabular">
          {configured} of {KIND_ORDER.length} have a ladder
        </span>
      </div>

      <TableFrame>
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>Exception</TableHead>
              <TableHead>Default owner</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Ladder</TableHead>
              <TableHead>Suggested (BRD §A.11)</TableHead>
              {writable && (
                <TableHead className="w-24 text-right">Actions</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {KIND_ORDER.map((kind) => {
              const def = KIND_DEFS[kind];
              const ladder = byKind.get(kind) ?? [];
              const suggested = seedByKind.get(kind) ?? [];

              return (
                <TableRow key={kind}>
                  <TableCell className="align-top">
                    <span className="text-sm font-medium">{def.label}</span>
                    <span className="block font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      {def.detectedBy}
                    </span>
                  </TableCell>

                  <TableCell className="align-top text-xs text-muted-foreground">
                    {def.defaultOwner}
                  </TableCell>

                  <TableCell className="align-top">
                    <PriorityPill priority={def.priority} />
                  </TableCell>

                  <TableCell className="align-top">
                    {ladder.length === 0 ? (
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="outline">Not configured</Badge>
                        <span className="text-[0.65rem] text-muted-foreground">
                          Falls back to one escalation at{" "}
                          {formatDuration(def.escalateAfterMinutes)}, then
                          nowhere.
                        </span>
                      </div>
                    ) : (
                      <ol className="flex flex-col gap-1">
                        {ladder.map((rule) => (
                          <li
                            key={rule.id}
                            className={`flex flex-wrap items-baseline gap-x-2 text-xs ${
                              rule.isActive ? "" : "opacity-55 line-through"
                            }`}
                          >
                            <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
                              L{rule.level}
                            </span>
                            <span className="font-mono tabular">
                              {formatDuration(rule.afterMinutes)}
                            </span>
                            <span className="text-muted-foreground">
                              →{" "}
                              {rule.notifyRoleCode
                                ? (roleName.get(rule.notifyRoleCode) ??
                                  rule.notifyRoleCode)
                                : rule.notifyUserId
                                  ? (userName.get(rule.notifyUserId) ??
                                    "A user")
                                  : "nobody named"}
                            </span>
                            {writable && (
                              <span className="flex items-center gap-0.5">
                                <MasterFormDialog
                                  title={`Edit ${def.label} level ${rule.level}`}
                                  fields={FIELDS}
                                  action={updateEscalationRule}
                                  record={
                                    rule as unknown as Record<string, unknown>
                                  }
                                  trigger={{
                                    label: `Edit ${def.label} level ${rule.level}`,
                                    icon: "pencil",
                                    variant: "ghost",
                                    size: "icon-sm",
                                    iconOnly: true,
                                  }}
                                />
                                <ToggleActive
                                  id={rule.id}
                                  isActive={rule.isActive}
                                  label={`${def.label} level ${rule.level}`}
                                  action={setEscalationRuleActive}
                                />
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </TableCell>

                  <TableCell className="align-top text-xs text-muted-foreground">
                    {suggested.length === 0
                      ? "—"
                      : suggested
                          .map(
                            (seed) =>
                              `L${seed.level} ${formatDuration(seed.afterMinutes)} → ${seed.notifyRoleCode}`,
                          )
                          .join(" · ")}
                  </TableCell>

                  {writable && (
                    <TableCell className="align-top text-right">
                      <MasterFormDialog
                        title={`Add a rung to ${def.label}`}
                        fields={FIELDS}
                        action={createEscalationRule}
                        record={{
                          kind,
                          level: ladder.length + 1,
                          afterMinutes:
                            suggested[ladder.length]?.afterMinutes ??
                            def.escalateAfterMinutes,
                          notifyRoleCode:
                            suggested[ladder.length]?.notifyRoleCode ?? "",
                          isActive: true,
                        }}
                        trigger={{
                          label: `Add a rung to ${def.label}`,
                          icon: "plus",
                          variant: "ghost",
                          size: "icon-sm",
                          iconOnly: true,
                        }}
                        submitLabel="Create"
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableFrame>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        The suggested column is <code>DEFAULT_ESCALATION_RULES</code> in{" "}
        <code>src/lib/sla/defaults.ts</code> — the seed reads the same data, so
        a fresh install and this screen never disagree about what the BRD says.
      </p>
    </>
  );
}
