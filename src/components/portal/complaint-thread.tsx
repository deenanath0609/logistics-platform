"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PortalMessage } from "@/lib/portal/complaints";
import {
  replyToComplaint,
  type ComplaintState,
} from "@/app/(portal)/portal/(app)/complaints/actions";

const EMPTY: ComplaintState = {};

/**
 * The conversation.
 *
 * Every message here came through `customerVisibleMessages()` and
 * `toPortalThread` — internal notes are filtered in the data layer and
 * again in the projection, so there is nothing for this component to hide
 * and no flag for it to check. It renders what it is given.
 *
 * Laid out as a chat rather than a table: on a 375px screen a two-column
 * "author / message" grid gives the message about forty characters a line,
 * and a complaint thread is prose.
 *
 * `carrierName` arrives as a prop rather than being resolved here: this is a
 * client component, and the tenant is a property of the request host that
 * only the server has read.
 */
export function ComplaintThread({
  complaintId,
  messages,
  canReply,
  settled,
  carrierName,
}: {
  complaintId: string;
  messages: PortalMessage[];
  canReply: boolean;
  settled: boolean;
  carrierName: string;
}) {
  const [state, action, pending] = useActionState(replyToComplaint, EMPTY);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Clear the box once the reply has landed, so a slow connection cannot
  // leave the customer looking at text they have already sent.
  useEffect(() => {
    if (state.ok && boxRef.current) boxRef.current.value = "";
  }, [state.ok]);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
        Conversation
      </h2>

      {messages.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing here yet. You will see every reply from the team in this
          thread.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages.map((message) => {
            const mine = message.author !== "team";

            return (
              <li
                key={message.id}
                className={cn("flex", mine ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "flex max-w-[85%] flex-col gap-1 rounded-lg border px-3 py-2 sm:max-w-[70%]",
                    mine ? "bg-accent" : "bg-card",
                  )}
                >
                  <p className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                    {message.author === "you"
                      ? "You"
                      : message.author === "colleague"
                        ? (message.authorName ?? "Your colleague")
                        : carrierName}
                    {" · "}
                    <time dateTime={message.at}>
                      {new Date(message.at).toLocaleString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </p>
                  <p className="text-sm whitespace-pre-wrap break-words">
                    {message.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canReply && (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="complaintId" value={complaintId} />
          <label htmlFor="body" className="sr-only">
            Your reply
          </label>
          <Textarea
            id="body"
            name="body"
            ref={boxRef}
            rows={3}
            maxLength={4000}
            placeholder={
              settled
                ? "Not settled? Say so here and the team can reopen it."
                : "Add anything that would help…"
            }
            required
          />

          {state.error && <p className="text-sm text-bad">{state.error}</p>}
          {state.ok && state.message && (
            <p className="text-sm text-ok">{state.message}</p>
          )}

          <div className="flex items-center justify-between gap-3">
            {settled ? (
              <p className="text-xs text-muted-foreground">
                This complaint is settled. A reply does not reopen it on its
                own — the team reads it and decides.
              </p>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Send />}
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
