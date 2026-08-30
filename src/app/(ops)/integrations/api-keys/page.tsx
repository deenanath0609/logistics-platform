import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_KEY_SCOPES } from "../scopes";
import { IssueKeyForm } from "./issue-key-form";
import { RevokeButton } from "./revoke-button";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

function stateOf(key: {
  revokedAt: Date | null;
  expiresAt: Date | null;
}): { label: string; tone: string } {
  if (key.revokedAt) return { label: "Revoked", tone: "bg-bad-muted text-bad" };
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    return { label: "Expired", tone: "bg-warn-muted text-warn" };
  }
  return { label: "Live", tone: "bg-ok-muted text-ok" };
}

export default async function ApiKeysPage() {
  const actor = await requirePermission("apikey.manage");

  // Only what this person could do themselves. A key is issued as its
  // owner and narrowed to their permissions on every request, so offering
  // a scope they do not hold would offer a checkbox that mints a key which
  // is refused the first time it is used.
  const offeredScopes = API_KEY_SCOPES.filter((scope) =>
    actor.permissions.has(scope.code),
  );

  const [keys, customers] = await Promise.all([
    prisma.apiKey.findMany({
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      // `keyHash` is deliberately not selected. Nothing on this screen
      // needs it, and a value not fetched cannot be rendered by accident.
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        ipAllowlist: true,
        customerId: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
    prisma.customer.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { name: "asc" },
      take: 500,
      select: { id: true, code: true, name: true },
    }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));

  return (
    <>
      <Link
        href="/integrations"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Integrations
      </Link>

      <PageHeader
        eyebrow="Integrations"
        title="API keys"
        description="Keys authenticate partner systems against /api/v1. Only the SHA-256 digest is stored — the key itself is shown once, at creation, and cannot be recovered afterwards."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            Issue a key
          </h2>
          <IssueKeyForm
            scopes={offeredScopes.map((scope) => ({ ...scope }))}
            customers={customers.map((customer) => ({
              id: customer.id,
              label: `${customer.code} — ${customer.name}`,
            }))}
          />
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            Issued keys
          </h2>

          {keys.length === 0 ? (
            <TableFrame>
              <EmptyState
                title="No keys issued"
                description="A partner integration needs a key with the scopes it actually uses, and nothing more."
              />
            </TableFrame>
          ) : (
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Prefix</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Addresses</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => {
                    const state = stateOf(key);
                    const customer = key.customerId
                      ? customerById.get(key.customerId)
                      : null;

                    return (
                      <TableRow key={key.id}>
                        <TableCell className="font-medium">
                          {key.name}
                          <span className="block text-xs text-muted-foreground">
                            issued {format(key.createdAt, "dd MMM yyyy")}
                            {key.expiresAt
                              ? ` · expires ${format(key.expiresAt, "dd MMM yyyy")}`
                              : ""}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {key.keyPrefix}…
                        </TableCell>
                        <TableCell className="max-w-[16rem] whitespace-normal">
                          <span className="flex flex-wrap gap-1">
                            {key.scopes.map((scope) => (
                              <span
                                key={scope}
                                className="rounded-full bg-muted px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground"
                              >
                                {scope}
                              </span>
                            ))}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {customer ? customer.name : "Network-wide"}
                        </TableCell>
                        <TableCell className="font-mono text-[0.7rem] text-muted-foreground">
                          {key.ipAllowlist.length === 0
                            ? "anywhere"
                            : key.ipAllowlist.join(", ")}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {key.lastUsedAt
                            ? format(key.lastUsedAt, "dd MMM, HH:mm")
                            : "never"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${state.tone}`}
                          >
                            {state.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {!key.revokedAt && (
                            <RevokeButton
                              keyId={key.id}
                              keyName={key.name}
                              keyPrefix={key.keyPrefix}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableFrame>
          )}
        </div>
      </div>
    </>
  );
}
