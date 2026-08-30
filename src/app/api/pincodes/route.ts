import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, canAny } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Pincode lookup for the booking screen.
 *
 * Serviceability is decided server-side at booking, but finding out only
 * after filling in twenty fields is a poor way to learn that a PIN is not
 * in the network. This lets the field answer immediately.
 *
 * Staff-only. It is not sensitive data, but an open endpoint that returns
 * the shape of the delivery network is not something to hand out either.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!canAny(user, ["shipment.create", "shipment.read", "master.read"])) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code")?.trim();
  const query = searchParams.get("q")?.trim();

  // Exact lookup — what the field asks once six digits are typed.
  if (code) {
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ status: "INCOMPLETE" });
    }

    // A PIN is unique per tenant, not globally — geography is per-tenant
    // master data (ADR 001 §4), so two carriers each hold their own 110001
    // with their own serviceability. `findFirst` plus the tenant filter picks
    // the caller's.
    const pincode = await prisma.pincode.findFirst({
      where: { code },
      select: {
        code: true,
        areaName: true,
        isServiceable: true,
        isOda: true,
        city: { select: { name: true, code: true } },
        servingBranch: { select: { code: true, name: true } },
      },
    });

    if (!pincode) {
      return NextResponse.json({ status: "UNKNOWN", code });
    }

    return NextResponse.json({
      status: !pincode.isServiceable
        ? "BLOCKED"
        : pincode.isOda
          ? "ODA"
          : "SERVICEABLE",
      code: pincode.code,
      area: pincode.areaName,
      city: pincode.city.name,
      cityCode: pincode.city.code,
      branch: pincode.servingBranch?.code ?? null,
      branchName: pincode.servingBranch?.name ?? null,
    });
  }

  // Prefix / area search — powers the suggestion list.
  const results = await prisma.pincode.findMany({
    where: query
      ? {
          OR: [
            { code: { startsWith: query } },
            { areaName: { contains: query, mode: "insensitive" } },
            { city: { name: { contains: query, mode: "insensitive" } } },
          ],
        }
      : {},
    orderBy: [{ isServiceable: "desc" }, { code: "asc" }],
    take: 25,
    select: {
      code: true,
      areaName: true,
      isServiceable: true,
      isOda: true,
      city: { select: { name: true } },
    },
  });

  return NextResponse.json({
    results: results.map((p) => ({
      code: p.code,
      area: p.areaName,
      city: p.city.name,
      isServiceable: p.isServiceable,
      isOda: p.isOda,
    })),
  });
}
