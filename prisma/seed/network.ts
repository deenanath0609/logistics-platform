import { db, step, done } from "./client";

const STATES = [
  { code: "DL", name: "Delhi", gstCode: "07" },
  { code: "HR", name: "Haryana", gstCode: "06" },
  { code: "RJ", name: "Rajasthan", gstCode: "08" },
  { code: "GJ", name: "Gujarat", gstCode: "24" },
  { code: "MH", name: "Maharashtra", gstCode: "27" },
  { code: "PB", name: "Punjab", gstCode: "03" },
  { code: "UP", name: "Uttar Pradesh", gstCode: "09" },
];

const CITIES = [
  { code: "DEL", name: "Delhi", state: "DL", lat: 28.6139, lng: 77.209, metro: true },
  { code: "GGN", name: "Gurugram", state: "HR", lat: 28.4595, lng: 77.0266, metro: true },
  { code: "FBD", name: "Faridabad", state: "HR", lat: 28.4089, lng: 77.3178, metro: false },
  { code: "JAI", name: "Jaipur", state: "RJ", lat: 26.9124, lng: 75.7873, metro: true },
  { code: "AMD", name: "Ahmedabad", state: "GJ", lat: 23.0225, lng: 72.5714, metro: true },
  { code: "BOM", name: "Mumbai", state: "MH", lat: 19.076, lng: 72.8777, metro: true },
  { code: "LDH", name: "Ludhiana", state: "PB", lat: 30.901, lng: 75.8573, metro: false },
  { code: "NOI", name: "Noida", state: "UP", lat: 28.5355, lng: 77.391, metro: false },
];

/** A representative sample. The full ~19,000-PIN list is imported in UAT. */
const PINCODES: Array<{
  code: string;
  city: string;
  area: string;
  oda?: boolean;
  branch?: string;
}> = [
  { code: "110001", city: "DEL", area: "Connaught Place", branch: "HUB-DEL" },
  { code: "110020", city: "DEL", area: "Okhla Industrial Area", branch: "HUB-DEL" },
  { code: "110037", city: "DEL", area: "Mahipalpur", branch: "HUB-DEL" },
  { code: "110092", city: "DEL", area: "Shahdara", branch: "HUB-DEL" },
  { code: "122001", city: "GGN", area: "Gurugram Sector 14", branch: "BR-GGN" },
  { code: "122015", city: "GGN", area: "Udyog Vihar", branch: "BR-GGN" },
  { code: "121001", city: "FBD", area: "Faridabad NIT", branch: "BR-FBD" },
  { code: "121003", city: "FBD", area: "Sector 21", branch: "BR-FBD" },
  { code: "302001", city: "JAI", area: "Jaipur City", branch: "HUB-JAI" },
  { code: "302013", city: "JAI", area: "Vaishali Nagar", branch: "HUB-JAI" },
  { code: "303007", city: "JAI", area: "Bassi", oda: true, branch: "HUB-JAI" },
  { code: "380001", city: "AMD", area: "Ahmedabad City", branch: "HUB-AMD" },
  { code: "382330", city: "AMD", area: "Naroda GIDC", branch: "HUB-AMD" },
  { code: "400001", city: "BOM", area: "Fort", branch: "BR-BOM" },
  { code: "400072", city: "BOM", area: "Andheri East", branch: "BR-BOM" },
  { code: "141001", city: "LDH", area: "Ludhiana City", oda: true },
  { code: "201301", city: "NOI", area: "Noida Sector 1", branch: "HUB-DEL" },
];

const ZONES = [
  { code: "Z-NCR", name: "Delhi NCR", cities: ["DEL", "GGN", "FBD", "NOI"] },
  { code: "Z-NORTH", name: "North India", cities: ["JAI", "LDH"] },
  { code: "Z-WEST", name: "West India", cities: ["AMD", "BOM"] },
];

