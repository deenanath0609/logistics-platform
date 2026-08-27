"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { LaneTestResult } from "@/app/(ops)/masters/sla-policies/actions";

/**
 * "Test a lane".
 *
 * A list of twelve overlapping policies is not readable as a list. The
 * question anybody actually has is "which one governs Delhi → Jaipur
 * express, booked at 18:40 on a Friday?", and the only trustworthy answer
 * is the one produced by the same code that will answer it for a real
 * shipment — so this posts to a server action that calls `explainPlan`,
 * and prints the steps it took.
 *
 * Showing the working is the point. A due date presented as an oracle is
 * a due date a branch manager will dispute the first time it costs them,
 * and the argument will be about the software rather than the freight.
 */

export type Option = { value: string; label: string };

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const MATCHED_ON_LABEL: Record<string, string> = {
  city: "City pair",
  zone: "Zone pair",
  service: "Service default",
  network: "Network default",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Renders an instant as branch-local (IST) wall clock, which is what ops read. */
function ist(value: Date | string): string {
  const at = typeof value === "string" ? new Date(value) : value;
  const shifted = new Date(at.getTime() + 330 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = DAY_NAMES[shifted.getUTCDay()];

  return (
    `${day} ${pad(shifted.getUTCDate())}/${pad(shifted.getUTCMonth() + 1)}/${shifted.getUTCFullYear()}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

export function LaneTester({
  serviceTypes,
  cities,
  branches,
  defaultBookedAt,
  action,
}: {
  serviceTypes: Option[];
  cities: Option[];
  branches: Option[];
  /** "YYYY-MM-DDTHH:mm" in IST, computed on the server so SSR is stable. */
  defaultBookedAt: string;
  action: (formData: FormData) => Promise<LaneTestResult>;
}) {
  const [result, setResult] = useState<LaneTestResult | null>(null);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  function submit(formData: FormData) {
    startTransition(async () => {
      setResult(await action(formData));
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          <FlaskConical className="size-3.5" />
          Test a lane
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Ask what a booking would actually be promised. The answer comes from
          the same resolver the scanner uses, so anything you see here is what
          a real consignment gets.
        </p>
      </div>

      <form
        id={formId}
        action={submit}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <Field label="Service type" htmlFor={`${formId}-service`}>
          <select
            id={`${formId}-service`}
            name="serviceTypeId"
            className={SELECT_CLASS}
            defaultValue={serviceTypes[0]?.value ?? ""}
          >
            {serviceTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Origin city" htmlFor={`${formId}-origin`}>
          <select
            id={`${formId}-origin`}
            name="originCityId"
            className={SELECT_CLASS}
            defaultValue={cities[0]?.value ?? ""}
          >
            {cities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Destination city" htmlFor={`${formId}-destination`}>
          <select
            id={`${formId}-destination`}
            name="destinationCityId"
            className={SELECT_CLASS}
            defaultValue={cities[1]?.value ?? cities[0]?.value ?? ""}
          >
            {cities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Booked at"
          htmlFor={`${formId}-booked`}
          help="Branch local time"
        >
          <Input
            id={`${formId}-booked`}
            name="bookedAt"
            type="datetime-local"
            defaultValue={defaultBookedAt}
            className="h-8"
          />
        </Field>

        <Field
          label="Calendar"
          htmlFor={`${formId}-branch`}
          help="Whose working hours"
        >
          <select
            id={`${formId}-branch`}
            name="originBranchId"
            className={SELECT_CLASS}
            defaultValue=""
          >
            <option value="">A branch in the origin city</option>
            {branches.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="sm:col-span-2 lg:col-span-5">
          <Button type="submit" size="sm" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Resolve this lane
          </Button>
        </div>
      </form>

      {result && <LaneTestReport result={result} />}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function LaneTestReport({ result }: { result: LaneTestResult }) {
  if (!result.ok) {
    return (
      <p
        role="alert"
        className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
      >
        {result.error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      {/* ── The answer ───────────────────────────────── */}
      {result.winner ? (
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <Answer label="Policy">
            <span className="font-mono text-sm font-medium">
              {result.winner.code}
            </span>
            <span className="block text-xs text-muted-foreground">
              {result.winner.name}
            </span>
          </Answer>
          <Answer label="Matched on">
            {MATCHED_ON_LABEL[result.winner.matchedOn] ?? result.winner.matchedOn}
            <span className="block font-mono text-[0.65rem] text-muted-foreground">
              specificity {result.winner.specificity}
            </span>
          </Answer>
          <Answer label="Clock starts">{ist(result.startedAt!)}</Answer>
          <Answer label="At risk from">
            <span className="text-warn">{ist(result.atRiskAt!)}</span>
            <span className="block font-mono text-[0.65rem] text-muted-foreground">
              {result.winner.atRiskPercent}% elapsed
            </span>
          </Answer>
          <Answer label="Due">
            <span className="font-medium">{ist(result.dueAt!)}</span>
            <span className="block font-mono text-[0.65rem] text-muted-foreground">
              {result.winner.transitHours} h
              {result.winner.useWorkingHours ? " working" : " wall clock"}
            </span>
          </Answer>
        </div>
      ) : (
        <div className="rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
          <p className="font-medium">No promise on this lane.</p>
          <p>
            {result.notApplicableReason ??
              "No SLA policy covers this lane and service."}{" "}
            Every shipment on it reports as “No SLA”, and it is excluded from
            the on-time figures rather than counted as a failure.
          </p>
        </div>
      )}

      {/* ── The working ──────────────────────────────── */}
      {result.winner && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              How the clock started
            </h3>
            <ol className="flex flex-col gap-1.5">
              {result.steps.map((step, index) => (
                <li key={index} className="flex gap-2 text-xs">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-border" />
                  <span>
                    <span className="font-mono font-semibold uppercase tracking-wider">
                      {step.rule}
                    </span>
                    <span className="ml-1.5 text-muted-foreground">
                      {step.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {result.skipped.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Stepped over{" "}
                {result.skipped
                  .map((day) => `${day.ymd} (${day.reason.toLowerCase()})`)
                  .join(", ")}
                .
              </p>
            )}

            {result.calendar && (
              <p className="text-xs text-muted-foreground">
                Calendar: {result.calendar.branchCode} — open{" "}
                {result.calendar.openingTime}–{result.calendar.closingTime}
                {result.calendar.bookingCutoff
                  ? `, cut-off ${result.calendar.bookingCutoff}`
                  : ", no cut-off"}
                {result.calendar.weeklyOffDays.length > 0 &&
                  `, shut ${result.calendar.weeklyOffDays
                    .map((day) => DAY_NAMES[day])
                    .join(" & ")}`}
                {result.calendar.holidayCount > 0 &&
                  `, ${result.calendar.holidayCount} holiday(s) on file`}
                .
              </p>
            )}
          </div>

          {/* ── What it beat ───────────────────────────── */}
          <div className="flex flex-col gap-2">
            <h3 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Policies that also cover this lane
            </h3>

            {result.candidates.length <= 1 ? (
              <p className="text-xs text-muted-foreground">
                Nothing else matched. This lane has exactly one policy.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {result.candidates.map((candidate) => (
                  <li
                    key={candidate.code}
                    className={cn(
                      "flex items-baseline justify-between gap-3 rounded-md px-2 py-1 text-xs",
                      candidate.isWinner
                        ? "bg-ok-muted text-ok"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="font-mono">{candidate.code}</span>
                    <span className="flex shrink-0 items-center gap-3 font-mono tabular">
                      <span>{candidate.transitHours} h</span>
                      <span title="Higher wins">
                        spec {candidate.specificity}
                      </span>
                      <span title="Beats specificity outright">
                        pri {candidate.priority}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-muted-foreground">
              Priority is checked first, then specificity — a city pair (20 per
              side) beats a zone pair (10), which beats a service default (1).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Answer({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
