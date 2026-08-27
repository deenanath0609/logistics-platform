"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The one and only sighting of a secret.
 *
 * Deliberately loud, and deliberately not dismissible by accident: the
 * value cannot be recovered, so an operator who navigates away without
 * copying it has to issue a new one. Saying that plainly is cheaper than
 * the support call that follows from not saying it.
 */
export function SecretReveal({
  label,
  secret,
  hint,
}: {
  label: string;
  secret: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused. The value is on screen and
      // selectable, so this is a convenience failing, not the feature.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn-muted p-4">
      <div className="flex items-center gap-2 text-warn">
        <TriangleAlert className="size-4" />
        <p className="text-sm font-medium">{label}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs">
          {secret}
        </code>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <p className="flex items-start gap-2 text-xs text-warn">
        <KeyRound className="mt-0.5 size-3.5 shrink-0" />
        {hint}
      </p>
    </div>
  );
}
