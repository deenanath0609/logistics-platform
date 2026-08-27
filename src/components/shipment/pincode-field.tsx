"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type PincodeAnswer = {
  status: "SERVICEABLE" | "ODA" | "BLOCKED" | "UNKNOWN";
  code: string;
  area?: string | null;
  city?: string;
  branch?: string | null;
};

type Resolved = PincodeAnswer;

type Suggestion = {
  code: string;
  area: string | null;
  city: string;
  isServiceable: boolean;
  isOda: boolean;
};

/**
 * A PIN code field that answers immediately.
 *
 * Serviceability is enforced server-side at booking — that is the real
 * gate and this does not replace it. But learning that a destination is
 * outside the network *after* filling in twenty other fields wastes the
 * clerk's time and the customer's, so the field answers as the sixth
 * digit lands.
 *
 * Only the async results are state. Everything else — whether the code is
 * complete, whether a check is in flight, whether suggestions apply — is
 * derived from `value`, so there is no synchronous setState cascading a
 * second render on every keystroke.
 */
export function PincodeField({
  name,
  value,
  onValueChange,
  onResolved,
  required,
  error,
  className,
}: {
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Fires when the server has answered for the code currently on screen.
   * Lets the form act on it — a destination outside the network should
   * stop the booking before the clerk fills in another twenty fields.
   */
  onResolved?: (answer: Resolved | null) => void;
  required?: boolean;
  error?: string;
  className?: string;
}) {
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const listId = useId();
  const latest = useRef(0);
  // Held in a ref so callers can pass an inline arrow without the lookup
  // effect re-running on every parent render. Assigned in an effect, not
  // during render, which React forbids.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  const isComplete = value.length === 6;
  // In flight whenever the answer we hold is not for the code on screen.
  const isChecking = isComplete && resolved?.code !== value;
  const answer = isComplete && resolved?.code === value ? resolved : null;
  const showSuggestions = value.length >= 2 && value.length < 6;

  useEffect(() => {
    if (value.length !== 6) return;

    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/pincodes?code=${encodeURIComponent(value)}`,
        );
        const data = (await response.json()) as Resolved;
        // A slower earlier request must not overwrite a newer answer.
        if (ticket === latest.current && data?.code) {
          setResolved(data);
          onResolvedRef.current?.(data);
        }
      } catch {
        // Leave the previous answer; the server still enforces the rule.
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [value]);

  // Suggestions while the code is still being typed, so a clerk who does
  // not know the PIN can find it rather than guess.
  useEffect(() => {
    if (value.length < 2 || value.length >= 6) return;

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/pincodes?q=${encodeURIComponent(value)}`,
        );
        const data = await response.json();
        setSuggestions(data.results ?? []);
      } catch {
        /* suggestions are a convenience, not a requirement */
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [value]);

  const invalid =
    Boolean(error) ||
    answer?.status === "UNKNOWN" ||
    answer?.status === "BLOCKED";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="relative">
        <Input
          name={name}
          value={value}
          onChange={(e) =>
            onValueChange(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          inputMode="numeric"
          maxLength={6}
          list={listId}
          placeholder="6-digit PIN"
          aria-invalid={invalid}
          className="font-mono"
          required={required}
        />
        {isChecking && (
          <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      <datalist id={listId}>
        {showSuggestions &&
          suggestions.map((s) => (
            <option key={s.code} value={s.code}>
              {[s.area, s.city].filter(Boolean).join(", ")}
              {s.isOda ? " · ODA" : ""}
              {s.isServiceable ? "" : " · not serviceable"}
            </option>
          ))}
      </datalist>

      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : answer?.status === "SERVICEABLE" ? (
        <p className="flex items-center gap-1 text-xs text-ok">
          <Check className="size-3 shrink-0" />
          <span>
            {[answer.area, answer.city].filter(Boolean).join(", ")}
            {answer.branch && (
              <span className="text-muted-foreground">
                {" · delivered by "}
                {answer.branch}
              </span>
            )}
          </span>
        </p>
      ) : answer?.status === "ODA" ? (
        <p className="flex items-center gap-1 text-xs text-warn">
          <AlertTriangle className="size-3 shrink-0" />
          {[answer.area, answer.city].filter(Boolean).join(", ")} — out of
          delivery area, an ODA charge applies
        </p>
      ) : answer?.status === "BLOCKED" ? (
        <p className="flex items-center gap-1 text-xs text-bad">
          <XCircle className="size-3 shrink-0" />
          {answer.city} is currently not serviceable. Booking needs the
          override permission.
        </p>
      ) : answer?.status === "UNKNOWN" ? (
        <p className="flex items-start gap-1 text-xs text-bad">
          <XCircle className="mt-0.5 size-3 shrink-0" />
          <span>
            Not in the network. Type the first few digits to see PIN codes
            that are — or add it under Network → Pincodes.
          </span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Checked against serviceability as you type.
        </p>
      )}
    </div>
  );
}
