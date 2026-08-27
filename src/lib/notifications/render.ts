/**
 * Template rendering.
 *
 * Pure, with no database and no environment: the same body and the same
 * variables always produce the same text. That is what makes the template
 * editor able to show an operator exactly what will go out, and what makes
 * a support question about a message sent in March answerable in June.
 *
 * The placeholder syntax is `{{name}}`. Dots are allowed so a template can
 * read `{{shipment.lrNumber}}`, but nothing is resolved through them — the
 * whole dotted string is one key. Resolution by path would let a template
 * author reach into an object the dispatcher did not mean to expose.
 */

export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateVariables = Record<string, TemplateValue>;

/**
 * Matches `{{name}}` with optional inner padding.
 *
 * Global regexes carry `lastIndex` between calls, so this is a factory
 * rather than a shared constant — sharing one caused every second call to
 * start halfway through the body.
 */
function placeholderPattern(): RegExp {
  return /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
}

export type RenderOptions = {
  /**
   * Escaping applied to substituted values, never to the template body.
   * The body is authored by staff; the values come from consignee names
   * and remarks, which is where the angle bracket will come from.
   */
  escape?: "none" | "html";
  /**
   * Collapses newlines and control characters in the result. Required for
   * anything that becomes a mail header — a newline in a subject line is
   * header injection, not a formatting quirk.
   */
  singleLine?: boolean;
};

/** Every distinct placeholder in the body, in the order it first appears. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const pattern = placeholderPattern();

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) seen.add(match[1]);

  return [...seen];
}

/** True when the variable map supplies a usable value for this key. */
function supplied(variables: TemplateVariables, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(variables, key)) return false;
  const value = variables[key];
  // An empty string is a decision — "no landmark" renders as nothing. Null
  // and undefined are an omission, and omissions stay visible.
  return value !== null && value !== undefined;
}

/**
 * Substitutes `{{placeholders}}`.
 *
 * A placeholder with no value is left standing rather than blanked. A
 * message reading "Your shipment {{lrNumber}} is out for delivery" is
 * wrong in a way somebody will report; "Your shipment  is out for
 * delivery" is wrong in a way that gets ignored for a year.
 */
export function renderTemplate(
  body: string,
  variables: TemplateVariables,
  options: RenderOptions = {},
): string {
  const rendered = body.replace(
    placeholderPattern(),
    (whole, key: string) => {
      if (!supplied(variables, key)) return whole;
      const value = String(variables[key]);
      return options.escape === "html" ? escapeHtml(value) : value;
    },
  );

  return options.singleLine ? collapseToSingleLine(rendered) : rendered;
}

/**
 * An email subject.
 *
 * Values are escaped and the result is flattened to one line, because a
 * subject is a header: a consignee company name someone pasted a newline
 * into would otherwise let the rest of the header block be rewritten.
 */
export function renderSubject(
  subject: string,
  variables: TemplateVariables,
): string {
  return renderTemplate(subject, variables, {
    escape: "html",
    singleLine: true,
  });
}

/** Placeholders in the body that this variable map cannot fill. */
export function missingVariables(
  body: string,
  variables: TemplateVariables,
): string[] {
  return extractPlaceholders(body).filter((key) => !supplied(variables, key));
}

export type TemplateValidation = {
  ok: boolean;
  /** Used in the body but not declared — the send will render literally. */
  unknown: string[];
  /** Declared but never used — usually a rename that was half finished. */
  unused: string[];
};

/**
 * Checks a template against the variables it says it needs.
 *
 * Run on save, not on send. A template referencing `{{otpCode}}` that
 * nothing supplies should be caught by the person editing it, not by a
 * consignee reading the literal braces at their front door.
 */
export function validateTemplate(
  body: string,
  declaredVariables: readonly string[],
): TemplateValidation {
  const used = extractPlaceholders(body);
  const declared = new Set(declaredVariables);
  const usedSet = new Set(used);

  const unknown = used.filter((key) => !declared.has(key));
  const unused = [...declared].filter((key) => !usedSet.has(key));

  return { ok: unknown.length === 0, unknown, unused };
}

/**
 * HTML escaping for substituted values.
 *
 * Includes the single quote, which matters for attribute contexts, and
 * escapes the ampersand first so already-escaped output is not produced
 * twice over.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Newlines, tabs and other control characters collapse to single spaces.
 *
 * Written as a scan rather than a regex because the interesting characters
 * here are the invisible ones, and a character class full of escapes is the
 * kind of line that gets "tidied" into something subtly different.
 */
function collapseToSingleLine(value: string): string {
  let out = "";
  let pendingSpace = false;

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls, space itself, and DEL.
    if (code <= 0x20 || code === 0x7f) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }

  return out;
}
