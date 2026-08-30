import { platformDb, readingTenant } from "@/lib/platform/db";
import { recordPlatformAudit, requestMeta } from "@/lib/platform/audit";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import type { PlatformOperator } from "@/lib/platform/session";
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_SPECS,
  type CredentialKindCode,
} from "@/lib/platform/credential-specs";
import {
  resetCredentialCache,
  settingsFrom,
  contextFor,
} from "@/lib/integrations/credentials";
import {
  CredentialKeyError,
  credentialsKeyConfigured,
  encryptSecret,
} from "@/lib/integrations/secrets";
import type { Prisma } from "@/generated/prisma/client";

/**
 * A carrier's own accounts with the outside services, as the operator sees
 * and edits them.
 *
 * Two rules shape every function here.
 *
 * **A stored secret never travels back to the browser.** Not masked, not
 * partially, not "last four". The read below does not even select the
 * column, so there is no version of this page that can leak one by
 * forgetting to strip a field: what the screen gets is whether a secret
 * exists and when it was last replaced. Replacing one means typing a new
 * one, which is the same bargain as a password field and for the same
 * reason.
 *
 * **The trail records that the secret changed, never what it changed to.**
 * `recordPlatformAudit` redacts a key called `secret` on its way in, but
 * this module does not rely on that: it never puts the value in the payload
 * at all. Two mechanisms, independently sufficient, because an audit log
 * with a live gateway key in it is worse than no audit log — it is a
 * credential store nobody knows they are running, that a tenant's own
 * support ticket can end up quoting.
 *
 * ── Why the transactions name a tenant ───────────────────────
 *
 * `tenant_credential` is a tenant-owned table and carries a row-level
 * security policy keyed on `app.org_id`. The console's connection has no
 * tenant on its session — it runs on a host that resolves to none — so a
 * plain read here returns nothing under RLS. Naming the org inside the
 * transaction is the honest description of what this is: not a cross-tenant
 * read, but a read scoped to exactly one carrier the operator has named.
 */

export type CredentialSlot = {
  kind: CredentialKindCode;
  /** Whose account this carrier's traffic actually leaves on. */
  source: "tenant" | "platform" | "none";
  hasSecret: boolean;
  /** Non-secret configuration, ready to be form defaults. */
  settings: Record<string, string>;
  /** When the row last changed at all — settings included. */
  updatedAt: Date | null;
  /** The operator who last touched it, resolved from `updatedById`. */
  updatedBy: string | null;
  /** When the secret itself was last replaced, from the operator trail. */
  secretChangedAt: Date | null;
  /** Whether the platform's own account for this service is configured. */
  platformConfigured: boolean;
};

/** Rotating a secret writes this; a settings-only edit does not. */
const ROTATE_ACTION = "tenant.credential.rotate";
const UPDATE_ACTION = "tenant.credential.update";
const CLEAR_ACTION = "tenant.credential.clear";

/**
 * Whether the platform's shared account exists for a service.
 *
 * Read from `process.env` rather than `getEnv()` deliberately — see the
 * matching note in `lib/integrations/credentials.ts`. Only presence is read
 * here; the values never leave this function.
 */
function platformAccountConfigured(kind: CredentialKindCode): boolean {
  const value = {
    SMS: process.env.SMS_API_KEY,
    SMTP: process.env.SMTP_PASSWORD,
    WHATSAPP: process.env.WHATSAPP_API_KEY,
    GPS: process.env.GPS_API_KEY,
  }[kind];

  return Boolean(value?.trim());
}

// ────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────

