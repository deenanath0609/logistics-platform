import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { requirePermission } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { loadProviders } from "@/lib/tracking/queries";
import { knownProviderCodes } from "@/lib/tracking/providers";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PollNowButton,
  ProviderDialog,
  RotateSecret,
  ToggleProvider,
} from "@/components/tracking/provider-form";

export const metadata: Metadata = { title: "Tracking providers" };
export const dynamic = "force-dynamic";

/**
 * Telematics provider configuration.
 *
 * `geofence.manage` is the gate — the sensitive permission in the tracking
 * module. Whoever can repoint the fleet at a different endpoint decides what
 * the system believes about where its trucks are, which is a larger power
 * than "view live tracking" implies.
 *
 * No secret reaches this page. `loadProviders` reduces `apiKey` and
 * `webhookSecret` to booleans at the query, so there is no path by which a
 * value could be rendered, serialised into a prop, or read out of the HTML.
 */
export default async function TrackingProvidersPage() {
  const user = await requirePermission("geofence.manage");

  const [providers, env] = await Promise.all([loadProviders(user.orgId), getEnv()]);
  const codes = knownProviderCodes();
  const webhookUrl = `${env.APP_URL.replace(/\/$/, "")}/api/tracking/webhook`;

  return (
    <>
      <PageHeader
        eyebrow="Tracking"
        title="Telematics providers"
        description="Which vendor supplies positions, how we talk to it, and how a pushed batch is proved to have come from them."
        actions={
          <>
            <Button variant="outline" render={<Link href="/tracking" />}>
              Live map
            </Button>
            <Button variant="outline" render={<Link href="/tracking/geofences" />}>
              Geofences
            </Button>
            <ProviderDialog codes={codes} />
          </>
        }
      />

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border bg-card px-4 py-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Environment default
          </h2>
          <p className="mt-2 text-sm">
            <span className="font-mono">GPS_PROVIDER</span> ={" "}
            <span className="font-mono font-medium">{env.GPS_PROVIDER}</span>,
            polling every{" "}
            <span className="tabular">{env.GPS_POLL_INTERVAL_SECONDS}</span>{" "}
            seconds.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Adapters compiled in: {codes.join(", ")}. A code with no adapter
            behind it is refused at save rather than producing a configuration
            that looks healthy and polls nothing.
          </p>
          <div className="mt-3">
            <PollNowButton />
          </div>
        </section>

        <section className="rounded-lg border bg-card px-4 py-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Webhook endpoint
          </h2>
          <p className="mt-2 break-all font-mono text-xs">{webhookUrl}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Sign the raw request body with HMAC-SHA256 under the shared secret
            and send the hex digest as{" "}
            <span className="font-mono">X-CL-Signature</span> (
            <span className="font-mono">sha256=</span> and{" "}
            <span className="font-mono">v1=</span> prefixes and base64 digests
            are accepted). The sender is identified by which configured secret
            verifies, not by anything in the request, so a caller cannot claim
            an identity it cannot prove. Re-delivery is safe: a duplicate
            <span className="font-mono"> (device, timestamp)</span> pair is
            dropped and counted in the response.
          </p>
        </section>
      </div>

      <TableFrame>
        {providers.length === 0 ? (
          <EmptyState
            title="No provider configured"
            description={`Nothing is configured for this organisation, so polling falls back to the environment default (${env.GPS_PROVIDER}) with no stored credentials. Add a provider to attach a vendor.`}
            action={<ProviderDialog codes={codes} />}
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead>Last contact</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>
                    <span className="font-mono text-xs font-medium">{provider.code}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{provider.name}</span>
                  </TableCell>
                  <TableCell className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                    {provider.mode === "webhook" ? "they push" : `we pull · ${provider.pollIntervalSeconds}s`}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
                    {provider.baseUrl ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={provider.hasApiKey ? "text-ok" : "text-muted-foreground"}>
                      {provider.hasApiKey ? "API key set" : "no API key"}
                    </span>
                    <span className="mx-1.5 text-muted-foreground">·</span>
                    <span
                      className={
                        provider.hasWebhookSecret
                          ? "text-ok"
                          : provider.mode === "webhook"
                            ? "text-bad"
                            : "text-muted-foreground"
                      }
                    >
                      {provider.hasWebhookSecret ? "secret set" : "no secret"}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {provider.lastPolledAt
                      ? format(new Date(provider.lastPolledAt), "dd MMM HH:mm")
                      : "never"}
                    {provider.lastError && (
                      <span className="block max-w-[200px] truncate text-bad">
                        {provider.lastError}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                        provider.isActive ? "bg-ok-muted text-ok" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {provider.isActive ? "Active" : "Disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <ProviderDialog provider={provider} codes={codes} />
                    <ToggleProvider provider={provider} />
                    {provider.mode === "webhook" && <RotateSecret provider={provider} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        A provider row is not required to run. With none configured the pipeline
        uses the environment default and no stored credentials, which is exactly
        what the simulated fleet needs. Rows exist for the case that actually
        turns up in practice — one organisation on two telematics contracts
        after buying a competitor, with both fleets on one live map.
      </p>
    </>
  );
}
