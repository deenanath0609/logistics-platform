/**
 * Moves stored objects into the tenant-partitioned layout.
 *
 *   npx tsx scripts/migrate-storage-keys.ts            # report only
 *   npx tsx scripts/migrate-storage-keys.ts --apply    # move and rewrite
 *
 * Keys written before this change looked like `pod/<shipmentId>/<uuid>.jpg`
 * — every carrier's evidence in one tree, with nothing but a database row
 * saying whose it was. They are now `<orgId>/pod/<shipmentId>/<uuid>.jpg`,
 * so the tenant is part of the address and a reader can refuse a key that
 * is not its own without a lookup.
 *
 * The readers tolerate both shapes, so nothing breaks before this runs and
 * nothing breaks while it runs. That tolerance is what this script exists
 * to delete: while one legacy key remains, the key prefix cannot be relied
 * on, and the second line of defence is only as good as the first.
 *
 * A *script*, deliberately, and not a rename-on-read. Renaming a file as a
 * side effect of serving it would make a GET a write, would race two
 * concurrent readers of the same asset, and would leave the estate in a
 * state nobody can report on — half migrated, with no way to know which
 * half without walking the tree anyway.
 *
 * Safe to run twice: an already-partitioned key is skipped, and a row whose
 * bytes are missing is reported rather than treated as a failure — assets
 * captured before the storage volume was attached are a known population.
 */
import "dotenv/config";
import { basePrisma, disconnectDb } from "../src/lib/prisma-base";
import { getObjectStore } from "../src/lib/storage";
import { isLegacyObjectKey, assertSafeObjectKey } from "../src/lib/storage/keys";

const APPLY = process.argv.includes("--apply");

type Row = { id: string; objectKey: string; orgId: string };

/**
 * Reads and writes with the unextended client, one organisation at a time,
 * naming the tenant on the session so row-level security lets the rows
 * through.
 *
 * The tenant-scoped client is the wrong tool for exactly one reason: a
 * SUSPENDED organisation is read-only to it, and a data migration that
 * silently skips suspended customers leaves the worst-supervised accounts
 * on the old layout. The org id is still named on every statement here, so
 * this is explicit cross-tenant work rather than unscoped work.
 */
async function assetsFor(orgId: string): Promise<Row[]> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
    return tx.fileAsset.findMany({
      where: { orgId },
      select: { id: true, objectKey: true, orgId: true },
      orderBy: { createdAt: "asc" },
    });
  });
}

async function rewriteKey(row: Row, next: string): Promise<void> {
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${row.orgId}, TRUE)`;
    await tx.fileAsset.update({
      where: { id: row.id },
      data: { objectKey: next },
    });
  });
}

async function main() {
  const store = getObjectStore();
  const orgs = await basePrisma.organization.findMany({
    orderBy: { slug: "asc" },
    select: { id: true, slug: true },
  });

  console.log(
    `\nStorage key migration — ${orgs.length} organisation(s), ` +
      `${APPLY ? "applying" : "reporting only (pass --apply to move files)"}\n`,
  );

  let moved = 0;
  let alreadyPartitioned = 0;
  let missingBytes = 0;
  let failed = 0;

  for (const org of orgs) {
    const rows = await assetsFor(org.id);
    const legacy = rows.filter((row) => isLegacyObjectKey(row.objectKey));

    alreadyPartitioned += rows.length - legacy.length;
    if (legacy.length === 0) {
      console.log(`  ${org.slug}: nothing to move (${rows.length} object(s))`);
      continue;
    }

    console.log(`  ${org.slug}: ${legacy.length} of ${rows.length} object(s) to move`);

    for (const row of legacy) {
      const next = `${row.orgId}/${row.objectKey}`;
      try {
        assertSafeObjectKey(next);
      } catch (error) {
        failed += 1;
        console.log(`    [SKIP] ${row.objectKey} — ${(error as Error).message}`);
        continue;
      }

      if (!APPLY) {
        console.log(`    ${row.objectKey}  ->  ${next}`);
        continue;
      }

      const found = await store.move(row.objectKey, next);
      if (!found) {
        // The row outlived its bytes. Rewriting the key anyway would point
        // it at a second place the file also is not, and would hide the
        // fact that it is gone — so leave it legacy and report it.
        missingBytes += 1;
        console.log(`    [NO BYTES] ${row.objectKey} — key left as it was`);
        continue;
      }

      try {
        await rewriteKey(row, next);
        moved += 1;
      } catch (error) {
        // The bytes have moved but the row has not, which would serve a 404
        // for a file that exists. Put them back, so a re-run starts from a
        // state the script understands.
        await store.move(next, row.objectKey);
        failed += 1;
        console.log(`    [FAIL] ${row.objectKey} — ${(error as Error).message}`);
      }
    }
  }

  console.log(
    `\n${failed === 0 ? "OK" : "FAIL"} — ${moved} moved, ` +
      `${alreadyPartitioned} already partitioned, ` +
      `${missingBytes} row(s) with no bytes on disk, ${failed} failed.\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
