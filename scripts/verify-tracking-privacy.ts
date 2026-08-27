/**
 * Fetches a real shipment's PUBLIC tracking page as an anonymous visitor
 * and asserts that nothing internal reaches the HTML.
 *
 *   npx tsx scripts/verify-tracking-privacy.ts [baseUrl]
 *
 * The unit tests assert this against the projection function. This asserts
 * it against the rendered page, which is what an actual competitor or
 * curious consignee would see — a field can leak through a layout, a
 * breadcrumb, or a debug attribute without the projection ever changing.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const BASE = process.argv[2] ?? "http://localhost:3010";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  console.log(`\nPublic tracking privacy — ${BASE}\n`);

  const shipment = await prisma.shipment.findFirst({
    where: { deletedAt: null },
    orderBy: { bookedAt: "desc" },
    include: {
      originBranch: true,
      destinationBranch: true,
      currentBranch: true,
      bookedBy: { select: { name: true } },
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      events: {
        include: {
          branch: { select: { code: true, name: true } },
          user: { select: { name: true } },
          reasonCode: { select: { code: true, name: true } },
        },
      },
    },
  });

  if (!shipment) {
    console.log("  No shipments in the database — run verify-spine.ts first.\n");
    process.exit(1);
  }

  const response = await fetch(`${BASE}/track/${shipment.lrNumber}`);
  const html = await response.text();

  check("page renders without a login", response.status === 200, `status ${response.status}`);
  check("the LR number is shown", html.includes(shipment.lrNumber));
  check(
    "the destination city is shown",
    html.includes(shipment.consigneeCity.name),
    shipment.consigneeCity.name,
  );

  // Everything below must be ABSENT. These are the values a competitor
  // would want and a consignee has no business seeing.
  const secrets: Array<[string, string | null | undefined]> = [
    ["origin branch code", shipment.originBranch.code],
    ["origin branch name", shipment.originBranch.name],
    ["destination branch code", shipment.destinationBranch.code],
    ["destination branch name", shipment.destinationBranch.name],
    ["current branch code", shipment.currentBranch?.code],
    ["booking staff name", shipment.bookedBy?.name],
    ["consignor address", shipment.consignorAddress],
    ["consignee address", shipment.consigneeAddress],
    ["consignee phone", shipment.consigneePhone],
    ["consignor phone", shipment.consignorPhone],
    ["grand total", Number(shipment.grandTotal) > 0 ? String(shipment.grandTotal) : null],
    ["freight amount", Number(shipment.freightAmount) > 0 ? String(shipment.freightAmount) : null],
    ["COD amount", shipment.codAmount ? String(shipment.codAmount) : null],
    ["internal shipment id", shipment.id],
  ];

  for (const event of shipment.events) {
    if (event.user?.name) secrets.push(["event staff name", event.user.name]);
    if (event.branch?.code) secrets.push(["event branch code", event.branch.code]);
    if (event.remarks) secrets.push(["internal remarks", event.remarks]);
    if (event.reasonCode?.code) secrets.push(["reason code", event.reasonCode.code]);
  }

  const seen = new Set<string>();
  let leaks = 0;

  for (const [label, value] of secrets) {
    if (!value || value.length < 3) continue;
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (html.includes(value)) {
      leaks++;
      console.log(`  [FAIL] LEAKED ${label}: "${value}"`);
      failures++;
    }
  }

  check(
    `no internal data in the rendered page (${seen.size} values checked)`,
    leaks === 0,
    leaks === 0 ? "" : `${leaks} leaked`,
  );

  // An unauthenticated endpoint that accepts an identifier is an
  // enumeration target; a miss must not confirm or deny anything useful.
  const bogus = await fetch(`${BASE}/track/CL999999999999`);
  const bogusHtml = await bogus.text();
  check(
    "an unknown LR does not error out",
    bogus.status === 200 || bogus.status === 404,
    `status ${bogus.status}`,
  );
  check(
    "an unknown LR reveals no stack trace",
    !bogusHtml.includes("prisma") && !bogusHtml.includes("at async"),
  );

  console.log(
    failures === 0
      ? `\nNothing leaked. Checked ${seen.size} internal values against ${shipment.lrNumber}.\n`
      : `\n${failures} problem(s).\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nCrashed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
