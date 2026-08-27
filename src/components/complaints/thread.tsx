"use client";

import { useId, useState, useTransition } from "react";
import { Eye, EyeOff, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ComplaintActionState } from "@/app/(ops)/complaints/actions";

/**
 * The reply box.
 *
 * Two buttons, not a checkbox with a Send next to it. "Add internal note"
 * and "Reply to customer" are different acts, and the difference has to be
 * unmissable at the moment of clicking — an ops aside that reaches the
 * customer is the failure mode this whole flag exists to prevent.
 */
export function ReplyBox({
  complaintId,
  action,
  canReply,
}: {
  complaintId: string;
  action: (
    prev: ComplaintActionState,
    formData: FormData,
  ) => Promise<ComplaintActionState>;
  canReply: boolean;
}) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState<"internal" | "customer">("internal");
  const formId = useId();

  function send(next: "internal" | "customer") {
    if (body.trim().length === 0) {
      toast.error("Nothing to send.");
      return;
    }

    const formData = new FormData();
    formData.set("complaintId", complaintId);
    formData.set("body", body);
    formData.set("visibility", next);

    setVisibility(next);
    startTransition(async () => {
      const result = await action({}, formData);
      if (result.ok) {
        toast.success(result.message ?? "Added.");
        setBody("");
      } else {
        toast.error(result.error ?? "Could not add that.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <Textarea
        id={formId}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        placeholder="Add a note, or reply to the customer…"
        aria-label="Message"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeOff className="size-3.5" />
          Notes are internal unless you reply.
        </p>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => send("internal")}
          >
            {pending && visibility === "internal" && (
              <Loader2 className="animate-spin" />
            )}
            <EyeOff />
            Internal note
          </Button>

          {canReply && (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => send("customer")}
            >
              {pending && visibility === "customer" && (
                <Loader2 className="animate-spin" />
              )}
              <Send />
              Reply to customer
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────

export type ThreadMessage = {
  id: string;
  body: string;
  isInternal: boolean;
  authorName: string;
  authorSide: "staff" | "customer";
  at: string;
};

/**
 * The thread.
 *
 * Internal notes are visually distinct from replies rather than merely
 * labelled, because the person scanning this at speed is looking for what
 * the customer has already been told — and a label they have stopped
 * reading is not a boundary.
 */
export function Thread({
  description,
  raisedBy,
  raisedAt,
  messages,
}: {
  description: string;
  raisedBy: string;
  raisedAt: string;
  messages: ThreadMessage[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <article className="rounded-lg border bg-card p-3">
        <header className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{raisedBy}</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {raisedAt}
          </span>
        </header>
        <p className="whitespace-pre-wrap text-sm">{description}</p>
      </article>

      {messages.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          Nothing on the thread yet.
        </p>
      ) : (
        messages.map((message) => (
          <article
            key={message.id}
            className={cn(
              "rounded-lg border p-3",
              message.isInternal
                ? "border-dashed bg-muted/50"
                : message.authorSide === "customer"
                  ? "bg-accent/40"
                  : "bg-card",
            )}
          >
            <header className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                {message.authorName}
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
                    message.isInternal
                      ? "bg-muted text-muted-foreground"
                      : "bg-ok-muted text-ok",
                  )}
                >
                  {message.isInternal ? (
                    <>
                      <EyeOff className="size-3" />
                      Internal
                    </>
                  ) : (
                    <>
                      <Eye className="size-3" />
                      Customer sees this
                    </>
                  )}
                </span>
              </span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">
                {message.at}
              </span>
            </header>
            <p className="whitespace-pre-wrap text-sm">{message.body}</p>
          </article>
        ))
      )}
    </div>
  );
}
