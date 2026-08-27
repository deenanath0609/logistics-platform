import bcrypt from "bcryptjs";
import { db, step, done } from "./client";

/**
 * Demo data for testing.
 *
 * Separate from the main seed on purpose: masters and roles belong in
 * every environment, but invented customers and trucks do not belong in
 * production. Run with `npm run db:seed:demo`.
 *
 * Idempotent — safe to re-run.
 */

const CUSTOMERS = [
  {
    code: "ACME01",
    name: "Acme Industries",
    legalName: "Acme Industries Private Limited",
    type: "CORPORATE" as const,
    phone: "9811000001",
    email: "logistics@acme.test",
    gstin: "06AABCA1234F1Z5",
    pan: "AABCA1234F",
    paymentTerm: "CREDIT" as const,
    creditLimit: 500000,
    creditDays: 30,
    branch: "BR-GGN",
    city: "GGN",
    addresses: [
      {
        label: "Plant gate",
        kind: "PICKUP" as const,
        address: "Plot 14, Udyog Vihar Phase IV",
        city: "GGN",
        pincode: "122015",
        contactName: "Ramesh Kumar",
        phone: "9811000011",
        isDefault: true,
      },
      {
        label: "Head office",
        kind: "BILLING" as const,
        address: "5th Floor, Cyber Hub, DLF Phase 2",
        city: "GGN",
        pincode: "122001",
        contactName: "Accounts",
        phone: "9811000012",
        isDefault: true,
      },
    ],
    portalUsers: [
      { name: "Priya Sharma", email: "priya@acme.test", role: "OWNER" as const },
      { name: "Vikram Rao", email: "vikram@acme.test", role: "MEMBER" as const },
    ],
  },
  {
    code: "BHARAT02",
    name: "Bharat Textiles",
    legalName: "Bharat Textiles LLP",
    type: "CORPORATE" as const,
    phone: "9811000002",
    email: "dispatch@bharattex.test",
    gstin: "08AACFB5678K1Z2",
    pan: "AACFB5678K",
    paymentTerm: "CREDIT" as const,
    creditLimit: 250000,
    creditDays: 15,
    branch: "HUB-JAI",
    city: "JAI",
    addresses: [
      {
        label: "Mill",
        kind: "PICKUP" as const,
        address: "G-42, Vaishali Nagar Industrial Area",
        city: "JAI",
        pincode: "302013",
        contactName: "Suresh Meena",
        phone: "9811000021",
        isDefault: true,
      },
    ],
    portalUsers: [
      { name: "Anil Jain", email: "anil@bharattex.test", role: "OWNER" as const },
    ],
  },
  {
    code: "WALKIN",
    name: "Walk-in Cash Customer",
    type: "WALK_IN" as const,
    phone: "9811000003",
    paymentTerm: "CASH" as const,
    branch: "BR-GGN",
    city: "GGN",
    addresses: [],
    portalUsers: [],
  },
];

const VEHICLE_TYPES = [
  { code: "TATA407", name: "Tata 407 — 2.5T", capacityKg: 2500, capacityCft: 380 },
  { code: "EICHER19", name: "Eicher 19ft — 7T", capacityKg: 7000, capacityCft: 850 },
  { code: "TRUCK32", name: "32ft Multi-Axle — 16T", capacityKg: 16000, capacityCft: 1900 },
  { code: "TEMPO", name: "Tempo — 1T", capacityKg: 1000, capacityCft: 180 },
];

/** Days from today. Negative is already expired — the expiry dashboard needs both. */
const VEHICLES = [
  {
    reg: "HR26AB1234", type: "EICHER19", branch: "HUB-DEL", ownership: "OWN" as const,
    make: "Eicher", model: "Pro 2049", year: 2022,
    docs: [
      { kind: "RC" as const, expires: 900 },
      { kind: "INSURANCE" as const, expires: 210 },
      { kind: "FITNESS" as const, expires: 140 },
      { kind: "PERMIT_NATIONAL" as const, expires: 300 },
      { kind: "PUC" as const, expires: 45 },
    ],
  },
  {
    reg: "RJ14CD5678", type: "TRUCK32", branch: "HUB-JAI", ownership: "OWN" as const,
    make: "Ashok Leyland", model: "3220", year: 2021,
    docs: [
      { kind: "RC" as const, expires: 700 },
      // Expiring inside the 30-day window — should show amber.
      { kind: "INSURANCE" as const, expires: 18 },
      { kind: "FITNESS" as const, expires: 260 },
      { kind: "PERMIT_NATIONAL" as const, expires: 120 },
      { kind: "PUC" as const, expires: 90 },
    ],
  },
  {
    reg: "DL01EF9012", type: "TATA407", branch: "HUB-DEL", ownership: "ATTACHED" as const,
    make: "Tata", model: "407 Gold", year: 2020,
    docs: [
      { kind: "RC" as const, expires: 500 },
      // Already lapsed — this vehicle must be refused for assignment.
      { kind: "FITNESS" as const, expires: -12 },
      { kind: "INSURANCE" as const, expires: 150 },
      { kind: "PUC" as const, expires: 30 },
    ],
  },
  {
    reg: "GJ01GH3456", type: "TEMPO", branch: "HUB-AMD", ownership: "VENDOR" as const,
    make: "Mahindra", model: "Bolero Pickup", year: 2023,
    docs: [
      { kind: "RC" as const, expires: 1100 },
      { kind: "INSURANCE" as const, expires: 400 },
      { kind: "FITNESS" as const, expires: 380 },
      { kind: "PUC" as const, expires: 200 },
    ],
  },
];

