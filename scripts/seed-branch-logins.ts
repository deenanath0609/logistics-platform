/**
 * A full crew at every branch that has to run the operating flow.
 *
 *   npx tsx scripts/seed-branch-logins.ts [--tenant city-logistics] [--dry]
 *
 * The development seed gave the carrier one of each role spread across the
 * network — one booking clerk at Gurugram, the only hub operator at Delhi,
 * the only delivery agent at Jaipur. That is enough to demonstrate a screen
 * and not enough to run a consignment, because the flow is a relay: the
 * origin branch has to receive what it books, the hub has to manifest what
 * it receives, and the destination has to put it on a run. With one person
 * per role the relay only completes if you sign in as the network-scoped
 * administrator, which is precisely the thing a branch test is meant to
 * avoid proving.
 *
 * So this fills the gaps rather than replacing anybody: six posts at each of
 * the four branches on the test lane, skipping any mobile already present.
 * No password is ever reset — an existing login is left exactly as it is.
 *
 * The Branch Manager is not decoration. Two things the flow needs are absent
 * from the smaller roles: `scan.inbound`, without which a branch cannot
 * receive its own counter drop-offs, and `pickup.assign`, without which it
 * cannot send its own van. Booking Executive holds neither. Every branch
 * therefore gets a manager who can, which is how a real branch is staffed
 * anyway, and no role's permission set is edited to make the test pass.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { basePrisma, prisma } from "../src/lib/prisma";
import { runWithTenant, tenantContextFor } from "../src/lib/tenant";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const SUBDOMAIN = arg("tenant", "city-logistics");
const DRY = argv.includes("--dry");
const PASSWORD = arg("password", "Admin@123");

/**
 * The mobile is the login, so it is built to be read off a page rather than
 * looked up: the branch is the repeated digit, the post is the last one.
 * 9333000003 is Gurugram's hub operator and nothing else, at any branch.
 */
const BRANCHES = [
  { code: "HO-DEL", prefix: "9111", label: "Head Office — Delhi" },
  { code: "HUB-DEL", prefix: "9222", label: "Delhi Hub" },
  { code: "BR-GGN", prefix: "9333", label: "Gurugram Branch" },
  { code: "HUB-JAI", prefix: "9444", label: "Jaipur Hub" },
] as const;

const POSTS = [
  { digit: "1", role: "BRANCH_MANAGER", post: "Branch Manager", field: false },
  { digit: "2", role: "BOOKING_EXEC", post: "Booking Executive", field: false },
  { digit: "3", role: "HUB_OPERATOR", post: "Hub Operator", field: false },
  { digit: "4", role: "DISPATCH_MANAGER", post: "Dispatch Manager", field: false },
  { digit: "5", role: "PICKUP_EXEC", post: "Pickup Executive", field: true },
  { digit: "6", role: "DELIVERY_AGENT", post: "Delivery Agent", field: true },
] as const;

/** One name per slot, so a tester reads a person and not a role code. */
const NAMES: Record<string, string[]> = {
  "HO-DEL": ["Vikram Sethi", "Pooja Aggarwal", "Rakesh Bisht", "Sandeep Chawla", "Irfan Ali", "Naveen Dutt"],
  "HUB-DEL": ["Meera Kapoor", "Arjun Malhotra", "Sunil Tomar", "Farhan Sheikh", "Rajesh Pal", "Amit Chauhan"],
  "BR-GGN": ["Neha Bhatia", "Gaurav Saini", "Dinesh Rawat", "Shalini Ahuja", "Pankaj Yadav", "Vinod Meena"],
  "HUB-JAI": ["Alka Sharma", "Mahesh Choudhary", "Bhanu Pratap", "Kirti Jain", "Ramniwas Gurjar", "Sohan Lal"],
};

type Row = {
  mobile: string;
  name: string;
  post: string;
  branch: string;
  field: boolean;
  existed: boolean;
  made: boolean;
};

async function main() {
  const org = await basePrisma.organization.findFirstOrThrow({
    where: { OR: [{ subdomain: SUBDOMAIN }, { slug: SUBDOMAIN }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  const tenant = tenantContextFor(org, "job");
  if (!tenant) throw new Error(`Organisation "${SUBDOMAIN}" is closed.`);

  const rows: Row[] = [];

  await runWithTenant(tenant, async () => {
    const branches = await prisma.branch.findMany({
      where: { code: { in: BRANCHES.map((b) => b.code) } },
      select: { id: true, code: true },
    });
    const branchId = new Map(branches.map((b) => [b.code, b.id]));

    const roles = await prisma.role.findMany({ select: { id: true, code: true } });
    const roleId = new Map(roles.map((r) => [r.code, r.id]));

    const missingBranch = BRANCHES.filter((b) => !branchId.has(b.code));
    if (missingBranch.length) {
      throw new Error(`No such branch: ${missingBranch.map((b) => b.code).join(", ")}`);
    }
    const missingRole = POSTS.filter((p) => !roleId.has(p.role));
    if (missingRole.length) {
      throw new Error(`No such role: ${missingRole.map((p) => p.role).join(", ")}`);
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    for (const branch of BRANCHES) {
      for (const [index, post] of POSTS.entries()) {
        const mobile = `${branch.prefix}00000${post.digit}`;
        const name = NAMES[branch.code]?.[index] ?? `${post.post} — ${branch.code}`;

        const existing = await prisma.user.findFirst({
          where: { mobile },
          select: { id: true },
        });

        if (existing || DRY) {
          rows.push({
            mobile,
            name,
            post: post.post,
            branch: branch.code,
            field: post.field,
            existed: Boolean(existing),
            made: false,
          });
          continue;
        }

        const user = await prisma.user.create({
          data: {
            orgId: org.id,
            name,
            mobile,
            email: null,
            passwordHash,
            isFieldUser: post.field,
            primaryBranchId: branchId.get(branch.code)!,
            // These accounts exist to be signed into on the spot. A forced
            // change would send a tester to a screen that does not exist yet.
            mustChangePassword: false,
          },
        });

        await prisma.userRole.create({
          data: { orgId: org.id, userId: user.id, roleId: roleId.get(post.role)! },
        });

        rows.push({
          mobile,
          name,
          post: post.post,
          branch: branch.code,
          field: post.field,
          existed: false,
          made: true,
        });
      }
    }
  });

  const made = rows.filter((r) => r.made).length;
  console.log(
    `\n${DRY ? "Would create" : "Created"} ${DRY ? rows.length : made} login(s); ` +
      `${rows.length - (DRY ? rows.length : made)} already existed. Password: ${PASSWORD}\n`,
  );

  for (const branch of BRANCHES) {
    console.log(`${branch.code} — ${branch.label}`);
    for (const row of rows.filter((r) => r.branch === branch.code)) {
      console.log(
        `  ${row.mobile}  ${row.post.padEnd(19)} ${(row.field ? "field" : "desk").padEnd(6)} ` +
          `${row.name.padEnd(20)} ${row.existed ? "already there" : DRY ? "would create" : "new"}`,
      );
    }
    console.log("");
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nCould not seed the branch logins:\n", error);
    await prisma.$disconnect();
    process.exit(1);
  });
