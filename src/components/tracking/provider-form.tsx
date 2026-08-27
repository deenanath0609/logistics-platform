"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ProviderSummary } from "@/lib/tracking/queries";
import {
  rotateWebhookSecretAction,
  saveProviderAction,
  toggleProviderAction,
  type ProviderState,
} from "@/app/(ops)/tracking/providers/actions";
import { pollNowAction, type TrackingState } from "@/app/(ops)/tracking/actions";

const IDLE: ProviderState = {};
const IDLE_TRACKING: TrackingState = {};

/**
 * Provider configuration.
 *
 * The secret fields are write-only in both directions: the server never
 * sends a value down, and the form never renders one. What the screen shows
 * instead is whether a secret exists — which is the only thing an operator
 * needs to know and the only thing safe to say.
 */
export function ProviderDialog({
  provider,
  codes,
}: {
  provider?: ProviderSummary;
  codes: string[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"poll" | "webhook">(
    (provider?.mode as "poll" | "webhook") ?? "poll",
  );
  const [state, formAction, pending] = useActionState(saveProviderAction, IDLE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          provider ? (
            <Button variant="outline" size="sm">
              Edit
            </Button>
          ) : (
            <Button>
              <Plus />
              Add provider
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form action={formAction}>
          <input type="hidden" name="id" value={provider?.id ?? ""} />
          <input type="hidden" name="mode" value={mode} />

          <DialogHeader>
            <DialogTitle>
              {provider ? `Edit ${provider.code}` : "Configure a telematics provider"}
            </DialogTitle>
            <DialogDescription>
              The adapter is chosen by code. Everything downstream — dedupe,
              geofencing, ETA, alerts — is unchanged by which vendor is
              attached.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-code">Adapter code</Label>
                <select
                  id="provider-code"
                  name="code"
                  defaultValue={provider?.code ?? codes[0] ?? ""}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {codes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
                {state.fieldErrors?.code && (
                  <p className="text-xs text-destructive">{state.fieldErrors.code}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-interval">Poll every (seconds)</Label>
                <Input
                  id="provider-interval"
                  name="pollIntervalSeconds"
                  type="number"
                  min={10}
                  max={3600}
                  defaultValue={provider?.pollIntervalSeconds ?? 30}
                />
                {state.fieldErrors?.pollIntervalSeconds && (
                  <p className="text-xs text-destructive">
                    {state.fieldErrors.pollIntervalSeconds}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-name">Name</Label>
              <Input
                id="provider-name"
                name="name"
                defaultValue={provider?.name ?? ""}
                placeholder="Simulated fleet"
                required
              />
              {state.fieldErrors?.name && (
                <p className="text-xs text-destructive">{state.fieldErrors.name}</p>
              )}
            </div>

            <div className="flex gap-1.5">
              {(
                [
                  ["poll", "We pull", "We ask the vendor for positions on a timer"],
                  ["webhook", "They push", "The vendor posts signed batches to us"],
                ] as Array<["poll" | "webhook", string, string]>
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-left transition-colors",
                    value === mode ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                  )}
                >
                  <span className="block font-mono text-[0.65rem] uppercase tracking-[0.13em]">
                    {label}
                  </span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-url">Base URL</Label>
              <Input
                id="provider-url"
                name="baseUrl"
                defaultValue={provider?.baseUrl ?? ""}
                placeholder="https://api.vendor.example/v1"
              />
              {state.fieldErrors?.baseUrl && (
                <p className="text-xs text-destructive">{state.fieldErrors.baseUrl}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-key">API key</Label>
              <Input
                id="provider-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={provider?.hasApiKey ? "•••••••• — leave blank to keep" : "Not set"}
              />
              {state.fieldErrors?.apiKey && (
                <p className="text-xs text-destructive">{state.fieldErrors.apiKey}</p>
              )}
            </div>

            {mode === "webhook" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-secret">Webhook shared secret</Label>
                <Input
                  id="provider-secret"
                  name="webhookSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    provider?.hasWebhookSecret ? "•••••••• — leave blank to keep" : "At least 16 characters"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Deliveries are HMAC-SHA256 signed over the raw body. Without a
                  secret the endpoint would accept anything from anyone, so it
                  rejects everything instead.
                </p>
                {state.fieldErrors?.webhookSecret && (
                  <p className="text-xs text-destructive">{state.fieldErrors.webhookSecret}</p>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={provider?.isActive ?? true}
                className="size-4 accent-primary"
              />
              Active
            </label>

            {state.error && <p className="text-sm text-destructive">{state.error}</p>}
            {state.ok && <p className="text-sm text-ok">{state.message}</p>}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {provider ? "Save" : "Add provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ToggleProvider({ provider }: { provider: ProviderSummary }) {
  const [state, formAction, pending] = useActionState(toggleProviderAction, IDLE);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={provider.id} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {provider.isActive ? "Disable" : "Enable"}
      </Button>
      {state.error && <span className="ml-2 text-xs text-destructive">{state.error}</span>}
    </form>
  );
}

export function RotateSecret({ provider }: { provider: ProviderSummary }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(rotateWebhookSecretAction, IDLE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            Rotate secret
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={formAction}>
          <input type="hidden" name="id" value={provider.id} />
          <DialogHeader>
            <DialogTitle>Rotate the shared secret</DialogTitle>
            <DialogDescription>
              Deliveries signed with the old secret stop being accepted the
              moment this is saved. Have the new value ready to paste into{" "}
              {provider.name} before you do it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5 py-4">
            <Label htmlFor="rotate-secret">New shared secret</Label>
            <Input
              id="rotate-secret"
              name="webhookSecret"
              type="password"
              autoComplete="off"
              required
            />
            {state.error && <p className="text-sm text-destructive">{state.error}</p>}
            {state.ok && <p className="text-sm text-ok">{state.message}</p>}
          </div>

          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Rotate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pulls from the provider once, so a fitter can see a device report. */
export function PollNowButton() {
  const [state, formAction, pending] = useActionState(pollNowAction, IDLE_TRACKING);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Poll now
      </Button>
      {state.message && <span className="text-xs text-muted-foreground">{state.message}</span>}
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </form>
  );
}
