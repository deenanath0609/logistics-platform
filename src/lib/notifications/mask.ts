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

/** `9876543210` becomes `98•••43210` — enough to confirm, not to dial. */
export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length < 6) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"•".repeat(Math.max(1, trimmed.length - 7))}${trimmed.slice(-5)}`;
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
