import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractPlaceholders,
  missingVariables,
  redactSecrets,
  renderSubject,
  renderTemplate,
  validateTemplate,
} from "./render";

/**
 * These are the cases a template author actually hits: a variable the
 * dispatcher does not supply, a variable nobody uses, the same placeholder
 * twice in one SMS, and a consignee whose company name contains an angle
 * bracket. Each one has a defined answer here so the behaviour is a
 * decision rather than whatever the regex happened to do.
 */

describe("extractPlaceholders", () => {
  it("returns each placeholder once, in first-appearance order", () => {
    const body = "Hi {{name}}, {{lrNumber}} is out. Thanks {{name}}.";
    expect(extractPlaceholders(body)).toEqual(["name", "lrNumber"]);
  });

  it("tolerates padding inside the braces", () => {
    expect(extractPlaceholders("{{ lrNumber }}")).toEqual(["lrNumber"]);
  });

  it("allows dotted names but treats them as one opaque key", () => {
    expect(extractPlaceholders("{{shipment.lrNumber}}")).toEqual([
      "shipment.lrNumber",
    ]);
  });

  it("ignores single braces and empty braces", () => {
    expect(extractPlaceholders("{name} {{}} {{ }} 100{{}}")).toEqual([]);
  });

  it("returns nothing for an empty body", () => {
    expect(extractPlaceholders("")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes a placeholder sitting inside surrounding text", () => {
    expect(
      renderTemplate("Your consignment {{lrNumber}} has been booked.", {
        lrNumber: "CL/DEL/2627/000412",
      }),
    ).toBe("Your consignment CL/DEL/2627/000412 has been booked.");
  });

  it("substitutes every occurrence of a repeated placeholder", () => {
    expect(
      renderTemplate("{{otp}} is your OTP. Do not share {{otp}}.", {
        otp: "4821",
      }),
    ).toBe("4821 is your OTP. Do not share 4821.");
  });

  it("leaves a missing variable visible rather than blanking it", () => {
    // A message with a literal {{lrNumber}} in it gets reported. A message
    // with a hole in it gets ignored for a year.
    expect(
      renderTemplate("Shipment {{lrNumber}} is out for delivery.", {}),
    ).toBe("Shipment {{lrNumber}} is out for delivery.");
  });

  it("treats null and undefined as missing, but an empty string as supplied", () => {
    expect(renderTemplate("[{{a}}][{{b}}][{{c}}]", {
      a: null,
      b: undefined,
      c: "",
    })).toBe("[{{a}}][{{b}}][]");
  });

  it("ignores an extra variable nothing references", () => {
    expect(
      renderTemplate("Booked: {{lrNumber}}", {
        lrNumber: "CL-1",
        podUrl: "https://example.test/pod/1",
      }),
    ).toBe("Booked: CL-1");
  });

  it("renders numbers and booleans", () => {
    expect(
      renderTemplate("{{count}} pkg, {{weight}} kg, fragile: {{fragile}}", {
        count: 3,
        weight: 12.5,
        fragile: true,
      }),
    ).toBe("3 pkg, 12.5 kg, fragile: true");
  });

  it("returns an empty string for an empty body", () => {
    expect(renderTemplate("", { lrNumber: "CL-1" })).toBe("");
  });

  it("does not re-scan substituted text for placeholders", () => {
    // A consignee named "{{otp}}" must not be able to reach the OTP.
    expect(
      renderTemplate("Hello {{name}}, code {{otp}}", {
        name: "{{otp}}",
        otp: "4821",
      }),
    ).toBe("Hello {{otp}}, code 4821");
  });

  it("escapes values only when asked, and never the body", () => {
    const body = "<b>Consignor</b>: {{consignor}}";
    expect(renderTemplate(body, { consignor: "A & B <Traders>" })).toBe(
      "<b>Consignor</b>: A & B <Traders>",
    );
    expect(
      renderTemplate(body, { consignor: "A & B <Traders>" }, { escape: "html" }),
    ).toBe("<b>Consignor</b>: A &amp; B &lt;Traders&gt;");
  });
});

describe("renderSubject", () => {
  it("escapes HTML-unsafe values", () => {
    expect(
      renderSubject("POD for {{consignor}}", {
        consignor: `Sharma & Sons <script>alert('x')</script>`,
      }),
    ).toBe(
      "POD for Sharma &amp; Sons &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
  });

  it("flattens a newline in a value, which would otherwise be header injection", () => {
    const injected = "Acme\r\nBcc: everyone@example.test";
    expect(renderSubject("Invoice for {{customer}}", { customer: injected })).toBe(
      "Invoice for Acme Bcc: everyone@example.test",
    );
    expect(renderSubject("Invoice for {{customer}}", { customer: injected })).not.toContain(
      "\n",
    );
  });

  it("collapses tabs and runs of whitespace to one space", () => {
    expect(renderSubject("A\t\t{{x}}   B", { x: "  y  " })).toBe("A y B");
  });

  it("still leaves a missing variable visible", () => {
    expect(renderSubject("POD for {{consignor}}", {})).toBe(
      "POD for {{consignor}}",
    );
  });
});

describe("missingVariables", () => {
  it("names only the placeholders the map cannot fill", () => {
    expect(
      missingVariables("{{a}} {{b}} {{a}} {{c}}", { a: "1", c: null }),
    ).toEqual(["b", "c"]);
  });

  it("is empty when everything is supplied", () => {
    expect(missingVariables("{{a}}", { a: "" })).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("passes when the body and the declared list agree", () => {
    expect(
      validateTemplate("Hi {{name}}, {{lrNumber}} booked.", [
        "name",
        "lrNumber",
      ]),
    ).toEqual({ ok: true, unknown: [], unused: [] });
  });

  it("reports a placeholder nothing declares", () => {
    const result = validateTemplate("Hi {{name}}, OTP {{otp}}", ["name"]);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(["otp"]);
    expect(result.unused).toEqual([]);
  });

  it("reports a declared variable the body never uses, without failing", () => {
    // Usually a half-finished rename. Worth showing, not worth blocking.
    const result = validateTemplate("Hi {{name}}", ["name", "podUrl"]);
    expect(result.ok).toBe(true);
    expect(result.unused).toEqual(["podUrl"]);
  });

  it("counts a repeated placeholder once", () => {
    expect(validateTemplate("{{otp}}/{{otp}}", []).unknown).toEqual(["otp"]);
  });

  it("treats an empty body as valid, with everything declared unused", () => {
    expect(validateTemplate("", ["a", "b"])).toEqual({
      ok: true,
      unknown: [],
      unused: ["a", "b"],
    });
  });
});

describe("escapeHtml", () => {
  it("escapes the ampersand first so nothing is double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("covers both quote characters", () => {
    expect(escapeHtml(`"a" 'b'`)).toBe("&quot;a&quot; &#39;b&#39;");
  });
});

describe("redactSecrets", () => {
  const secrets = new Set(["otpCode"]);

  it("replaces a secret's value without touching anything else", () => {
    expect(
      redactSecrets({ otpCode: "4821", lrNumber: "CL/001" }, secrets),
    ).toEqual({ otpCode: "••••", lrNumber: "CL/001" });
  });

  it("does not invent a value for a secret that has none", () => {
    // A redacted render has to report the same missing placeholders as the
    // real one, or the log row would say the message went out when the
    // dispatcher refused it.
    expect(redactSecrets({ otpCode: null }, secrets)).toEqual({ otpCode: null });
    expect(redactSecrets({}, secrets)).toEqual({});
  });

  it("renders a body that cannot carry the code", () => {
    const body = "{{otpCode}} is your code for {{lrNumber}}.";
    const rendered = renderTemplate(
      body,
      redactSecrets({ otpCode: "4821", lrNumber: "CL/001" }, secrets),
    );
    expect(rendered).not.toContain("4821");
    expect(rendered).toContain("CL/001");
  });
});
