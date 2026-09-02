/**
 * Masking for recipients.
 *
 * A send log is read by branch staff and exported to spreadsheets that
 * leave the building. It has to answer "did we message this consignee",
 * which needs enough of the number to recognise, and not "here is the
 * customer list", which needs the rest of it gone.
 *
 * Pure — no imports, safe to use from a client component.
 */

/**
 * `9876543210` becomes `98•••43210` — enough to confirm, not to dial.
 *
 * Two digits from the front and five from the back, but never so many that
 * they meet: the head and the tail used to be taken independently, so a
 * seven-character value returned `98•76543` — every character of it, with a
 * bullet in the middle for decoration. Ten-digit Indian mobiles were fine;
 * a landline with an STD code written short, or a number typed with the
 * last digit missing, was published in full. Whatever the length, at least
 * `HIDDEN_MIN` characters are gone, and a value too short to hide that many
 * is not shown at all.
 */
const HIDDEN_MIN = 3;

export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  const budget = trimmed.length - HIDDEN_MIN;
  if (budget < 3) return "•".repeat(trimmed.length);

  const head = Math.min(2, budget - 1);
  const tail = Math.min(5, budget - head);
  const hidden = trimmed.length - head - tail;

  return `${trimmed.slice(0, head)}${"•".repeat(hidden)}${trimmed.slice(trimmed.length - tail)}`;
}

/** `priya.sharma@acme.co.in` becomes `pr••••••@acme.co.in`. */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return maskPhone(trimmed);

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const keep = local.length <= 2 ? 1 : 2;

  return `${local.slice(0, keep)}${"•".repeat(Math.max(2, local.length - keep))}${domain}`;
}

/** Picks the right mask by looking at the value, not at a channel column. */
export function maskRecipient(recipient: string): string {
  return recipient.includes("@") ? maskEmail(recipient) : maskPhone(recipient);
}
