"use client";

import { useActionState, useMemo, useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import { isModuleKey, type ModuleKey } from "@/lib/modules/registry";
import {
  MODULE_GROUPS,
  alwaysOnModules,
  auditPlanModules,
  blockedReason,
  moduleDefinition,
  ungroupedModules,
  unrecognisedFeatures,
} from "@/lib/platform/plan-modules";
import { createPlanAction, updatePlanAction } from "./actions";

export type PlanValues = {
  code: string;
  name: string;
  maxUsers: number | null;
  maxBranches: number | null;
  maxShipmentsPerMonth: number | null;
  maxPortalUsers: number | null;
  features: string[];
  monthlyPrice: string | null;
  currency: string;
  isActive: boolean;
  sortOrder: number;
};

const BLANK: PlanValues = {
  code: "",
  name: "",
  maxUsers: null,
  maxBranches: null,
  maxShipmentsPerMonth: null,
  maxPortalUsers: null,
  features: [],
  monthlyPrice: null,
  currency: "INR",
  isActive: true,
  sortOrder: 0,
};

/** Blank stays blank. See the note on `limit()` in actions.ts. */
function numberValue(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * One module, as a row you can tick.
 *
 * `alwaysOn` renders ticked and disabled rather than being left out of the
 * list. An operator building a plan should be able to see that booking and
 * staff administration are in there — a plan whose editor showed nine
 * modules would look like a plan that sells nine things, and it sells ten.
 */
function ModuleRow({
  moduleKey,
  checked,
  locked,
  onToggle,
}: {
  moduleKey: ModuleKey;
  checked: boolean;
  locked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const definition = moduleDefinition(moduleKey);

  return (
    <label
      className={
        locked
          ? "flex items-start gap-2.5 rounded-md border border-dashed bg-muted/30 px-3 py-2"
          : "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 hover:bg-accent/40"
      }
    >
      <Checkbox
        checked={checked}
        disabled={locked}
        onCheckedChange={(value) => onToggle(Boolean(value))}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {definition?.label ?? moduleKey}
          {locked && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
              <Lock className="size-2.5" aria-hidden />
              Always included
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {definition?.description}
        </span>
        <span className="font-mono text-[0.6rem] text-muted-foreground/70">
          {moduleKey}
        </span>
      </span>
    </label>
  );
}

export function PlanForm({
  planId,
  values = BLANK,
}: {
  /** Absent creates; present edits. */
  planId?: string;
  values?: PlanValues;
}) {
  const [state, action] = useActionState(
    planId ? updatePlanAction.bind(null, planId) : createPlanAction,
    IDLE_FORM,
  );

  // Seeded from the stored column, which may hold anything: only real keys
  // survive, and the always-on ones go in whether or not they were stored.
  const [selected, setSelected] = useState<Set<ModuleKey>>(
    () =>
      new Set<ModuleKey>([
        ...alwaysOnModules(),
        ...values.features.filter(isModuleKey),
      ]),
  );

  const locked = useMemo(() => new Set(alwaysOnModules()), []);
  const ungrouped = useMemo(() => ungroupedModules(), []);

  // Recomputed on every tick so an unmet prerequisite is visible while the
  // plan is being built, rather than discovered later by a carrier who
  // bought Billing and cannot see an invoice.
  const audit = useMemo(() => auditPlanModules([...selected]), [selected]);

  // Free-text left over from before `features` was typed. It is shown so
  // an operator can see what saving is about to discard.
  const legacy = useMemo(
    () => unrecognisedFeatures(values.features),
    [values.features],
  );

  function toggle(key: ModuleKey, next: boolean) {
    setSelected((current) => {
      const updated = new Set(current);
      if (next) updated.add(key);
      else updated.delete(key);
      return updated;
    });
  }

  const groups = [
    ...MODULE_GROUPS,
    ...(ungrouped.length > 0
      ? [
          {
            title: "Not yet grouped",
            description:
              "In the registry but not placed in MODULE_GROUPS. Sellable, but somebody should decide where it belongs.",
            keys: ungrouped,
          },
        ]
      : []),
  ];

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          htmlFor="code"
          hint="Short and stable — it is how other systems refer to the plan. Upper-cased on save."
        >
          <Input id="code" name="code" defaultValue={values.code} required />
        </Field>
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" defaultValue={values.name} required />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          Limits — blank is unlimited, 0 switches the feature off
        </p>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Users" htmlFor="maxUsers">
            <Input
              id="maxUsers"
              name="maxUsers"
              inputMode="numeric"
              placeholder="∞"
              defaultValue={numberValue(values.maxUsers)}
            />
          </Field>
          <Field label="Branches" htmlFor="maxBranches">
            <Input
              id="maxBranches"
              name="maxBranches"
              inputMode="numeric"
              placeholder="∞"
              defaultValue={numberValue(values.maxBranches)}
            />
          </Field>
          <Field label="Shipments / month" htmlFor="maxShipmentsPerMonth">
            <Input
              id="maxShipmentsPerMonth"
              name="maxShipmentsPerMonth"
              inputMode="numeric"
              placeholder="∞"
              defaultValue={numberValue(values.maxShipmentsPerMonth)}
            />
          </Field>
          <Field label="Portal users" htmlFor="maxPortalUsers">
            <Input
              id="maxPortalUsers"
              name="maxPortalUsers"
              inputMode="numeric"
              placeholder="∞"
              defaultValue={numberValue(values.maxPortalUsers)}
            />
          </Field>
        </div>
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="pb-1 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          Modules — what the plan sells
        </legend>

        {/* The selection is held in React state and posted as hidden
            inputs rather than by naming the checkboxes: the always-on rows
            are disabled, and a disabled control posts nothing, which would
            drop core from the column on every save. */}
        {[...selected].map((key) => (
          <input key={key} type="hidden" name="features" value={key} />
        ))}

        {legacy.length > 0 && (
          <p
            role="status"
            className="rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-xs text-warn"
          >
            This plan also stores{" "}
            <span className="font-mono">{legacy.join(", ")}</span>, which
            name no module and grant nothing. They are dropped when you save.
          </p>
        )}

        {audit.blocked.length > 0 && (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-xs text-warn"
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <TriangleAlert className="size-3.5" aria-hidden />
              Ticked, but not granted
            </span>
            {audit.blocked.map((blocked) => (
              <span key={blocked.key}>{blockedReason(blocked)}</span>
            ))}
            <span className="text-warn/80">
              A carrier on this plan will not get these until the modules
              they depend on are ticked too.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {alwaysOnModules().map((key) => (
            <ModuleRow
              key={key}
              moduleKey={key}
              checked
              locked
              onToggle={() => undefined}
            />
          ))}
        </div>

        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-semibold tracking-tight">
                {group.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                {group.description}
              </p>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {group.keys.map((key) => (
                <ModuleRow
                  key={key}
                  moduleKey={key}
                  checked={selected.has(key)}
                  locked={locked.has(key)}
                  onToggle={(next) => toggle(key, next)}
                />
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Monthly price" htmlFor="monthlyPrice">
          <Input
            id="monthlyPrice"
            name="monthlyPrice"
            inputMode="decimal"
            defaultValue={values.monthlyPrice ?? ""}
            placeholder="Not priced here"
          />
        </Field>
        <Field label="Currency" htmlFor="currency">
          <Input id="currency" name="currency" defaultValue={values.currency} />
        </Field>
        <Field
          label="Sort order"
          htmlFor="sortOrder"
          hint="Lowest first, in every picker."
        >
          <Input
            id="sortOrder"
            name="sortOrder"
            inputMode="numeric"
            defaultValue={String(values.sortOrder)}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={values.isActive}
          className="size-4"
        />
        Offered to new tenants. Unticking retires the plan without moving
        anybody already on it.
      </label>

      <FormAlert state={state} />

      <SubmitButton className="self-start">
        {planId ? "Save plan" : "Create plan"}
      </SubmitButton>
    </form>
  );
}
