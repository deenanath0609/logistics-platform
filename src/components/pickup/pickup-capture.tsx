"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackageCheck, Play, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  collectPickupAction,
  failPickupAction,
  startPickupAction,
  type PickupActionState,
} from "@/app/(field)/pickups/actions";

/**
 * What happens at the door, as two buttons.
 *
 * Collected or not collected. Everything else on this screen is reference
 * material; these are the only two things a person can do, so they are the
 * only two controls, and neither is behind a menu.
 *
 * ── Why the count is asked for and pre-filled ───────────────
 *
 * The booking says how many packages were expected and the field is filled
 * with it, because most of the time that is the answer and a person holding
 * boxes should not have to type. But it stays editable and what they leave
 * is what is recorded: six expected and five handed over is stored as five
 * against six, not silently reconciled. The difference is money, and the
 * office needs to see it existed.
 *
 * ── The submission key ──────────────────────────────────────
 *
 * Generated once per mounted form and sent with it. A thumb on a slow
 * connection taps twice; both submissions carry the same key, and the
 * second writes nothing. This is the same guarantee the offline queue gives
 * the delivery screens, applied to a form that submits directly.
 */
export function PickupCapture({
  assignmentId,
  attemptNumber,
  started,
  expectedPackages,
  reasons,
}: {
  assignmentId: string;
  /** Which visit this will be — 1 for the first. Part of the submission key. */
  attemptNumber: number;
  started: boolean;
  expectedPackages: number | null;
  reasons: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "collect" | "fail">("idle");

  return (
    <div className="flex flex-col gap-3">
      {!started && <StartButton assignmentId={assignmentId} />}

      {mode === "idle" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            size="lg"
            className="min-h-14 text-base"
            onClick={() => setMode("collect")}
          >
            <PackageCheck />
            Collected
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="min-h-14 text-base"
            onClick={() => setMode("fail")}
          >
            <XCircle />
            Could not collect
          </Button>
        </div>
      )}

      {mode === "collect" && (
        <CollectForm
          assignmentId={assignmentId}
          attemptNumber={attemptNumber}
          expectedPackages={expectedPackages}
          onCancel={() => setMode("idle")}
          onDone={() => {
            setMode("idle");
            router.refresh();
          }}
        />
      )}

      {mode === "fail" && (
        <FailForm
          assignmentId={assignmentId}
          attemptNumber={attemptNumber}
          reasons={reasons}
          onCancel={() => setMode("idle")}
          onDone={() => {
            setMode("idle");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function StartButton({ assignmentId }: { assignmentId: string }) {
  const [state, action, pending] = useActionState<PickupActionState, FormData>(
    startPickupAction,
    {},
  );
  const router = useRouter();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "On the way.");
      router.refresh();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <form action={action}>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <Button
        type="submit"
        size="lg"
        variant="secondary"
        className="min-h-12 w-full text-base"
        disabled={pending}
      >
        <Play />
        {pending ? "Starting…" : "On the way"}
      </Button>
    </form>
  );
}

function CollectForm({
  assignmentId,
  attemptNumber,
  expectedPackages,
  onCancel,
  onDone,
}: {
  assignmentId: string;
  attemptNumber: number;
  expectedPackages: number | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<PickupActionState, FormData>(
    collectPickupAction,
    {},
  );
  const instance = useId();
  const submissionId = submissionKey(assignmentId, attemptNumber, instance);
  const countId = useId();
  const weightId = useId();
  const nameId = useId();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Collected.");
      onDone();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, onDone]);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="idempotencyKey" value={submissionId} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={countId}>Packages collected</Label>
        <Input
          id={countId}
          name="packagesCollected"
          type="number"
          inputMode="numeric"
          min={1}
          defaultValue={expectedPackages ?? undefined}
          required
          className="h-12 text-base"
        />
        {expectedPackages !== null && (
          <p className="text-xs text-muted-foreground">
            {expectedPackages} were expected. Change it if the count differs —
            what you enter is what is recorded.
          </p>
        )}
        {state.fieldErrors?.packagesCollected && (
          <p className="text-xs text-bad">{state.fieldErrors.packagesCollected}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={weightId}>Weight, if you have it (kg)</Label>
        <Input
          id={weightId}
          name="weightCollected"
          type="number"
          inputMode="decimal"
          step="0.001"
          min={0}
          className="h-12 text-base"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId}>Handed over by</Label>
        <Input id={nameId} name="receiverName" className="h-12 text-base" />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="lg" className="min-h-12 flex-1 text-base" disabled={pending}>
          {pending ? "Saving…" : "Confirm collection"}
        </Button>
        <Button type="button" size="lg" variant="ghost" onClick={onCancel} disabled={pending}>
          Back
        </Button>
      </div>
    </form>
  );
}

function FailForm({
  assignmentId,
  attemptNumber,
  reasons,
  onCancel,
  onDone,
}: {
  assignmentId: string;
  attemptNumber: number;
  reasons: { id: string; code: string; name: string }[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<PickupActionState, FormData>(
    failPickupAction,
    {},
  );
  const instance = useId();
  const submissionId = submissionKey(assignmentId, attemptNumber, instance);
  const remarksId = useId();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Recorded.");
      onDone();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, onDone]);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="idempotencyKey" value={submissionId} />

      <fieldset className="flex flex-col gap-2">
        {/*
          Radio buttons rather than a select. The reason is required — the
          shipment's own log refuses the attempt without one — and a list a
          thumb can hit is faster than a dropdown for a person standing up.
        */}
        <legend className="mb-1 text-sm font-medium">Why not?</legend>
        {reasons.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pickup-failure reasons are configured. The branch has to add
            them in masters before this can be recorded.
          </p>
        ) : (
          reasons.map((reason) => (
            <label
              key={reason.id}
              className="flex min-h-12 items-center gap-3 rounded-md border px-3 has-checked:border-primary has-checked:bg-primary/5"
            >
              <input
                type="radio"
                name="reasonCodeId"
                value={reason.id}
                required
                className="size-4"
              />
              <span className="text-sm">{reason.name}</span>
            </label>
          ))
        )}
        {state.fieldErrors?.reasonCodeId && (
          <p className="text-xs text-bad">{state.fieldErrors.reasonCodeId}</p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={remarksId}>Anything to add</Label>
        <Input id={remarksId} name="remarks" className="h-12 text-base" />
      </div>

      <p className="text-xs text-muted-foreground">
        This comes back to you on the next working day. The consignor is still
        owed a collection — it is not closed.
      </p>

      <div className="flex gap-2">
        <Button
          type="submit"
          size="lg"
          variant="outline"
          className="min-h-12 flex-1 text-base"
          disabled={pending || reasons.length === 0}
        >
          {pending ? "Saving…" : "Record the visit"}
        </Button>
        <Button type="button" size="lg" variant="ghost" onClick={onCancel} disabled={pending}>
          Back
        </Button>
      </div>
    </form>
  );
}

/**
 * The key that makes a double tap harmless.
 *
 * Deliberately not random. A value generated during render differs between
 * the server's HTML and the client's hydration; generated in an effect it
 * is a state write on mount, which is its own smell. Both are ways of
 * avoiding the real question, which is what "the same submission" means.
 *
 * It means: this stop, this attempt. Two taps on one form are the same
 * attempt and must write once — same key, second one ignored. A genuine
 * second visit is a different attempt number and gets a different key, so
 * it is recorded as the separate visit it is. The component instance is in
 * there too, so the collect and fail forms cannot collide.
 */
function submissionKey(assignmentId: string, attempt: number, instance: string): string {
  return `${assignmentId}:${attempt}:${instance}`;
}
