import { describe, expect, it } from "vitest";
import type { ShipmentStatus } from "@/generated/prisma/client";
import { MODULES } from "@/lib/modules/modules";
import { moduleForRoute } from "@/lib/modules/registry";
import { PERMISSION_CODES } from "@/lib/rbac/permissions";
import { STATUS_LABELS } from "@/lib/shipment/state-machine";
import { arrivalsAt, COMMON_JOBS, JOURNEY } from "@/lib/help/staff";

/**
 * The help screen makes two promises the compiler cannot keep for it: that
 * it lists every status the product can put a consignment in, and that its
 * links go somewhere. Both rot silently — a status added to the machine
 * simply stops being explained, and a screen moved leaves a dead link on
 * the one page people open when they are already lost.
 */

const ALL_STATUSES = Object.keys(STATUS_LABELS) as ShipmentStatus[];

describe("the journey covers the machine", () => {
  it("places every status in exactly one stage", () => {
    const placed = JOURNEY.flatMap((stage) => stage.statuses);
    expect([...placed].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("finds the statuses at all", () => {
    // A broken read of the label map would make the assertion above
    // vacuously true on both sides.
    expect(ALL_STATUSES.length).toBeGreaterThan(15);
    expect(ALL_STATUSES).toContain("OUT_FOR_DELIVERY");
  });
});

describe("arrivalsAt speaks the machine's own words", () => {
  it("resolves the one conditional target both ways", () => {
    // A single event — an inbound scan — lands on two different statuses
    // depending on where it happened, and the help page has to say so on
    // both rows.
    expect(arrivalsAt("RECEIVED_AT_ORIGIN")).toEqual(["Received"]);
    expect(arrivalsAt("RECEIVED_AT_HUB")).toContain("Received");
  });

  it("reports the statuses no transition reaches", () => {
    // Only a status correction can produce these. Saying nothing arrives
    // here is the truth, and the page renders it as such.
    expect(arrivalsAt("LOST")).toEqual([]);
    expect(arrivalsAt("RTO_IN_TRANSIT")).toEqual([]);
    expect(arrivalsAt("RTO_DELIVERED")).toEqual([]);
  });

  it("gives an ordinary status the describe from its own rule", () => {
    expect(arrivalsAt("DELIVERED")).toEqual(["Delivered"]);
    expect(arrivalsAt("PROCESSED")).toContain("Sorted and routed");
  });
});

describe("every link and permission is real", () => {
  const links = [
    ...JOURNEY.map((stage) => ({ href: stage.href, permission: stage.permission })),
    ...COMMON_JOBS.map((job) => ({ href: job.href, permission: job.permission })),
  ];

  it("points at a path some module claims", () => {
    // A path no module claims is either a typo or an ungated screen, and
    // `moduleForRoute` returning null is how both look from here.
    const unclaimed = links
      .map((link) => link.href)
      .filter((href) => moduleForRoute(href, MODULES) === null);
    expect(unclaimed).toEqual([]);
  });

  it("names only permissions in the catalogue", () => {
    const unknown = links
      .map((link) => link.permission)
      .filter((code) => !PERMISSION_CODES.includes(code));
    expect(unknown).toEqual([]);
  });
});
