"use client";

import { useId, useState, useTransition } from "react";
import { Loader2, UserMinus, UserRoundCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionState } from "@/server/services/master-crud";

const EMPTY: ActionState = {};

/**
 * Icons are chosen here, not handed in.
 *
 * The roster is a server component and cannot pass a Lucide component
 * across the boundary, so the two states this dialog has are named by a
 * `mode` string and mapped to an icon on this side.
 */
const MODE = {
  deactivate: {
    icon: UserMinus,
    title: "Deactivate",
    confirm: "Deactivate",
    variant: "destructive" as const,
  },
  reactivate: {
    icon: UserRoundCheck,
    title: "Bring back",
    confirm: "Reactivate",
    variant: "default" as const,
  },
};

export function StaffStatusDialog({
  mode,
  userId,
  userName,
  branchLabel,
  codInHand,
  blockedReason,
  action,
}: {
  mode: keyof typeof MODE;
  userId: string;
  userName: string;
  branchLabel: string;
  /** Rupees collected and not yet deposited. Formatted by the caller. */
  codInHand?: string;
  /**
   * The refusal `deactivateFieldUser` would produce right now, computed
   * on the server from the same pure rule. Null when it would succeed.
   *
   * `field-staff.ts` puts it plainly: "a rule that lives only inside the
   * action is a rule the button cannot preview, and a disabled-looking
   * button that succeeds anyway is worse than no button." The rule refuses
   * outright on open work, the row already renders the run number and the
   * pickup count two cells away, and the dialog still asked "are you
   * sure?" and then failed. It now says which documents are in the way,
   * before anything is pressed.
   */
  blockedReason?: string | null;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const config = MODE[mode];
  const Icon = config.icon;
  const deactivating = mode === "deactivate";
  const holdingCash = Boolean(codInHand && Number(codInHand) > 0);
  const blocked = deactivating && Boolean(blockedReason);

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(EMPTY, formData);
      setState(result);
      if (result.ok) {
        toast.success(result.message ?? "Done.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setState(EMPTY);
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title={`${config.title} ${userName}`}
          />
        }
      >
        <Icon className={deactivating ? "text-bad" : "text-ok"} />
        <span className="sr-only">
          {config.title} {userName}
        </span>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          {/* The person is named in the title, not just in the row that was
              clicked — a confirmation that says "are you sure?" is a
              confirmation nobody reads. */}
          <DialogTitle>
            {config.title} {userName}?
          </DialogTitle>
          <DialogDescription>
            {deactivating ? (
              <>
                {userName} ({branchLabel}) is signed out immediately and
                disappears from run and pickup assignment. Their delivery
                history, PODs and COD records keep their name — nothing is
                erased. You can bring them back from this screen.
              </>
            ) : (
              <>
                {userName} ({branchLabel}) can sign in on the field app again
                and will reappear in the assignment lists.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {blocked && (
          <p className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad">
            {blockedReason}
          </p>
        )}

        {deactivating && holdingCash && (
          <p className="rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
            {userName} is still holding ₹{codInHand} in undeposited COD.
            Deactivating does not settle it — collect the cash and record the
            deposit, or it stays open against their name.
          </p>
        )}

        <form id={formId} action={submit}>
          <input type="hidden" name="id" value={userId} />
        </form>

        {state.error && (
          <p
            role="alert"
            className="rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad"
          >
            {state.error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={config.variant}
            disabled={pending || blocked}
            title={blocked ? (blockedReason ?? undefined) : undefined}
          >
            {pending && <Loader2 className="animate-spin" />}
            {config.confirm} {userName}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
