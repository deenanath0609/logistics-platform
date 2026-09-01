import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, can, PermissionError, type SessionUser } from "@/lib/auth/session";
import {
  assertWithinLimit,
  isPlanLimitError,
  type LimitKey,
} from "@/lib/plan-limits";
import { recordAudit, changedFields } from "./audit";

export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export const IDLE: ActionState = {};

// ────────────────────────────────────────────────────────────
// Form-value helpers
//
// FormData gives everything as strings, which breaks the obvious Zod
// spellings: `z.coerce.boolean()` turns "false" into `true`, and
// `z.coerce.number()` turns an empty input into 0 rather than null.
// ────────────────────────────────────────────────────────────

/** Checkbox or switch. Pair with a hidden "false" input so off still posts. */
export const zBool = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .transform((v) => v === true || v === "true");

/** Optional integer: a blank input becomes null, not zero. */
export function zOptionalInt(min?: number, max?: number) {
  let schema = z.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);

  return z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    schema.nullable(),
  );
}

/** Optional decimal, same blank handling. */
export function zOptionalDecimal(min?: number, max?: number) {
  let schema = z.number();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);

  return z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    schema.nullable(),
  );
}

/** Optional text: a blank input becomes null so the column stays clean. */
export function zOptionalText(max = 300) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );
}

/** Uppercase code — the identifier printed on documents. */
export function zCode(min = 2, max = 20) {
  return z
    .string()
    .trim()
    .min(min, `At least ${min} characters`)
    .max(max)
    .regex(/^[A-Z0-9_-]+$/i, "Letters, digits, hyphen and underscore only")
    .transform((v) => v.toUpperCase());
}

/** Prisma delegates share this shape; one narrow cast beats twelve. */
type Delegate = {
  create(args: unknown): Promise<Record<string, unknown>>;
  update(args: unknown): Promise<Record<string, unknown>>;
  findUnique(args: unknown): Promise<Record<string, unknown> | null>;
};

