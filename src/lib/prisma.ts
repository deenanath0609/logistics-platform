// The application's Prisma client.
//
// Everything under `src/` imports `prisma` from here, and what it gets is
// the base client wrapped in tenant isolation: every query on a
// tenant-owned model is filtered by the current organisation, and one that
// runs with no tenant established throws rather than returning every
// tenant's rows. See src/lib/tenant/prisma-tenant.ts and
// docs/adr/001-multi-tenancy.md.
//
// Code that legitimately spans tenants — the platform operator console, the
// outbox drain, the seed — declares itself with `runCrossTenant(reason)`
// rather than reaching for `basePrisma`.
import { basePrisma, withAdvisoryLock } from "@/lib/prisma-base";
import { withTenantIsolation } from "@/lib/tenant/prisma-tenant";

export const prisma = withTenantIsolation(basePrisma);

export { basePrisma, withAdvisoryLock };
