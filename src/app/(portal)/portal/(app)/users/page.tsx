import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isAccountOwner, requireCustomerUser } from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";
import { PageHeader } from "@/components/shell/page-header";
import { People } from "./people";

export const metadata: Metadata = {
  title: "People",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Sub-user management, per docs/BRD.html §A.14: an account owner invites
 * logins "for their own account only", with per-branch visibility.
 */
export default async function PortalPeoplePage() {
  const session = await requireCustomerUser();
  if (!isAccountOwner(session)) redirect("/portal");

  const [users, branches] = await Promise.all([
    prisma.customerUser.findMany({
      where: { ...customerOwnedFilter(session), deletedAt: null },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        role: true,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: true,
        lockedUntil: true,
        invitedAt: true,
        visibleBranchIds: true,
      },
    }),
    // Only branches this account's traffic actually touches. Offering the
    // whole network here would turn a visibility picker into a directory.
    prisma.branch.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { customers: { some: { id: session.customerId } } },
          { originShipments: { some: { consignorId: session.customerId } } },
          { bookedShipments: { some: { consignorId: session.customerId } } },
        ],
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: { select: { name: true } } },
    }),
  ]);

  const branchName = new Map(
    branches.map((branch) => [branch.id, `${branch.name} (${branch.city.name})`]),
  );

  return (
    <>
      <PageHeader
        title="People"
        description={`Logins for ${session.customerName}. Everyone here sees this account's shipments and nobody else's.`}
      />

      <People
        currentUserId={session.id}
        users={users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          role: user.role,
          isActive: user.isActive,
          mustChangePassword: user.mustChangePassword,
          lastLoginAt: user.lastLoginAt,
          lockedUntil: user.lockedUntil,
          invitedAt: user.invitedAt,
          visibleBranchNames: user.visibleBranchIds
            .map((id) => branchName.get(id))
            .filter((name): name is string => Boolean(name)),
        }))}
        branches={branches.map((branch) => ({
          value: branch.id,
          label: `${branch.name} · ${branch.city.name}`,
        }))}
      />
    </>
  );
}
