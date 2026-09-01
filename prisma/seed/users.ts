import bcrypt from "bcryptjs";
import { db, step, done } from "./client";

/**
 * Development logins. Every one of these is created only when the database
 * has no user with that mobile, so re-seeding never resets a password
 * somebody has already changed.
 */
const DEV_USERS = [
  { name: "System Administrator", mobile: "9999999999", email: "admin@citylogistics.local", role: "SUPER_ADMIN", branch: "HO-DEL", field: false },
  { name: "Rohit Verma", mobile: "9999900001", email: "ops@citylogistics.local", role: "OPS_MANAGER", branch: "HO-DEL", field: false },
  { name: "Anita Sharma", mobile: "9999900002", email: "delhi.manager@citylogistics.local", role: "BRANCH_MANAGER", branch: "HUB-DEL", field: false },
  { name: "Kavita Nair", mobile: "9999900003", email: "booking@citylogistics.local", role: "BOOKING_EXEC", branch: "BR-GGN", field: false },
  { name: "Suresh Yadav", mobile: "9999900004", email: null, role: "HUB_OPERATOR", branch: "HUB-DEL", field: false },
  { name: "Imran Qureshi", mobile: "9999900005", email: null, role: "DISPATCH_MANAGER", branch: "HUB-DEL", field: false },
  { name: "Deepak Rana", mobile: "9999900006", email: "transport@citylogistics.local", role: "TRANSPORT_DESK", branch: "HO-DEL", field: false },
  { name: "Manoj Kumar", mobile: "9999900007", email: null, role: "PICKUP_EXEC", branch: "BR-GGN", field: true },
  { name: "Ravi Prasad", mobile: "9999900008", email: null, role: "DELIVERY_AGENT", branch: "HUB-JAI", field: true },
  { name: "Balwinder Singh", mobile: "9999900009", email: null, role: "DRIVER", branch: "HUB-DEL", field: true },
  { name: "Priya Menon", mobile: "9999900010", email: "accounts@citylogistics.local", role: "ACCOUNTS", branch: "HO-DEL", field: false },
  { name: "Nisha Gupta", mobile: "9999900011", email: "support@citylogistics.local", role: "CUSTOMER_SUPPORT", branch: "HO-DEL", field: false },
];

const DEV_PASSWORD = "Admin@123";

export async function seedUsers(orgId: string, branchIds: Map<string, string>) {
  step("users");

  const roles = await db.role.findMany({
    where: { orgId },
    select: { id: true, code: true },
  });
  const roleIdByCode = new Map(roles.map((r) => [r.code, r.id]));

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  let created = 0;

  for (const u of DEV_USERS) {
    // Scoped to the org, not global: the same mobile may be a login at two
    // carriers on the platform, and skipping on a match in *another* tenant
    // would leave this one without its administrator.
    const existing = await db.user.findUnique({
      where: { orgId_mobile: { orgId, mobile: u.mobile } },
    });
    if (existing) continue;

    const user = await db.user.create({
      data: {
        orgId,
        name: u.name,
        mobile: u.mobile,
        email: u.email,
        // Field users sign in with mobile + OTP; a password is still set so
        // the same account can reach the web app during development.
        passwordHash,
        isFieldUser: u.field,
        primaryBranchId: branchIds.get(u.branch),
        /**
         * False, as `scripts/seed-branch-logins.ts` has always had it.
         *
         * `mustChangePassword` means "somebody else chose this password and
         * handed it to you", and `requireUser` now enforces it: every page
         * redirects to `/password` until it is replaced. That is right for
         * the account an administrator creates on `/admin/users`, and wrong
         * for these — twelve fixtures sharing one password printed in this
         * file and in every set of run instructions, whose entire purpose is
         * to be signed into and driven. Left true, the first page of the
         * development environment would be a password form, and every
         * script that signs in over HTTP would land on it instead of the
         * screen it came to check.
         *
         * The forced change is exercised where it actually matters, against
         * an account created the way a real one is — see
         * `scripts/verify-core.ts`.
         */
        mustChangePassword: false,
      },
    });

    const roleId = roleIdByCode.get(u.role);
    if (roleId) {
      await db.userRole.create({ data: { orgId, userId: user.id, roleId } });
    } else {
      console.warn(`\n    ! unknown role "${u.role}" for ${u.name}`);
    }

    created++;
  }

  done(created === 0 ? "0 (already present)" : created);
  return { devPassword: DEV_PASSWORD };
}
