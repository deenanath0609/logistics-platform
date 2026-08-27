"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The dock input.
 *
 * A USB or Bluetooth scanner gun presents itself as a keyboard: it types
 * the barcode faster than a human can and usually — but not always —
 * finishes with Enter. So this accepts three things at once:
 *
 *   1. a gun that sends a terminator → Enter submits;
 *   2. a gun that does not → a short idle after a burst submits;
 *   3. a human typing → the idle timer is long enough not to fire
 *      mid-word, and Enter always works.
 *
 * Focus is defended, not merely requested. An operator holding a gun in
 * one hand and a box in the other cannot click the field again after a
 * toast steals focus, so the input takes it back whenever it drifts.
 */

/** Fires when a burst of keystrokes stops, for guns with no terminator. */
const BURST_IDLE_MS = 90;
/** Below this, an idle flush is more likely a human mid-type than a scan. */
const MIN_AUTO_LENGTH = 6;
/** Keystrokes closer together than this did not come from a person. */
const MACHINE_INTERVAL_MS = 35;

export function ScanInput({
  onScan,
  disabled = false,
  placeholder = "Scan or type a barcode",
  hint,
  autoFocus = true,
}: {
  /** Resolves when the scan has been recorded. Never throws to the caller. */
  onScan: (barcode: string) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeyAt = useRef(0);
  const machineKeys = useRef(0);

  const focus = useCallback(() => {
    if (disabled) return;
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.focus();
  }, [disabled]);

  // Keep the field focused. The interval is cheap and catches every way
  // focus escapes — a toast, a dialog closing, a stray click on the table.
  useEffect(() => {
    if (!autoFocus) return;
    focus();
    const timer = setInterval(focus, 700);
    return () => clearInterval(timer);
  }, [autoFocus, focus]);

  const submit = useCallback(
    async (raw: string) => {
      const barcode = raw.trim();
      if (idleTimer.current) clearTimeout(idleTimer.current);
      machineKeys.current = 0;
      if (barcode === "") return;

      // Cleared before the await, not after: the next box is already
      // being scanned while this one is still in flight, and a field that
      // clears late swallows the following barcode's first characters.
      setValue("");
      setBusy(true);
      try {
        await onScan(barcode);
      } finally {
        setBusy(false);
        focus();
      }
    },
    [onScan, focus],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const now = Date.now();
    if (now - lastKeyAt.current < MACHINE_INTERVAL_MS) {
      machineKeys.current += 1;
    } else if (event.key.length === 1) {
      machineKeys.current = 0;
    }
    lastKeyAt.current = now;

    if (event.key === "Enter") {
      event.preventDefault();
      void submit(event.currentTarget.value);
      return;
    }

    // Escape abandons a half-typed barcode without submitting it.
    if (event.key === "Escape") {
      event.preventDefault();
      setValue("");
      if (idleTimer.current) clearTimeout(idleTimer.current);
    }
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setValue(next);

    if (idleTimer.current) clearTimeout(idleTimer.current);

    // Only flush on idle when the burst looked mechanical. A human typing
    // "CL2026" and pausing to read the next digit must not be submitted
    // out from under them.
    if (next.trim().length >= MIN_AUTO_LENGTH && machineKeys.current >= 3) {
      idleTimer.current = setTimeout(() => void submit(next), BURST_IDLE_MS);
    }
  }

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-xl border-2 bg-card px-3 py-2 transition-colors",
          disabled
            ? "border-border opacity-60"
            : "border-primary/40 focus-within:border-primary",
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ScanLine className="size-4" />
          )}
        </span>

        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Barcode"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          className="h-9 w-full min-w-0 bg-transparent font-mono text-lg tracking-wide outline-none placeholder:font-sans placeholder:text-base placeholder:tracking-normal placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