/** Every slot, filled or not, so the screen shows what is missing. */
export async function listTenantCredentials(
  orgId: string,
): Promise<CredentialSlot[]> {
  const rows = await readingTenant(orgId, (tx) =>
    tx.tenantCredential.findMany({
      where: { orgId },
      // `secret` is deliberately absent. A column not selected is a column
      // that cannot be serialised into a React payload by accident.
      select: { kind: true, settings: true, updatedAt: true, updatedById: true },
    }),
  );

  // Whether each slot *has* a secret, without reading one. `not: null` is a
  // predicate the database answers; the ciphertext never leaves it.
  const withSecret = await readingTenant(orgId, (tx) =>
    tx.tenantCredential.findMany({
      where: { orgId, secret: { not: null } },
      select: { kind: true },
    }),
  );
  const filled = new Set(withSecret.map((row) => row.kind));

  const [rotations, admins] = await Promise.all([
    // The last rotation per slot, taken from the operator trail rather than
    // from a column: `updatedAt` moves when a port number is corrected, and
    // "when was this key last changed" is a different question with a
    // different answer during an incident.
    platformDb.platformAuditLog.findMany({
      where: {
        targetOrgId: orgId,
        action: ROTATE_ACTION,
        entity: "TenantCredential",
      },
      orderBy: { createdAt: "desc" },
      distinct: ["entityId"],
      select: { entityId: true, createdAt: true },
    }),
    platformDb.platformAdmin.findMany({
      where: {
        id: { in: rows.map((row) => row.updatedById).filter((id): id is string => Boolean(id)) },
      },
      select: { id: true, name: true },
    }),
  ]);

  const rotatedAt = new Map(rotations.map((row) => [row.entityId, row.createdAt]));
  const adminName = new Map(admins.map((admin) => [admin.id, admin.name]));
  const byKind = new Map(rows.map((row) => [row.kind, row]));

  return CREDENTIAL_KINDS.map((kind) => {
    const row = byKind.get(kind);
    const hasSecret = filled.has(kind);
    const platformConfigured = platformAccountConfigured(kind);

    return {
      kind,
      // Mirrors `credentialFor()` exactly: a slot without a secret is not an
      // account, however much configuration sits beside it, so the carrier
      // is still on ours.
      source: hasSecret ? "tenant" : platformConfigured ? "platform" : "none",
      hasSecret,
      settings: displaySettings(kind, row?.settings),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedById ? (adminName.get(row.updatedById) ?? null) : null,
      secretChangedAt: rotatedAt.get(kind) ?? null,
      platformConfigured,
    } satisfies CredentialSlot;
  });
}

/**
 * Stored settings as form defaults.
 *
 * Runs through the same normaliser the send path uses, so what an operator
 * sees on this screen is what a gateway call will actually be given — not
 * whatever JSON happens to be in the column.
 */
function displaySettings(
  kind: CredentialKindCode,
  raw: unknown,
): Record<string, string> {
  const parsed = settingsFrom(kind, raw) as Record<string, unknown>;

  return Object.fromEntries(
    CREDENTIAL_SPECS[kind].fields.map((field) => {
      const value = parsed[field.name];
      return [field.name, value === null || value === undefined ? "" : String(value)];
    }),
  );
}

// ────────────────────────────────────────────────────────────
// Write
// ────────────────────────────────────────────────────────────

export type CredentialInput = {
  /** Every field in the kind's spec, as typed. Empty string means "not set". */
  settings: Record<string, string>;
  /** A new secret, or null to leave whatever is stored untouched. */
  secret: string | null;
};

