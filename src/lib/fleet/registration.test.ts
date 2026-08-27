import { describe, expect, it } from "vitest";
import {
  formatRegistration,
  isPlausibleRegistration,
  normaliseRegistration,
} from "./registration";

describe("normaliseRegistration", () => {
  it("collapses the six ways a clerk writes the same plate to one", () => {
    for (const written of [
      "HR 26 AB 1234",
      "HR-26-AB-1234",
      "hr26ab1234",
      " HR26 AB1234 ",
      "HR.26.AB.1234",
    ]) {
      expect(normaliseRegistration(written)).toBe("HR26AB1234");
    }
  });

  it("leaves an already-normalised value alone", () => {
    expect(normaliseRegistration("HR26AB1234")).toBe("HR26AB1234");
  });

  it("returns an empty string for punctuation only", () => {
    expect(normaliseRegistration(" -- ")).toBe("");
  });
});

describe("formatRegistration", () => {
  it("groups a standard plate into readable blocks", () => {
    expect(formatRegistration("HR26AB1234")).toBe("HR 26 AB 1234");
    expect(formatRegistration("DL1CAB1234")).toBe("DL 1 CAB 1234");
  });

  it("handles a plate with no letter series", () => {
    expect(formatRegistration("HR261234")).toBe("HR 26 1234");
  });

  it("groups a Bharat-series plate", () => {
    expect(formatRegistration("22BH1234AB")).toBe("22 BH 1234 AB");
  });

  it("normalises before formatting, so input shape does not matter", () => {
    expect(formatRegistration("hr-26-ab-1234")).toBe("HR 26 AB 1234");
  });

  it("returns an unrecognised plate unchanged rather than mangling it", () => {
    expect(formatRegistration("94A123456K")).toBe("94A123456K");
  });

  it("round-trips: formatting then normalising is the identity", () => {
    for (const stored of ["HR26AB1234", "DL1CAB1234", "22BH1234AB"]) {
      expect(normaliseRegistration(formatRegistration(stored))).toBe(stored);
    }
  });
});

describe("isPlausibleRegistration", () => {
  it("accepts real plate shapes, including non-standard ones", () => {
    expect(isPlausibleRegistration("HR 26 AB 1234")).toBe(true);
    expect(isPlausibleRegistration("22BH1234AB")).toBe(true);
    expect(isPlausibleRegistration("94A123456K")).toBe(true);
  });

  it("rejects obvious nonsense", () => {
    expect(isPlausibleRegistration("")).toBe(false);
    expect(isPlausibleRegistration("HR26")).toBe(false);
    expect(isPlausibleRegistration("ABCDEFGH")).toBe(false);
    expect(isPlausibleRegistration("12345678")).toBe(false);
    expect(isPlausibleRegistration("HR26AB1234HR26AB1234")).toBe(false);
  });
});