const DRIVERS = [
  { code: "DRV001", name: "Balwinder Singh", mobile: "9812000001", branch: "HUB-DEL", licence: "DL0420110012345", licenceExpires: 620 },
  { code: "DRV002", name: "Mohan Lal", mobile: "9812000002", branch: "HUB-JAI", licence: "RJ1420150067890", licenceExpires: 95 },
  // Lapsed licence — assignment must be refused.
  { code: "DRV003", name: "Iqbal Khan", mobile: "9812000003", branch: "HUB-DEL", licence: "DL0520090054321", licenceExpires: -30 },
  { code: "DRV004", name: "Ganesh Patil", mobile: "9812000004", branch: "HUB-AMD", licence: "GJ0120170098765", licenceExpires: 800 },
];

const DEMO_PASSWORD = "Portal@123";

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export async function seedDemo(orgId: string) {
  const branches = await db.branch.findMany({ select: { id: true, code: true } });
  const branchId = new Map(branches.map((b) => [b.code, b.id]));
  const cities = await db.city.findMany({ select: { id: true, code: true } });
  const cityId = new Map(cities.map((c) => [c.code, c.id]));

  // ── Customers, addresses, portal logins ──────────────────
  step("demo customers");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  let portalCount = 0;

  for (const c of CUSTOMERS) {
    const customer = await db.customer.upsert({
      where: { orgId_code: { orgId, code: c.code } },
      create: {
        orgId,
        code: c.code,
        name: c.name,
        legalName: c.legalName,
        type: c.type,
        phone: c.phone,
        email: c.email,
        gstin: c.gstin,
        pan: c.pan,
        paymentTerm: c.paymentTerm,
        creditLimit: c.creditLimit,
        creditDays: c.creditDays,
        branchId: branchId.get(c.branch),
        billingCityId: cityId.get(c.city),
      },
      update: { name: c.name, phone: c.phone },
    });

    for (const a of c.addresses) {
      const existing = await db.customerAddress.findFirst({
        where: { customerId: customer.id, label: a.label },
      });
      const data = {
        customerId: customer.id,
        label: a.label,
        kind: a.kind,
        address: a.address,
        cityId: cityId.get(a.city)!,
        pincode: a.pincode,
        contactName: a.contactName,
        phone: a.phone,
        isDefault: a.isDefault,
      };
      if (existing) await db.customerAddress.update({ where: { id: existing.id }, data });
      else await db.customerAddress.create({ data });
    }

    for (const u of c.portalUsers) {
      const existing = await db.customerUser.findUnique({ where: { email: u.email } });
      if (existing) continue;
      await db.customerUser.create({
        data: {
          customerId: customer.id,
          name: u.name,
          email: u.email,
          role: u.role,
          passwordHash,
          // Demo logins skip the forced change so testing is not a
          // password-reset exercise.
          mustChangePassword: false,
        },
      });
      portalCount++;
    }
  }
  done(`${CUSTOMERS.length} customers, ${portalCount} portal logins`);

  // ── Fleet ────────────────────────────────────────────────
  step("demo vehicle types");
  const typeId = new Map<string, string>();
  for (const [i, t] of VEHICLE_TYPES.entries()) {
    const row = await db.vehicleType.upsert({
      where: { code: t.code },
      create: { ...t, sortOrder: i * 10 },
      update: { name: t.name, capacityKg: t.capacityKg, capacityCft: t.capacityCft },
    });
    typeId.set(t.code, row.id);
  }
  done(VEHICLE_TYPES.length);

  step("demo vehicles");
  for (const v of VEHICLES) {
    const vehicle = await db.vehicle.upsert({
      where: { registrationNumber: v.reg },
      create: {
        orgId,
        registrationNumber: v.reg,
        vehicleTypeId: typeId.get(v.type)!,
        branchId: branchId.get(v.branch),
        ownership: v.ownership,
        make: v.make,
        model: v.model,
        manufactureYear: v.year,
      },
      update: { make: v.make, model: v.model },
    });

    for (const d of v.docs) {
      const existing = await db.vehicleDocument.findFirst({
        where: { vehicleId: vehicle.id, kind: d.kind },
      });
      const data = {
        vehicleId: vehicle.id,
        kind: d.kind,
        documentNumber: `${v.reg}-${d.kind}`,
        expiresOn: daysFromNow(d.expires),
        isMandatory: d.kind !== "PUC",
      };
      if (existing) await db.vehicleDocument.update({ where: { id: existing.id }, data });
      else await db.vehicleDocument.create({ data });
    }
  }
  done(`${VEHICLES.length} (one with a lapsed fitness certificate, on purpose)`);

  step("demo drivers");
  for (const d of DRIVERS) {
    await db.driver.upsert({
      where: { mobile: d.mobile },
      create: {
        orgId,
        code: d.code,
        name: d.name,
        mobile: d.mobile,
        branchId: branchId.get(d.branch),
        licenceNumber: d.licence,
        licenceClass: "HMV",
        licenceExpiry: daysFromNow(d.licenceExpires),
      },
      update: { licenceExpiry: daysFromNow(d.licenceExpires) },
    });
  }
  done(`${DRIVERS.length} (one with a lapsed licence, on purpose)`);

  return { portalPassword: DEMO_PASSWORD };
}
