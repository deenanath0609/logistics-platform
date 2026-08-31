import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL } from "@/lib/complaints/workflow";
import { CUSTOMER_STATUS_LABELS } from "@/lib/shipment/state-machine";
import { complaintNotes, customerStatusNotes } from "@/lib/help/portal";

/**
 * The customer-facing vocabulary is not ours to invent, and the two places
 * it can rot are both here: a label the portal shows but this page never
 * explains, and a complaint window quoted at a figure the SLA table no
 * longer uses.
 */

describe("every label a customer can be shown is explained", () => {
  const shown = new Set(
    Object.values(CUSTOMER_STATUS_LABELS).filter(
      (label): label is string => typeof label === "string" && label.length > 0,
    ),
  );

  it("finds the labels at all", () => {
    expect(shown.size).toBeGreaterThan(8);
    expect(shown).toContain("In transit");
  });

  it("lists each one exactly once", () => {
    const notes = customerStatusNotes();
    expect(notes.map((note) => note.label).sort()).toEqual([...shown].sort());
  });

  it("gives each one a meaning", () => {
    const silent = customerStatusNotes().filter(
      (note) => note.meaning.trim().length === 0,
    );
    expect(silent.map((note) => note.label)).toEqual([]);
  });

  it("takes the tone of the last status carrying the label", () => {
    // "In transit" is worn by a consignment sitting at a branch and by one
    // on the road. The legend should read as the road.
    const inTransit = customerStatusNotes().find(
      (note) => note.label === "In transit",
    );
    expect(inTransit?.tone).toBe("moving");
  });
});

describe("complaint windows come from the SLA table", () => {
  const notes = complaintNotes();

  it("covers every category the desk offers", () => {
    expect(notes.map((note) => note.label).sort()).toEqual(
      Object.values(CATEGORY_LABEL).sort(),
    );
  });

  it("puts the fastest reply first", () => {
    const hours = notes.map((note) => note.responseHours);
    expect([...hours].sort((a, b) => a - b)).toEqual(hours);
    // A missing consignment has somebody standing next to an empty space.
    expect(notes[0].responseHours).toBe(2);
  });
});