export async function saveTenantCredential(
  orgId: string,
  kind: CredentialKindCode,
  input: CredentialInput,
  actor: PlatformOperator,
): Promise<PlatformResult<{ rotated: boolean }>> {
  const org = await platformDb.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return fail("That tenant no longer exists.");

  const spec = CREDENTIAL_SPECS[kind];
  // Built as a plain object and handed to Prisma as JSON at the write.
  // `Prisma.InputJsonObject` is read-only by construction, which is correct
  // for a value being passed in and useless for one being assembled.
  const settings: Record<string, string | number> = {};

  for (const field of spec.fields) {
    const raw = input.settings[field.name]?.trim() ?? "";
    if (!raw) continue;

    if (field.type === "number") {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return fail(`${field.label} must be a port number between 1 and 65535.`);
      }
      settings[field.name] = parsed;
      continue;
    }

    settings[field.name] = raw;
  }

  const rotating = Boolean(input.secret?.trim());

  // Checked before anything is written, so a missing key cannot leave the
  // settings saved and the secret silently not.
  if (rotating && !credentialsKeyConfigured()) {
    return fail(
      "CREDENTIALS_KEY is not set on this server, so a secret cannot be " +
        "stored. Set it and try again — the settings above were not saved " +
        "either, so nothing is half-applied.",
    );
  }

  let ciphertext: string | null = null;
  if (rotating) {
    try {
      ciphertext = encryptSecret(input.secret!.trim(), contextFor(orgId, kind));
    } catch (error) {
      if (error instanceof CredentialKeyError) return fail(error.message);
      throw error;
    }
  }

  const existing = await readingTenant(orgId, (tx) =>
    tx.tenantCredential.findFirst({
      where: { orgId, kind },
      select: { settings: true },
    }),
  );

  const before = displaySettings(kind, existing?.settings);
  const after = displaySettings(kind, settings);
  const settingsMoved = JSON.stringify(before) !== JSON.stringify(after);

  if (!settingsMoved && !rotating) {
    return ok({ rotated: false });
  }

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;

    await tx.tenantCredential.upsert({
      where: { orgId_kind: { orgId, kind } },
      create: {
        orgId,
        kind,
        settings: settings as Prisma.InputJsonObject,
        secret: ciphertext,
        updatedById: actor.id,
      },
      update: {
        settings: settings as Prisma.InputJsonObject,
        // Omitted rather than set to null when no new secret was typed:
        // saving a corrected port number must not silently revoke the
        // carrier's key and move them back onto our account.
        ...(ciphertext ? { secret: ciphertext } : {}),
        updatedById: actor.id,
      },
    });

    await recordPlatformAudit(
      {
        action: rotating ? ROTATE_ACTION : UPDATE_ACTION,
        actor,
        org,
        entity: "TenantCredential",
        // The slot, not the row id. A cleared credential is deleted and a
        // later one gets a new id, and "what has been done to this
        // carrier's SMS account" has to survive that.
        entityId: kind,
        before: { settings: before },
        // `secretChanged` is a boolean and stays one. The value is not here,
        // not redacted here — it was never put in.
        after: { settings: after, secretChanged: rotating },
        ...meta,
      },
      tx,
    );
  });

  // The send path holds a decrypted copy for thirty seconds. This process is
  // rarely the one that sends — the console and the outbox drain are
  // different processes in production, and there the TTL is the only thing
  // that closes the window — but a key rotated because it leaked should stop
  // being used everywhere it can be stopped immediately.
  resetCredentialCache();

  return ok({ rotated: rotating });
}

/**
 * Removes a carrier's own account for one service.
 *
 * The row is deleted rather than blanked. A row with no secret and no
 * settings is indistinguishable in behaviour from no row, and keeping one
 * would leave the screen showing a slot that looks configured.
 */
export async function clearTenantCredential(
  orgId: string,
  kind: CredentialKindCode,
  actor: PlatformOperator,
): Promise<PlatformResult<null>> {
  const org = await platformDb.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return fail("That tenant no longer exists.");

  const existing = await readingTenant(orgId, (tx) =>
    tx.tenantCredential.findFirst({
      where: { orgId, kind },
      select: { settings: true, secret: true },
    }),
  );
  if (!existing) return fail(`${org.slug} has no ${kind} credential to clear.`);

  const meta = await requestMeta();

  await platformDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;

    await tx.tenantCredential.deleteMany({ where: { orgId, kind } });

    await recordPlatformAudit(
      {
        action: CLEAR_ACTION,
        actor,
        org,
        entity: "TenantCredential",
        entityId: kind,
        // What was there, minus the one thing that must never be written:
        // whether a secret existed, not the secret.
        before: {
          settings: displaySettings(kind, existing.settings),
          secretChanged: Boolean(existing.secret),
        },
        after: null,
        reason: `Falls back to the platform's shared ${kind} account.`,
        ...meta,
      },
      tx,
    );
  });

  resetCredentialCache();

  return ok(null);
}
