import "dotenv/config";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const db = new PrismaClient({ adapter: new PrismaPg(pool) });

export async function disconnect() {
  await db.$disconnect();
  await pool.end();
}

export function step(label: string) {
  process.stdout.write(`  ${label.padEnd(42, ".")} `);
}

export function done(count: number | string) {
  console.log(typeof count === "number" ? `${count}` : count);
}
