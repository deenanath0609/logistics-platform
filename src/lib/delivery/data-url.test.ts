import { describe, expect, it } from "vitest";
import { isAcceptedCaptureType, parseDataUrl } from "./data-url";

/** A one-pixel PNG, small enough to read. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("parseDataUrl", () => {
  it("accepts the formats the field app actually produces", () => {
    // The signature canvas emits `image/png`; the photo compressor emits
    // `image/jpeg`. Both must keep working.
    expect(parseDataUrl(PNG)?.contentType).toBe("image/png");
    expect(parseDataUrl("data:image/jpeg;base64,/9j/4AAQ")?.contentType).toBe(
      "image/jpeg",
    );
  });

  it("refuses SVG, which used to pass as proof of delivery", () => {
    // The gate was `startsWith("image/")`, and `image/svg+xml` starts with
    // exactly that. SVG carries `<script>`; the asset route hands the
    // stored content type back to the browser, so a signature submitted
    // this way is a stored script on the carrier's own origin for anyone
    // who opens the asset URL directly.
    const svg =
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    expect(parseDataUrl(svg)).toBeNull();
  });

  it("refuses the other markup-ish image types for the same reason", () => {
    expect(parseDataUrl("data:image/svg;base64,PHN2Zy8+")).toBeNull();
    expect(parseDataUrl("data:text/html;base64,PGI+aGk8L2I+")).toBeNull();
  });

  it("refuses anything that is not a base64 data URL at all", () => {
    expect(parseDataUrl("https://example.test/signature.png")).toBeNull();
    expect(parseDataUrl("")).toBeNull();
  });

  it("decodes to the bytes, not to the string", () => {
    expect(parseDataUrl(PNG)?.bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });
});

describe("isAcceptedCaptureType", () => {
  it("ignores casing and parameters, which a client can vary freely", () => {
    expect(isAcceptedCaptureType("IMAGE/PNG")).toBe(true);
    expect(isAcceptedCaptureType("image/jpeg; charset=binary")).toBe(true);
  });

  it("does not accept a type merely because it begins with image/", () => {
    expect(isAcceptedCaptureType("image/svg+xml")).toBe(false);
  });
});
