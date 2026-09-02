/**
 * Creates a platform operator — the login that runs the console.
 *
 *   npx tsx scripts/create-platform-admin.ts --email ops@platform.com \
 *     --name "Priya Rao" --role OWNER [--password '…']
 *
 * This exists because of a bootstrap problem with no other answer: the
 * operator console is the only way to administer the platform, and nobody
 * can sign in to it until a `PlatformAdmin` row exists. There is no
 * self-registration and there must not be — a sign-up form on
 * `admin.<platform>` is a sign-up form for the whole estate.
 *
 * Deliberately a script for the same reason `provision-tenant.ts` is one:
 * it is rare, it is dangerous, and it is far easier to review as code than
 * as a form. Whoever can run it already has the database.
 *
 * A generated password is written with `mustChangePassword: true`. It has
 * been in a shell history, a scrollback buffer and probably a chat message;
 * it is a handover token, not a credential, and the console refuses to do
 * anything until it is replaced.
 *
 * `--password` is the exception, and only because of what it is for: a
 * console a *script* has to sign into afterwards — CI, a fixture, a
 * demonstration. A password the caller chose was never handed to anybody, so
 * there is nobody for it to have travelled to, and forcing a change would
 * only park that script on a form it cannot fill in. The same reasoning, and
 * the same flag, as `--owner-password` on `provision-tenant.ts`.
 *
 * Do not use it to onboard a real operator.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { db, disconnect } from "../prisma/seed/client";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith("--") ? next : "true";
  }
  return args;
}

const ROLES = ["OWNER", "SUPPORT", "BILLING", "VIEWER"] as const;
type Role = (typeof ROLES)[number];

/** Readable, and long enough that nobody is tempted to keep it. */
function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = args.email?.trim().toLowerCase();
  const name = args.name?.trim();
  const role = (args.role ?? "OWNER").toUpperCase() as Role;

  if (!email || !name) {
    console.error(
      "Usage: npx tsx scripts/create-platform-admin.ts --email <email> --name <name> " +
        `[--role ${ROLES.join("|")}] [--password <password>]`,
    );
    process.exit(1);
  }

  if (!ROLES.includes(role)) {
    console.error(`Role must be one of ${ROLES.join(", ")}.`);
    process.exit(1);
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`"${email}" does not look like an email address.`);
    process.exit(1);
  }

  const existing = await db.platformAdmin.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    console.error(
      `Refusing: an operator already exists for ${email}. ` +
        "Reset that login rather than creating a second one — two rows for one " +
        "person is how a revoked operator keeps a way in.",
    );
    process.exit(1);
  }

  const password = args.password ?? generatePassword();
  if (password.length < 12) {
    console.error("Use at least 12 characters — this login can suspend a company.");
    process.exit(1);
  }

  const admin = await db.platformAdmin.create({
    data: {
      email,
      name,
      role,
      passwordHash: await bcrypt.hash(password, 12),
      // See the note at the top: a generated secret has been read by
      // whoever ran this and must be replaced; one the caller chose has not
      // travelled anywhere.
      mustChangePassword: !args.password,
    },
    select: { id: true, email: true, role: true },
  });

  // The creation of an operator is itself an operator action, and the one
  // most worth being able to point at later. There is no acting admin —
  // this ran from a shell — so the row names none, which is exactly what
  // "created out of band" should look like in the trail.
  await db.platformAuditLog.create({
    data: {
      action: "operator.create",
      entity: "PlatformAdmin",
      entityId: admin.id,
      after: { email: admin.email, role: admin.role },
      reason: "Created from scripts/create-platform-admin.ts",
    },
  });

  const root = process.env.APP_ROOT_DOMAIN ?? "localhost";

  console.log(`\n  operator   ${admin.id}`);
  console.log(`  email      ${admin.email}`);
  console.log(`  role       ${admin.role}`);
  if (!args.password) console.log(`  password   ${password}`);
  console.log(`\nSign in at http://admin.${root}:3010/platform/login`);
  console.log(
    args.password
      ? "The password you supplied. No change is forced at first sign-in.\n"
      : "The console will require a new password before anything else.\n",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnect);
