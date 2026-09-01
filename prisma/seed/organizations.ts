import { db, step, done } from "./client";

/**
 * The tenant list, and the only place a seeded organisation is described.
 *
 * Kept out of `index.ts` because `demo-run.ts` needs to resolve an org too,
 * and importing `index.ts` would run the whole Phase 1 seed as a side effect
 * of reading a slug.
 */

export type OrganizationSeed = {
  slug: string;
  /** The host this tenant is reached on. Resolution happens before any query. */
  subdomain: string;
  /**
   * The plan this carrier is on, by code from `plans.ts`.
   *
   * Null is a carrier mid-provisioning, which is a real state — and the
   * state the development carrier was accidentally left in, because this
   * field did not exist and the create wrote `planId: null` with a comment
   * saying no plans were seeded. `seedPlans()` had since been added and runs
   * first, so the comment was describing a database that no longer existed.
   *
   * The consequence was not visible on any developer's machine, where the
   * plan had been set by hand at some point and stayed set. It was visible
   * only on a database built from scratch — which is what CI does, and CI
   * had been failing at the plan-gating step on every push for two days:
   * with no plan the carrier holds `core` and nothing else, so the suite
   * that proves "reaches what it bought, refused what it did not" had a
   * carrier that had bought less than the one it was meant to out-reach,
   * and correctly refused to draw any conclusion at all.
   */
  planCode: string | null;
  name: string;
  legalName: string;
  lrPrefix: string;
  city: string;
  state: string;
  currency: string;
  timezone: string;
  /**
   * Overrides the CSS custom properties in globals.css. Null leaves the
   * product's own tokens standing, which is a legitimate choice for a
   * tenant who has not picked a palette.
   */
  primaryColorHex: string | null;
  accentColorHex: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  documentFooter: string | null;
  termsText: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  smtpFrom: string | null;
};

/** The org every other script falls back to when none is named. */
export const DEFAULT_ORG_SLUG = "city-logistics";

/**
 * One entry today, seeded as a list rather than a singleton because a second
 * carrier is a data change under ADR 001, not a rewrite — and because a seed
 * that can only produce one tenant cannot be used to reproduce a two-tenant
 * isolation failure.
 *
 * The environment variables are read only by the first entry. A second tenant
 * inheriting `APP_NAME` from whoever's shell ran the seed would be a bug that
 * looks like a typo.
 */
export const ORGANIZATIONS: OrganizationSeed[] = [
  {
    slug: DEFAULT_ORG_SLUG,
    // Seeded from the slug because that is what the Phase 9 migration
    // backfills existing rows with — a fresh database and a migrated one
    // must land on the same value.
    subdomain: DEFAULT_ORG_SLUG,
    // The development carrier is the one every screen is built and
    // demonstrated against, so it holds the whole catalogue. A second
    // carrier on a narrower plan is what the gating suites reach for.
    planCode: "ENTERPRISE",
    name: process.env.APP_NAME ?? "City Logistics",
    legalName: "City Logistics Private Limited",
    lrPrefix: process.env.LR_PREFIX ?? "CL",
    city: "Delhi",
    state: "Delhi",
    currency: process.env.DEFAULT_CURRENCY ?? "INR",
    timezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata",
    // The hex that `globals.css` already declares as `--primary`, so the
    // first tenant renders identically whether the palette is applied from
    // the database or falls back to the stylesheet. It is here so the
    // white-label path is exercised from the first run rather than only
    // when a second customer arrives.
    primaryColorHex: "#0f676d",
    // Deliberately null: `--accent` in globals.css is already a wash, and
    // branding.ts washes whatever it is given. Storing the washed value
    // would wash it twice and land on near-white.
    accentColorHex: null,
    logoUrl: "/brand/city_logistics_logo.png",
    faviconUrl: "/brand/favicon_city_logistics.png",
    documentFooter:
      "Subject to Delhi jurisdiction. Goods carried at owner's risk unless " +
      "insured. This is a computer-generated document.",
    termsText:
      "Consignments are accepted subject to the carrier's standard terms of " +
      "carriage. Claims must be lodged within 30 days of the delivery date.",
    supportEmail: "support@citylogistics.local",
    supportPhone: "01141000100",
    smtpFrom: "City Logistics <no-reply@citylogistics.local>",
  },
];

export async function seedOrganization(def: OrganizationSeed) {
  step(`organization ${def.slug}`);

  // Resolved rather than assumed: `seedPlans()` runs before this, but a
  // catalogue that has been edited should make the seed stop and say so
  // rather than quietly create a carrier with nothing switched on.
  let planId: string | null = null;
  if (def.planCode) {
    const plan = await db.tenantPlan.findUnique({
      where: { code: def.planCode },
      select: { id: true },
    });
    if (!plan) {
      throw new Error(
        `No plan "${def.planCode}" for ${def.slug}. Seed the plans first — prisma/seed/plans.ts.`,
      );
    }
    planId = plan.id;
  }

  const org = await db.organization.upsert({
    where: { slug: def.slug },
    create: {
      name: def.name,
      legalName: def.legalName,
      slug: def.slug,
      subdomain: def.subdomain,
      status: "ACTIVE",
      planId,
      activatedAt: new Date(),
      lrPrefix: def.lrPrefix,
      city: def.city,
      state: def.state,
      currency: def.currency,
      timezone: def.timezone,
      primaryColorHex: def.primaryColorHex,
      accentColorHex: def.accentColorHex,
      logoUrl: def.logoUrl,
      faviconUrl: def.faviconUrl,
      documentFooter: def.documentFooter,
      termsText: def.termsText,
      supportEmail: def.supportEmail,
      supportPhone: def.supportPhone,
      // Left unset on purpose. The DLT sender header is registered per
      // tenant over one to three weeks (ADR 001 §3), and a header that has
      // not been approved is rejected at the gateway — which looks exactly
      // like a working system from the UI. Operations fills this in when
      // registration comes back, alongside activating the SMS templates.
      dltSenderId: null,
      smtpFrom: def.smtpFrom,
    },
    // Empty on purpose: branding, plan and status are operator-owned once
    // the tenant exists, and a re-seed must not reset a palette somebody
    // chose or re-activate a company that was suspended.
    // Re-seeding never resets a carrier somebody has since configured.
    update: {},
  });

  // The one exception, and it fills a blank rather than overwriting a
  // choice: a carrier left with no plan holds `core` and nothing else, and
  // every database seeded before `planCode` existed is in that state. An
  // operator who has deliberately moved a carrier onto a narrower plan is
  // not touched, because their `planId` is not null.
  if (planId && org.planId === null) {
    await db.organization.update({
      where: { id: org.id },
      data: { planId },
    });
  }

  done(org.name);
  return org;
}
