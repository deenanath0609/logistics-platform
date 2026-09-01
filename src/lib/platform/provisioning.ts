import { platformDb, readingTenant } from "@/lib/platform/db";
import {
  recordPlatformAudit,
  requestMeta,
  type PlatformAuditActor,
} from "@/lib/platform/audit";
import { ONBOARDING_TASKS } from "@/lib/platform/onboarding";
import { fail, ok, type PlatformResult } from "@/lib/platform/result";
import { bustTenantCache } from "@/lib/tenant";
import { isValidSubdomain, RESERVED_SUBDOMAINS } from "@/lib/tenant/host";
import { resetCarrierCache } from "@/lib/notifications/carrier";
import { generateTemporaryPassword, hashPassword } from "@/lib/portal/passwords";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Creating a carrier.
 *
 * ADR 001 §4 says onboarding **copies a template dataset** into the new
 * tenant, and that is exactly what this does — it does not re-run the
 * seed. The seed builds its own Prisma client with no tenant extension,
 * deliberately, because it is what creates the organisations in the first
 * place; importing `prisma/seed/**` from `src/` would drag that second
 * client into the server bundle. So the console copies masters out of an
 * existing carrier using `platformDb`, and `scripts/provision-tenant.ts`
 * is now a thin CLI over this same function.
 *
 * What gets copied is the shape of a carrier's world — geography, masters,
 * roles, templates, SLA ladders. What does not is anything operational or
 * commercial: branches, routes, customers, users, vehicles, drivers, rate
 * cards and every transactional table. Rate cards are a *blocking*
 * onboarding task precisely because they are the new carrier's own
 * commercial terms, and a copied one would be somebody else's prices
 * quietly billed to somebody else's customer.
 */

// ────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────

export type ProvisionBranchInput = {
  code: string;
  name: string;
  /** City *name*, resolved against the template's geography before the copy. */
  city: string;
  address: string;
  pincode: string;
  phone: string | null;
};

export type ProvisionOwnerInput = {
  name: string;
  mobile: string;
  email: string | null;
  /**
   * A password chosen by the caller instead of generated here.
   *
   * Only the command-line provisioner passes this, and only for building a
   * carrier a script has to sign into afterwards — a CI run, a fixture, a
   * demonstration. It is not offered in the operator console, where a
   * generated secret shown once is the right behaviour.
   *
   * A password the caller chose was never handed out by us, so the forced
   * change on first sign-in does not apply to it: the flag exists to make
   * somebody replace a secret that travelled to them in the clear, and
   * there is nobody here for it to have travelled to.
   */
  password?: string | null;
};

export type ProvisionInput = {
  name: string;
  legalName: string | null;
  slug: string;
  subdomain: string;
  lrPrefix: string;
  planId: string | null;
  /** The carrier whose masters are copied. */
  templateOrgId: string;
  branch: ProvisionBranchInput;
  owner: ProvisionOwnerInput;
};

/** Row counts, one key per copied table. Written to the audit row. */
export type ProvisionCounts = Record<string, number>;

export type ProvisionedTenant = {
  orgId: string;
  name: string;
  slug: string;
  subdomain: string;
  ownerUserId: string;
  /**
   * Returned once, to be shown once. Never persisted anywhere but the
   * bcrypt hash on the user row — in particular not in the audit trail,
   * which `sanitise()` would not catch because this is not a field named
   * "password" on a model.
   */
  ownerPassword: string;
  copied: ProvisionCounts;
};

// ────────────────────────────────────────────────────────────
// Validation — pure, so it can be tested without a database
// ────────────────────────────────────────────────────────────

/**
 * Which role the first owner gets, in order of preference.
 *
 * The template names its own roles, so this is a search rather than a
 * constant: the first of these that the template actually has wins. A
 * template with none of them cannot produce a usable owner, and that is a
 * refusal rather than a user with no permissions at all.
 */
export const OWNER_ROLE_CODES = ["SUPER_ADMIN", "OWNER", "ADMIN", "MANAGEMENT"];