// Phone numbers are not decoration: notification templates print the
// handling branch's number in their footer, and a branch with none on
// file fails the render of a delivery confirmation.
const BRANCHES = [
  {
    code: "HO-DEL", name: "Head Office — Delhi", type: "HEAD_OFFICE" as const,
    city: "DEL", address: "Corporate Office, Okhla Phase III", pincode: "110020",
    phone: "01141000100",
    lat: 28.5495, lng: 77.2705, parent: null,
  },
  {
    code: "HUB-DEL", name: "Delhi Hub", type: "HUB" as const,
    city: "DEL", address: "Transport Nagar, Sanjay Gandhi Marg", pincode: "110037",
    phone: "01141000200",
    lat: 28.5562, lng: 77.1, parent: "HO-DEL",
  },
  {
    code: "HUB-JAI", name: "Jaipur Hub", type: "HUB" as const,
    city: "JAI", address: "Transport Nagar, Jaipur", pincode: "302013",
    phone: "01412000300",
    lat: 26.8505, lng: 75.7628, parent: "HO-DEL",
  },
  {
    code: "HUB-AMD", name: "Ahmedabad Hub", type: "HUB" as const,
    city: "AMD", address: "Aslali Transport Hub", pincode: "382330",
    phone: "07926000400",
    lat: 22.9445, lng: 72.6329, parent: "HO-DEL",
  },
  {
    code: "BR-GGN", name: "Gurugram Branch", type: "BRANCH" as const,
    city: "GGN", address: "Udyog Vihar Phase IV", pincode: "122015",
    phone: "01244000500",
    lat: 28.5021, lng: 77.0873, parent: "HUB-DEL",
  },
  {
    code: "BR-FBD", name: "Faridabad Branch", type: "BRANCH" as const,
    city: "FBD", address: "NIT Faridabad", pincode: "121001",
    phone: "01294000600",
    lat: 28.3838, lng: 77.3105, parent: "HUB-DEL",
  },
  {
    code: "BR-BOM", name: "Mumbai Branch", type: "BRANCH" as const,
    city: "BOM", address: "Andheri Kurla Road", pincode: "400072",
    phone: "02228000700",
    lat: 19.1136, lng: 72.8697, parent: "HUB-AMD",
  },
];

const ROUTES = [
  {
    code: "RT-DEL-JAI", name: "Delhi → Jaipur", distanceKm: 280, transitHours: 24,
    legs: [{ from: "HUB-DEL", to: "HUB-JAI", km: 280, hours: 8 }],
  },
  {
    code: "RT-DEL-AMD", name: "Delhi → Jaipur → Ahmedabad", distanceKm: 950, transitHours: 48,
    legs: [
      { from: "HUB-DEL", to: "HUB-JAI", km: 280, hours: 8 },
      { from: "HUB-JAI", to: "HUB-AMD", km: 670, hours: 16 },
    ],
  },
  {
    code: "RT-FBD-DEL", name: "Faridabad → Delhi Hub", distanceKm: 35, transitHours: 6,
    legs: [{ from: "BR-FBD", to: "HUB-DEL", km: 35, hours: 2 }],
  },
];

