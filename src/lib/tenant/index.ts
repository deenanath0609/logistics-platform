export {
  type TenantContext,
  TenantContextError,
  TenantReadOnlyError,
  assertTenantWritable,
  currentOrgId,
  currentTenant,
  isCrossTenantScope,
  requireTenant,
  runCrossTenant,
  runWithTenant,
} from "@/lib/tenant/context";

export {
  RESERVED_SUBDOMAINS,
  isPlatformHost,
  isValidSubdomain,
  normaliseHost,
  parseTenantHost,
  tenantOrigin,
} from "@/lib/tenant/host";

export {
  bustTenantCache,
  orgForHost,
  requireTenantOrgId,
  resolveTenant,
  tenantContextFor,
  type ResolvedOrg,
} from "@/lib/tenant/resolve";

export {
  forEachTenant,
  tenantsForPass,
  type TenantPassOptions,
  type TenantPassResult,
  type TenantSlice,
} from "@/lib/tenant/for-each-tenant";