/** Digits only, so a mobile typed as "+91 98000 00001" still validates. */
export function normaliseMobile(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Everything that can be judged without asking the database.
 *
 * Split out from `provisionTenant` so the rules are testable on their own
 * and so the form gets the same answer the service would give. Returns the
 * first problem in the order an operator would want to hear about it, or
 * null when the shape is fine.
 */
export function validateProvisionShape(input: ProvisionInput): string | null {
  if (!input.name.trim()) return "The carrier needs a name.";

  for (const [label, value] of [
    ["Slug", input.slug],
    ["Subdomain", input.subdomain],
  ] as const) {
    const lower = value.trim().toLowerCase();
    if (RESERVED_SUBDOMAINS.has(lower)) {
      return `"${lower}" is reserved for the platform itself and can never name a carrier.`;
    }
    // The slug is held to the subdomain's rules as well. It is not routed
    // on today, but it is the stable public identifier of the tenant and a
    // slug that could not become a hostname is a trap waiting for the day
    // somebody wants one.
    if (!isValidSubdomain(lower)) {
      return `${label} must be 3–63 characters of lower-case letters, digits and hyphens, not starting or ending with a hyphen.`;
    }
  }

  if (!/^[A-Za-z]{2,4}$/.test(input.lrPrefix.trim())) {
    return "The LR prefix is 2–4 letters — it is printed on every consignment note.";
  }

  if (!input.templateOrgId) {
    return "Pick the carrier whose masters should be copied.";
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/.test(input.branch.code.trim())) {
    return "The head-office branch code is 2–20 letters, digits and hyphens.";
  }
  if (!input.branch.name.trim()) return "The head office needs a name.";
  if (!input.branch.city.trim()) return "Which city is the head office in?";
  if (!input.branch.address.trim()) return "The head office needs an address — it is printed on documents.";
  if (!/^\d{6}$/.test(input.branch.pincode.trim())) {
    return "The head-office PIN code is six digits.";
  }

  if (!input.owner.name.trim()) return "The first owner needs a name.";
  const mobile = normaliseMobile(input.owner.mobile);
  if (mobile.length < 10 || mobile.length > 15) {
    return "The first owner's mobile is how they sign in — give 10 to 15 digits.";
  }
  if (input.owner.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.owner.email.trim())) {
    return "That does not look like an email address.";
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// Copy rules — also pure, and also the part most worth testing
// ────────────────────────────────────────────────────────────

type TemplatePincode = {
  code: string;
  cityId: string;
  areaName: string | null;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
  isServiceable: boolean;
  isOda: boolean;
  /**
   * Present on the template row and deliberately dropped. Typed here so
   * the copy rule can be tested with a realistic input.
   */
  servingBranchId?: string | null;
};

/**
 * A pincode belongs to the new tenant; the branch that serves it does not.
 *
 * `servingBranchId` points at one of the *template's* branches, and the
 * template's branch network is not copied. Carrying it over would either
 * fail the foreign key or — worse, if it ever resolved — route the new
 * carrier's deliveries to another company's hub.
 */
export function copiedPincode(
  row: TemplatePincode,
  orgId: string,
  cityId: string,
): Prisma.PincodeCreateManyInput {
  return {
    orgId,
    code: row.code,
    cityId,
    areaName: row.areaName,
    latitude: row.latitude,
    longitude: row.longitude,
    isServiceable: row.isServiceable,
    isOda: row.isOda,
    servingBranchId: null,
  };
}

type TemplateNumberSeries = {
  document: Prisma.NumberSeriesCreateManyInput["document"];
  pattern: string;
  prefix: string | null;
  padding: number;
  resetPolicy: Prisma.NumberSeriesCreateManyInput["resetPolicy"];
  currentValue?: number;
  periodKey?: string | null;
  isActive?: boolean;
};

/**
 * A number series is copied as a *shape*, never as a position.
 *
 * Copying `currentValue` would start the new carrier's LR numbering at
 * wherever the template happens to have reached, which means the first
 * consignment note it prints carries a number the template already printed
 * — on a document a customer keeps and a court would read. The counter
 * resets to zero and the period key clears with it, because a stale key
 * makes the first `nextNumber()` believe it is resuming a period rather
 * than starting one.
 *
 * The LR prefix is the new carrier's own for the same reason: the letters
 * on a consignment note are the company's identity, not the template's.
 */
export function copiedNumberSeries(
  row: TemplateNumberSeries,
  orgId: string,
  lrPrefix: string,
): Prisma.NumberSeriesCreateManyInput {
  return {
    orgId,
    document: row.document,
    // Network-wide only. A branch-scoped series names a branch of the
    // template's, and the new tenant has exactly one branch of its own.
    branchId: null,
    pattern: row.pattern,
    prefix: row.document === "LR" ? lrPrefix : row.prefix,
    padding: row.padding,
    resetPolicy: row.resetPolicy,
    currentValue: 0,
    periodKey: null,
    isActive: row.isActive ?? true,
  };
}

type TemplateNotificationTemplate = {
  code: string;
  channel: Prisma.NotificationTemplateCreateManyInput["channel"];
  eventType: string;
  name: string;
  language: string;
  subject: string | null;
  body: string;
  variables: string[];
  recipientKind: Prisma.NotificationTemplateCreateManyInput["recipientKind"];
  dltTemplateId?: string | null;
  dltSenderId?: string | null;
  isActive?: boolean;
};

/**
 * Templates copy; DLT registrations do not.
 *
 * A DLT sender header and template id are registered to one company with
 * the Indian telecom regulator and take one to three weeks to approve. An
 * inherited id is rejected at the gateway — and a gateway rejection looks
 * identical to a successful queue from inside the app, so the failure mode
 * is silent: nobody notices until a consignee says the delivery OTP never
 * arrived.
 *
 * So the ids are cleared, and every SMS template is copied **inactive**.
 * The carrier's own registration is a blocking onboarding task; switching
 * the templates on is the visible act of finishing it. Email and in-app
 * templates are unaffected — they have no such registration.
 */
export function copiedNotificationTemplate(
  row: TemplateNotificationTemplate,
  orgId: string,
): Prisma.NotificationTemplateCreateManyInput {
  return {
    orgId,
    code: row.code,
    channel: row.channel,
    eventType: row.eventType,
    name: row.name,
    language: row.language,
    subject: row.subject,
    body: row.body,
    variables: row.variables,
    recipientKind: row.recipientKind,
    dltTemplateId: null,
    dltSenderId: null,
    isActive: row.channel === "SMS" ? false : (row.isActive ?? true),
  };
}

// ────────────────────────────────────────────────────────────
// The service
// ────────────────────────────────────────────────────────────

/**
 * How many rows go in one `createMany`.
 *
 * The pincode master is the only table here that is genuinely large — the
 * full Indian list is roughly 19,000 rows — and one statement with 19,000
 * tuples is a parameter count Postgres will refuse long before it is a
 * performance question. Chunking keeps each statement ordinary; the
 * transaction still wraps all of them.
 */
const COPY_CHUNK = 1_000;

function chunked<T>(rows: T[], size = COPY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Copying takes longer than a default interactive transaction allows.
 *
 * Prisma's default is five seconds, which the geography copy alone will
 * exceed on a real pincode master. Two minutes is generous rather than
 * optimistic: provisioning happens a handful of times a year and a
 * half-built tenant is much more expensive than a slow one.
 */
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 180_000 };

/**
 * Everything the copy reads out of the template, in one place.
 *
 * Sequential rather than `Promise.all`. An interactive transaction is one
 * connection, and the session variable set immediately above these reads
 * is what makes row-level security show them at all — issuing seventeen
 * queries at once onto a single connection through the driver adapter is
 * not a place to be clever about latency on an operation that runs a
 * handful of times a year.
 */
async function readTemplate(tx: Prisma.TransactionClient, orgId: string) {
  return {
    states: await tx.state.findMany({ where: { orgId } }),
    cities: await tx.city.findMany({ where: { orgId } }),
    pincodes: await tx.pincode.findMany({ where: { orgId } }),
    zones: await tx.zone.findMany({ where: { orgId } }),
    zonePincodes: await tx.zonePincode.findMany({ where: { orgId } }),
    serviceTypes: await tx.serviceType.findMany({ where: { orgId } }),
    packageTypes: await tx.packageType.findMany({ where: { orgId } }),
    taxRates: await tx.taxRate.findMany({ where: { orgId } }),
    chargeTypes: await tx.chargeType.findMany({ where: { orgId } }),
    reasonCodes: await tx.reasonCode.findMany({ where: { orgId } }),
    vehicleTypes: await tx.vehicleType.findMany({ where: { orgId } }),
    // Branch-scoped series are skipped at the source: see `copiedNumberSeries`.
    numberSeries: await tx.numberSeries.findMany({ where: { orgId, branchId: null } }),
    roles: await tx.role.findMany({ where: { orgId } }),
    rolePermissions: await tx.rolePermission.findMany({ where: { orgId } }),
    notificationTemplates: await tx.notificationTemplate.findMany({ where: { orgId } }),
    slaPolicies: await tx.slaPolicy.findMany({ where: { orgId } }),
    escalationRules: await tx.escalationRule.findMany({ where: { orgId } }),
  };
}

type Template = Awaited<ReturnType<typeof readTemplate>>;

/**
 * Refusals raised from inside the transaction.
 *
 * A few checks can only be made once the copy has happened — "is the head
 * office's city actually in the geography we just copied?" — and the right
 * answer to those is to roll the whole thing back and hand the operator a
 * sentence, not to leave a tenant half-built. Throwing is how a Prisma
 * interactive transaction rolls back; this type is how the throw is told
 * apart from a genuine fault on the way out.
 */
class ProvisionRefusal extends Error {}

/**
 * Old id → new id, built by reading the rows back after they are written.
 *
 * The alternative — generating ids in application code so the map is known
 * up front — means reimplementing cuid and owning its collision properties
 * forever. Every table copied here has a natural key (`orgId` + `code`),
 * so a read-back keyed on that code is both cheaper to reason about and
 * impossible to get subtly wrong.
 */
function idsByCode(rows: Array<{ id: string; code: string }>): Map<string, string> {
  return new Map(rows.map((row) => [row.code, row.id]));
}

export async function provisionTenant(
  input: ProvisionInput,
  actor: PlatformAuditActor,
): Promise<PlatformResult<ProvisionedTenant>> {
  const shapeProblem = validateProvisionShape(input);
  if (shapeProblem) return fail(shapeProblem);

  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const subdomain = input.subdomain.trim().toLowerCase();
  const lrPrefix = input.lrPrefix.trim().toUpperCase();
  const mobile = normaliseMobile(input.owner.mobile);

  /*
    Case-insensitively: the columns are case-sensitive but hostnames are
    not, so "Acme" and "acme" are the same carrier to everyone except the
    unique index.

    Any clash is a refusal, including one against a tenant still in
    PROVISIONING. The old script resumed those, because its seed-based path
    could fail halfway and leave a half-built tenant nobody could retry.
    Everything below commits or rolls back together, so that state is no
    longer reachable and "resume" would only mean "silently write into a
    carrier somebody else is already creating".
  */
  const clash = await platformDb.organization.findFirst({
    where: {
      OR: [
        { slug: { equals: slug, mode: "insensitive" } },
        { subdomain: { equals: subdomain, mode: "insensitive" } },
      ],
    },
    select: { name: true, slug: true, subdomain: true },
  });
  if (clash) {
    return fail(
      clash.slug.toLowerCase() === slug
        ? `${clash.name} already uses the slug "${slug}".`
        : `${clash.name} is already on the subdomain "${subdomain}".`,
    );
  }

  const template = await platformDb.organization.findUnique({
    where: { id: input.templateOrgId },
    select: { id: true, name: true, slug: true },
  });
  if (!template) return fail("That template carrier no longer exists.");

  if (input.planId) {
    const plan = await platformDb.tenantPlan.findUnique({
      where: { id: input.planId },
      select: { id: true },
    });
    if (!plan) return fail("That plan no longer exists.");
  }

  const meta = await requestMeta();
  const chosenPassword = input.owner.password?.trim() || null;
  const ownerPassword = chosenPassword ?? generateTemporaryPassword();
  const ownerPasswordHash = await hashPassword(ownerPassword);

  try {
    const created = await platformDb.$transaction(async (tx) => {
      // ── Phase 1: read the template, with RLS pointed at it ──────────
      //
      // `platformDb` is unextended, so row-level security is the only
      // thing standing between this and every tenant's rows — and with no
      // `app.org_id` set it fails closed and returns nothing at all. The
      // setting is transaction-local, so a pooled connection cannot carry
      // it into the next request.
      await tx.$executeRaw`SELECT set_config('app.org_id', ${template.id}, TRUE)`;
      const source = await readTemplate(tx, template.id);

      const ownerRole = OWNER_ROLE_CODES.map((code) =>
        source.roles.find((role) => role.code === code),
      ).find(Boolean);
      if (!ownerRole) {
        throw new ProvisionRefusal(
          `${template.name} has none of the roles ${OWNER_ROLE_CODES.join(", ")}, so there is nothing to make the first owner.`,
        );
      }

      // Resolve the head office's city against the *template's* geography,
      // because that is what will be copied. PIN first — it is the more
      // precise answer and the operator has already typed it — then the
      // city name, which is what they would expect to work.
      const templatePin = source.pincodes.find(
        (row) => row.code === input.branch.pincode.trim(),
      );
      const cityCode = templatePin
        ? source.cities.find((city) => city.id === templatePin.cityId)?.code
        : source.cities.find(
            (city) =>
              city.name.toLowerCase() === input.branch.city.trim().toLowerCase(),
          )?.code;
      if (!cityCode) {
        throw new ProvisionRefusal(
          `Neither PIN ${input.branch.pincode.trim()} nor a city called "${input.branch.city.trim()}" is in ${template.name}'s geography. Pick a template that covers the head office.`,
        );
      }

      // ── Phase 2: the organisation itself ────────────────────────────
      //
      // `organization` is one of the tables that stays global (ADR 001
      // amendment) — it is the tenant list — so it carries no `orgId` and
      // no policy, and can be written before the session is pointed at
      // the new tenant.
      //
      // PROVISIONING, not ACTIVE: the tenant exists and can be worked on,
      // and nothing about it has been handed over.
      const org = await tx.organization.create({
        data: {
          name,
          legalName: input.legalName?.trim() || name,
          slug,
          subdomain,
          lrPrefix,
          planId: input.planId,
          status: "PROVISIONING",
          currency: "INR",
          timezone: "Asia/Kolkata",
        },
        select: { id: true, name: true, slug: true, subdomain: true },
      });

      // ── Phase 3: everything else, written as the new tenant ─────────
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org.id}, TRUE)`;

      const copied = await copyInto(tx, org.id, lrPrefix, source);

      // The head-office branch is the carrier's own, built from the form.
      // The template's branch network is deliberately not copied: a Delhi
      // hub belonging to somebody else is worse than no hub at all,
      // because it looks like configuration rather than a mistake.
      const cities = await tx.city.findMany({
        where: { orgId: org.id },
        select: { id: true, code: true },
      });
      const cityId = idsByCode(cities).get(cityCode);
      if (!cityId) {
        throw new ProvisionRefusal(
          "The head office's city did not survive the geography copy. Nothing was created.",
        );
      }

      const branch = await tx.branch.create({
        data: {
          orgId: org.id,
          code: input.branch.code.trim().toUpperCase(),
          name: input.branch.name.trim(),
          type: "HEAD_OFFICE",
          cityId,
          address: input.branch.address.trim(),
          pincode: input.branch.pincode.trim(),
          phone: input.branch.phone?.trim() || null,
        },
        select: { id: true },
      });
      copied.Branch = 1;

      // The first owner. `mustChangePassword` is what makes the generated
      // password below single-use by construction — it cannot survive the
      // first session, which is the same rule the platform's own first
      // admin is held to.
      const roles = await tx.role.findMany({
        where: { orgId: org.id },
        select: { id: true, code: true },
      });
      const ownerRoleId = idsByCode(roles).get(ownerRole.code);
      if (!ownerRoleId) {
        throw new ProvisionRefusal(
          "The owner role did not survive the role copy. Nothing was created.",
        );
      }

      const owner = await tx.user.create({
        data: {
          orgId: org.id,
          name: input.owner.name.trim(),
          mobile,
          email: input.owner.email?.trim() || null,
          passwordHash: ownerPasswordHash,
          primaryBranchId: branch.id,
          // See `ProvisionOwnerInput.password`: a generated secret has been
          // read by whoever ran this and must be replaced; one the caller
          // chose has not travelled anywhere.
          mustChangePassword: chosenPassword === null,
        },
        select: { id: true },
      });
      await tx.userRole.create({
        data: { orgId: org.id, userId: owner.id, roleId: ownerRoleId },
      });
      copied.User = 1;

      // `tenant_onboarding_task` is operator-owned and excluded from RLS
      // (scripts/apply-rls.mjs), so it is written outside the tenant's own
      // policy — which is right: the checklist is the operator's view of
      // the handover, not the carrier's data.
      await tx.tenantOnboardingTask.createMany({
        data: ONBOARDING_TASKS.map((task, index) => ({
          orgId: org.id,
          key: task.key,
          label: task.label,
          isBlocking: task.isBlocking,
          sortOrder: index,
        })),
        skipDuplicates: true,
      });

      // The audit row commits with the tenant or not at all. A carrier
      // appearing on the platform with no trail of who put it there is not
      // a state this table can reach.
      await recordPlatformAudit(
        {
          action: "tenant.provision",
          actor,
          org: { id: org.id, slug: org.slug },
          entity: "Organization",
          entityId: org.id,
          after: {
            name: org.name,
            slug: org.slug,
            subdomain: org.subdomain,
            lrPrefix,
            status: "PROVISIONING",
            templateOrgId: template.id,
            templateSlug: template.slug,
            headOfficeBranch: input.branch.code.trim().toUpperCase(),
            ownerMobile: mobile,
            ownerRole: ownerRole.code,
            copied,
          },
          ...meta,
        },
        tx,
      );

      return { org, ownerUserId: owner.id, copied };
    }, TRANSACTION_OPTIONS);

    // The host cache memoises host → organisation for thirty seconds, so
    // without this the brand-new subdomain resolves to nothing for up to
    // half a minute — which reads exactly like a provisioning failure to
    // the operator who immediately clicks the link.
    bustTenantCache();
    // And the notification layer keeps its own copy of each carrier, which
    // is what public tracking links are built on.
    resetCarrierCache();

    return ok({
      orgId: created.org.id,
      name: created.org.name,
      slug: created.org.slug,
      subdomain: created.org.subdomain,
      ownerUserId: created.ownerUserId,
      ownerPassword,
      copied: created.copied,
    });
  } catch (error) {
    if (error instanceof ProvisionRefusal) return fail(error.message);
    throw error;
  }
}

/**
 * The copy itself, in dependency order.
 *
 * Each step writes with `createMany` and then reads the rows back to build
 * the old-id → new-id map the next step needs. Nothing here invents an id.
 */
async function copyInto(
  tx: Prisma.TransactionClient,
  orgId: string,
  lrPrefix: string,
  source: Template,
): Promise<ProvisionCounts> {
  const counts: ProvisionCounts = {};

  // ── Geography ───────────────────────────────────────────────────────
  await tx.state.createMany({
    data: source.states.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      gstCode: row.gstCode,
      isActive: row.isActive,
    })),
  });
  const stateIds = idsByCode(
    await tx.state.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const stateCodeByOldId = new Map(source.states.map((row) => [row.id, row.code]));
  counts.State = source.states.length;

  await tx.city.createMany({
    data: source.cities.map((row) => ({
      orgId,
      stateId: stateIds.get(stateCodeByOldId.get(row.stateId) ?? "")!,
      name: row.name,
      code: row.code,
      latitude: row.latitude,
      longitude: row.longitude,
      isMetro: row.isMetro,
      isActive: row.isActive,
    })),
  });
  const cityIds = idsByCode(
    await tx.city.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const cityCodeByOldId = new Map(source.cities.map((row) => [row.id, row.code]));
  counts.City = source.cities.length;

  // The one genuinely large table. Batched so no single statement carries
  // 19,000 tuples; still inside the one transaction.
  for (const batch of chunked(source.pincodes)) {
    await tx.pincode.createMany({
      data: batch.map((row) =>
        copiedPincode(row, orgId, cityIds.get(cityCodeByOldId.get(row.cityId) ?? "")!),
      ),
    });
  }
  const pincodeIds = idsByCode(
    await tx.pincode.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const pincodeCodeByOldId = new Map(source.pincodes.map((row) => [row.id, row.code]));
  counts.Pincode = source.pincodes.length;

  await tx.zone.createMany({
    data: source.zones.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
    })),
  });
  const zoneIds = idsByCode(
    await tx.zone.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const zoneCodeByOldId = new Map(source.zones.map((row) => [row.id, row.code]));
  counts.Zone = source.zones.length;

  const zoneLinks = source.zonePincodes
    .map((row) => ({
      orgId,
      zoneId: zoneIds.get(zoneCodeByOldId.get(row.zoneId) ?? ""),
      pincodeId: pincodeIds.get(pincodeCodeByOldId.get(row.pincodeId) ?? ""),
    }))
    .filter(
      (row): row is { orgId: string; zoneId: string; pincodeId: string } =>
        Boolean(row.zoneId && row.pincodeId),
    );
  for (const batch of chunked(zoneLinks)) {
    await tx.zonePincode.createMany({ data: batch });
  }
  counts.ZonePincode = zoneLinks.length;

  // ── Masters ─────────────────────────────────────────────────────────
  await tx.serviceType.createMany({
    data: source.serviceTypes.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      mode: row.mode,
      description: row.description,
      volumetricDivisor: row.volumetricDivisor,
      defaultTransitHours: row.defaultTransitHours,
      allowsCod: row.allowsCod,
      allowsToPay: row.allowsToPay,
      maxDeliveryAttempts: row.maxDeliveryAttempts,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    })),
  });
  const serviceTypeIds = idsByCode(
    await tx.serviceType.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const serviceCodeByOldId = new Map(source.serviceTypes.map((row) => [row.id, row.code]));
  counts.ServiceType = source.serviceTypes.length;

  await tx.packageType.createMany({
    data: source.packageTypes.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      description: row.description,
      isFragile: row.isFragile,
      isStackable: row.isStackable,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    })),
  });
  counts.PackageType = source.packageTypes.length;

  // Before charge types: a charge head points at the tax rate it attracts.
  await tx.taxRate.createMany({
    data: source.taxRates.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      kind: row.kind,
      ratePercent: row.ratePercent,
      isReverseCharge: row.isReverseCharge,
      hsnSac: row.hsnSac,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isActive: row.isActive,
    })),
  });
  const taxRateIds = idsByCode(
    await tx.taxRate.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const taxCodeByOldId = new Map(source.taxRates.map((row) => [row.id, row.code]));
  counts.TaxRate = source.taxRates.length;

  await tx.chargeType.createMany({
    data: source.chargeTypes.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      nature: row.nature,
      defaultBasis: row.defaultBasis,
      isTaxable: row.isTaxable,
      taxRateId: row.taxRateId
        ? (taxRateIds.get(taxCodeByOldId.get(row.taxRateId) ?? "") ?? null)
        : null,
      isCustomerVisible: row.isCustomerVisible,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    })),
  });
  counts.ChargeType = source.chargeTypes.length;

  await tx.reasonCode.createMany({
    data: source.reasonCodes.map((row) => ({
      orgId,
      category: row.category,
      code: row.code,
      name: row.name,
      description: row.description,
      isChargeable: row.isChargeable,
      triggersReattempt: row.triggersReattempt,
      triggersException: row.triggersException,
      notifiesConsignor: row.notifiesConsignor,
      notifiesConsignee: row.notifiesConsignee,
      requiresPhoto: row.requiresPhoto,
      requiresRemarks: row.requiresRemarks,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    })),
  });
  counts.ReasonCode = source.reasonCodes.length;

  await tx.vehicleType.createMany({
    data: source.vehicleTypes.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      capacityKg: row.capacityKg,
      capacityCft: row.capacityCft,
      lengthFt: row.lengthFt,
      widthFt: row.widthFt,
      heightFt: row.heightFt,
      axles: row.axles,
      maxSpeedKmph: row.maxSpeedKmph,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    })),
  });
  counts.VehicleType = source.vehicleTypes.length;

  await tx.numberSeries.createMany({
    data: source.numberSeries.map((row) => copiedNumberSeries(row, orgId, lrPrefix)),
  });
  counts.NumberSeries = source.numberSeries.length;

  // ── RBAC ────────────────────────────────────────────────────────────
  //
  // `Permission` itself stays global — the `resource.action` catalogue is
  // code, not tenant data (ADR 001 §4) — so only the role end of the grant
  // is copied and the permission ids carry straight over.
  await tx.role.createMany({
    data: source.roles.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      description: row.description,
      scope: row.scope,
      isSystem: row.isSystem,
      isActive: row.isActive,
    })),
  });
  const roleIds = idsByCode(
    await tx.role.findMany({ where: { orgId }, select: { id: true, code: true } }),
  );
  const roleCodeByOldId = new Map(source.roles.map((row) => [row.id, row.code]));
  counts.Role = source.roles.length;

  const grants = source.rolePermissions
    .map((row) => ({
      orgId,
      roleId: roleIds.get(roleCodeByOldId.get(row.roleId) ?? ""),
      permissionId: row.permissionId,
    }))
    .filter(
      (row): row is { orgId: string; roleId: string; permissionId: string } =>
        Boolean(row.roleId),
    );
  for (const batch of chunked(grants)) {
    await tx.rolePermission.createMany({ data: batch, skipDuplicates: true });
  }
  counts.RolePermission = grants.length;

  // ── Notifications ───────────────────────────────────────────────────
  await tx.notificationTemplate.createMany({
    data: source.notificationTemplates.map((row) =>
      copiedNotificationTemplate(row, orgId),
    ),
  });
  counts.NotificationTemplate = source.notificationTemplates.length;

  // ── SLA ─────────────────────────────────────────────────────────────
  await tx.slaPolicy.createMany({
    data: source.slaPolicies.map((row) => ({
      orgId,
      code: row.code,
      name: row.name,
      serviceTypeId: row.serviceTypeId
        ? (serviceTypeIds.get(serviceCodeByOldId.get(row.serviceTypeId) ?? "") ?? null)
        : null,
      originZoneId: row.originZoneId
        ? (zoneIds.get(zoneCodeByOldId.get(row.originZoneId) ?? "") ?? null)
        : null,
      destinationZoneId: row.destinationZoneId
        ? (zoneIds.get(zoneCodeByOldId.get(row.destinationZoneId) ?? "") ?? null)
        : null,
      originCityId: row.originCityId
        ? (cityIds.get(cityCodeByOldId.get(row.originCityId) ?? "") ?? null)
        : null,
      destinationCityId: row.destinationCityId
        ? (cityIds.get(cityCodeByOldId.get(row.destinationCityId) ?? "") ?? null)
        : null,
      transitHours: row.transitHours,
      useWorkingHours: row.useWorkingHours,
      respectCutoff: row.respectCutoff,
      atRiskPercent: row.atRiskPercent,
      priority: row.priority,
      isActive: row.isActive,
    })),
  });
  counts.SlaPolicy = source.slaPolicies.length;

  await tx.escalationRule.createMany({
    data: source.escalationRules.map((row) => ({
      orgId,
      kind: row.kind,
      level: row.level,
      afterMinutes: row.afterMinutes,
      // The role code carries over — the roles were just copied under the
      // same codes. `notifyUserId` cannot: it names a member of the
      // template's staff, and the new carrier has one user of its own.
      notifyRoleCode: row.notifyRoleCode,
      notifyUserId: null,
      isActive: row.isActive,
    })),
  });
  counts.EscalationRule = source.escalationRules.length;

  return counts;
}

/**
 * The name to put on the one-time password panel.
 *
 * A read *inside* one named tenant rather than across them, so it goes
 * through `readingTenant` — the console's connection has no tenant on its
 * session and under RLS this would otherwise return nothing. Oldest user
 * wins: on a freshly provisioned tenant there is exactly one.
 */
export async function firstOwnerName(orgId: string): Promise<string | null> {
  const user = await readingTenant(orgId, (tx) =>
    tx.user.findFirst({
      where: { orgId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    }),
  );
  return user?.name ?? null;
}

/**
 * Candidate templates for the console's picker.
 *
 * Oldest first, because the oldest carrier on the platform is the one whose
 * masters have been maintained longest and is the right default.
 * PROVISIONING tenants are excluded: copying from a tenant that is itself
 * half-built is how an empty geography propagates.
 */
export async function listTemplateTenants(): Promise<
  Array<{ id: string; name: string; slug: string; createdAt: Date }>
> {
  return platformDb.organization.findMany({
    where: { status: { in: ["TRIAL", "ACTIVE", "SUSPENDED"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, createdAt: true },
  });
}