export async function seedNetwork(orgId: string) {
  step("states");
  const stateIds = new Map<string, string>();
  for (const s of STATES) {
    const row = await db.state.upsert({
      where: { orgId_code: { orgId, code: s.code } },
      create: { ...s, orgId },
      update: { name: s.name, gstCode: s.gstCode },
    });
    stateIds.set(s.code, row.id);
  }
  done(STATES.length);

  step("cities");
  const cityIds = new Map<string, string>();
  for (const c of CITIES) {
    const row = await db.city.upsert({
      where: { orgId_code: { orgId, code: c.code } },
      create: {
        orgId,
        code: c.code,
        name: c.name,
        stateId: stateIds.get(c.state)!,
        latitude: c.lat,
        longitude: c.lng,
        isMetro: c.metro,
      },
      update: { name: c.name, latitude: c.lat, longitude: c.lng, isMetro: c.metro },
    });
    cityIds.set(c.code, row.id);
  }
  done(CITIES.length);

  step("branches");
  const branchIds = new Map<string, string>();
  // Two passes: parents must exist before children reference them.
  for (const b of BRANCHES) {
    const row = await db.branch.upsert({
      where: { orgId_code: { orgId, code: b.code } },
      create: {
        orgId,
        code: b.code,
        name: b.name,
        type: b.type,
        cityId: cityIds.get(b.city)!,
        address: b.address,
        pincode: b.pincode,
        phone: b.phone,
        latitude: b.lat,
        longitude: b.lng,
        weeklyOffDays: [0],
      },
      update: {
        name: b.name,
        type: b.type,
        address: b.address,
        pincode: b.pincode,
        phone: b.phone,
      },
    });
    branchIds.set(b.code, row.id);
  }
  for (const b of BRANCHES.filter((x) => x.parent)) {
    await db.branch.update({
      where: { id: branchIds.get(b.code)! },
      data: { parentId: branchIds.get(b.parent!)! },
    });
  }
  done(BRANCHES.length);

  step("pincodes");
  for (const p of PINCODES) {
    await db.pincode.upsert({
      where: { orgId_code: { orgId, code: p.code } },
      create: {
        orgId,
        code: p.code,
        cityId: cityIds.get(p.city)!,
        areaName: p.area,
        isOda: p.oda ?? false,
        servingBranchId: p.branch ? branchIds.get(p.branch) : null,
      },
      update: {
        areaName: p.area,
        isOda: p.oda ?? false,
        servingBranchId: p.branch ? branchIds.get(p.branch) : null,
      },
    });
  }
  done(PINCODES.length);

  step("zones");
  for (const z of ZONES) {
    const zone = await db.zone.upsert({
      where: { orgId_code: { orgId, code: z.code } },
      create: { orgId, code: z.code, name: z.name },
      update: { name: z.name },
    });

    const pins = await db.pincode.findMany({
      where: { orgId, city: { code: { in: z.cities } } },
      select: { id: true },
    });

    await db.zonePincode.createMany({
      data: pins.map((p) => ({ orgId, zoneId: zone.id, pincodeId: p.id })),
      skipDuplicates: true,
    });
  }
  done(ZONES.length);

  step("routes");
  for (const r of ROUTES) {
    const route = await db.route.upsert({
      where: { orgId_code: { orgId, code: r.code } },
      create: {
        orgId,
        code: r.code,
        name: r.name,
        originBranchId: branchIds.get(r.legs[0].from),
        destinationBranchId: branchIds.get(r.legs[r.legs.length - 1].to),
        totalDistanceKm: r.distanceKm,
        standardTransitHours: r.transitHours,
      },
      update: { name: r.name, totalDistanceKm: r.distanceKm, standardTransitHours: r.transitHours },
    });

    await db.routeLeg.deleteMany({ where: { routeId: route.id } });
    await db.routeLeg.createMany({
      data: r.legs.map((leg, i) => ({
        orgId,
        routeId: route.id,
        sequence: i + 1,
        originBranchId: branchIds.get(leg.from)!,
        destinationBranchId: branchIds.get(leg.to)!,
        distanceKm: leg.km,
        transitHours: leg.hours,
      })),
    });
  }
  done(ROUTES.length);

  step("geofences (branch nodes)");
  let fences = 0;
  for (const b of BRANCHES) {
    const branchId = branchIds.get(b.code)!;
    const existing = await db.geofence.findFirst({ where: { orgId, branchId } });
    if (existing) {
      await db.geofence.update({
        where: { id: existing.id },
        data: { centerLat: b.lat, centerLng: b.lng, radiusMeters: 300 },
      });
    } else {
      await db.geofence.create({
        data: {
          orgId,
          name: `${b.name} — site`,
          type: "CIRCLE",
          branchId,
          centerLat: b.lat,
          centerLng: b.lng,
          radiusMeters: 300,
        },
      });
    }
    fences++;
  }
  done(fences);

  return { branchIds, cityIds };
}