function delegate(model: string): Delegate {
  const client = prisma as unknown as Record<string, Delegate>;
  const found = client[model];
  if (!found) throw new Error(`Unknown Prisma model "${model}"`);
  return found;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export type MasterCrudOptions<S extends z.ZodObject<z.ZodRawShape>> = {
  /** Prisma delegate key, e.g. "serviceType". */
  model: string;
  /** Model name as it should read in the audit trail, e.g. "ServiceType". */
  entity: string;
  /** Field used as the human-readable reference in audit rows. */
  refField: string;
  /** Human label for messages, e.g. "Service type". */
  label: string;
  /**
   * The permission that lets somebody see this master at all.
   *
   * Declared here and, until now, never read: `create`, `update` and
   * `setActive` all authorised on `writePermission` alone, so this line
   * read like a guard and was decoration. It is now enforced alongside the
   * write — see `authorizeWrite`.
   */
  readPermission: string;
  writePermission: string;
  schema: S;
  /** Path to revalidate after a successful write. */
  path: string;
  /**
   * Extra data merged into every create. Receives the authorised actor so a
   * default can be derived from who is writing rather than looked up — see
   * `orgDefaults`.
   */
  createDefaults?: (user: SessionUser) => Promise<Record<string, unknown>>;
  /**
   * The plan cap this master counts against, for the few that are priced.
   *
   * Branches are the only one today. Most masters — charge heads, reason
   * codes, package types — are configuration rather than something sold by
   * the unit, so the option is absent and no plan is consulted at all.
   */
  planLimit?: LimitKey;
  /**
   * Refuses a deactivation, in words to show the operator.
   *
   * Some masters are load-bearing while something still points at them —
   * a vehicle class with lorries on it disappears from the rate-line
   * picker the moment it is switched off, so no payable rate can be
   * expressed for a class the fleet is still running. The screen disables
   * the button from the same fact; this is what makes the rule hold when
   * the button is bypassed. Return `null` to allow it.
   */
  blockDeactivate?: (id: string) => Promise<string | null>;
};

/**
 * The organisation a master row belongs to.
 *
 * `Organization` is one of the two globally-visible tables (ADR 001 §4), so
 * the tenant extension does not filter it and a `where`-less read of it
 * returns whichever tenant the planner reached first. The actor's own id is
 * the only defensible answer, and stating it explicitly rather than letting
 * the extension stamp it silently makes the extension's foreign-org check
 * assert that the signed-in user and the host's tenant are the same
 * organisation.
 */
export async function orgDefaults(
  user: SessionUser,
): Promise<Record<string, unknown>> {
  return { orgId: user.orgId };
}

/**
 * Builds the three server actions every master screen needs.
 *
 * Each one authorises, validates, writes, audits, and revalidates in that
 * order. Failures come back as state rather than exceptions so the form can
 * show them inline.
 */
export function createMasterCrud<S extends z.ZodObject<z.ZodRawShape>>(
  options: MasterCrudOptions<S>,
) {
  const table = () => delegate(options.model);

  /**
   * Both permissions, not just the write.
   *
   * Every shipped role that can write a master can also read it, so this
   * changes nothing for them — which is the point: `readPermission` was
   * declared on every one of these screens and consulted on none, and a
   * hand-built role granting `vehicle.create` without `vehicle.read` could
   * create and deactivate vehicle classes it was never allowed to see.
   * A field that reads like a guard has to be one or be deleted.
   */
  async function authorizeWrite(): Promise<SessionUser> {
    const user = await authorize(options.writePermission);
    if (!can(user, options.readPermission)) {
      throw new PermissionError(options.readPermission);
    }
    return user;
  }

  async function create(
    _prev: ActionState,
    formData: FormData,
  ): Promise<ActionState> {
    try {
      const user = await authorizeWrite();

      const parsed = options.schema.safeParse(
        Object.fromEntries(formData.entries()),
      );
      if (!parsed.success) {
        return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
      }

      // After validation, so a carrier at their cap is not told about it
      // while the form still has a blank required field to point at.
      if (options.planLimit) await assertWithinLimit(options.planLimit);

      const defaults = (await options.createDefaults?.(user)) ?? {};
      const created = await table().create({
        data: { ...defaults, ...parsed.data },
      });

      await recordAudit({
        user,
        action: "CREATE",
        entity: options.entity,
        entityId: String(created.id),
        entityRef: String(created[options.refField] ?? ""),
        after: created,
      });

      revalidatePath(options.path);
      return { ok: true, message: `${options.label} created.` };
    } catch (error) {
      return { error: describe(error, options.label) };
    }
  }

  async function update(
    _prev: ActionState,
    formData: FormData,
  ): Promise<ActionState> {
    try {
      const user = await authorizeWrite();

      const id = String(formData.get("id") ?? "");
      if (!id) return { error: "Nothing selected to update." };

      const parsed = options.schema.safeParse(
        Object.fromEntries(formData.entries()),
      );
      if (!parsed.success) {
        return { error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
      }

      const before = await table().findUnique({ where: { id } });
      if (!before) return { error: `That ${options.label.toLowerCase()} no longer exists.` };

      const after = await table().update({ where: { id }, data: parsed.data });
      const diff = changedFields(before, after);

      if (Object.keys(diff.after).length > 0) {
        await recordAudit({
          user,
          action: "UPDATE",
          entity: options.entity,
          entityId: id,
          entityRef: String(after[options.refField] ?? ""),
          before: diff.before,
          after: diff.after,
        });
      }

      revalidatePath(options.path);
      return { ok: true, message: `${options.label} updated.` };
    } catch (error) {
      return { error: describe(error, options.label) };
    }
  }

  /**
   * Masters are deactivated, never deleted — a retired charge head still has
   * to render on last year's invoices.
   */
  async function setActive(
    _prev: ActionState,
    formData: FormData,
  ): Promise<ActionState> {
    try {
      const user = await authorizeWrite();

      const id = String(formData.get("id") ?? "");
      const isActive = formData.get("isActive") === "true";
      if (!id) return { error: "Nothing selected." };

      const before = await table().findUnique({ where: { id } });
      if (!before) return { error: `That ${options.label.toLowerCase()} no longer exists.` };

      // Reactivating puts the row back into the count, so it is a creation
      // as far as a plan cap is concerned. Without this, a carrier at ten
      // branches could deactivate one, create a new one, and reactivate the
      // old one to sit at eleven.
      if (options.planLimit && isActive && before.isActive !== true) {
        await assertWithinLimit(options.planLimit);
      }

      if (!isActive && before.isActive === true && options.blockDeactivate) {
        const refusal = await options.blockDeactivate(id);
        if (refusal) return { error: refusal };
      }

      const after = await table().update({ where: { id }, data: { isActive } });

      await recordAudit({
        user,
        action: "UPDATE",
        entity: options.entity,
        entityId: id,
        entityRef: String(after[options.refField] ?? ""),
        before: { isActive: before.isActive },
        after: { isActive },
      });

      revalidatePath(options.path);
      return {
        ok: true,
        message: `${options.label} ${isActive ? "reactivated" : "deactivated"}.`,
      };
    } catch (error) {
      return { error: describe(error, options.label) };
    }
  }

  return { create, update, setActive };
}

function describe(error: unknown, label: string): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to change this.";
  }

  // Already a sentence written for a carrier, naming their plan and the
  // number — passing it through is the whole point of the typed error.
  if (isPlanLimitError(error)) return error.message;

  const message = error instanceof Error ? error.message : String(error);

  // Prisma unique-constraint violation.
  if (message.includes("Unique constraint")) {
    const match = message.match(/fields: \(`([^`]+)`\)/);
    return match
      ? `Another ${label.toLowerCase()} already uses that ${match[1]}.`
      : `Another ${label.toLowerCase()} already uses one of these values.`;
  }

  if (message.includes("Foreign key constraint")) {
    return "A referenced record is missing or has been removed.";
  }

  console.error(`[master-crud] ${label}`, error);
  return "Something went wrong saving that. The change was not applied.";
}
