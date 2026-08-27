/**
 * Vehicle registration numbers.
 *
 * The same truck is written down six different ways — "HR 26 AB 1234",
 * "HR-26-AB-1234", "hr26ab1234" — by six different clerks. Storing the
 * stripped, uppercased form is what makes the unique constraint on
 * `Vehicle.registrationNumber` mean anything, and what makes a search for
 * "26ab" find the vehicle regardless of how it was typed in.
 *
 * Display is the mirror image: nobody reads HR26AB1234 comfortably, so the
 * UI puts the spaces back. Storage form and reading form are different
 * things and this module is the only place that knows both.
 */

/** Strip everything that is not a letter or a digit, then uppercase. */
export function normaliseRegistration(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Standard Indian plate: two-letter state, one or two digit RTO, an
 * optional series of up to three letters, then four digits.
 */
const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})?(\d{4})$/;

/** Bharat series: two-digit year, "BH", four digits, one or two letters. */
const BHARAT = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;

/**
 * Groups a stored registration back into readable blocks.
 *
 * Anything that does not match a known plate layout is returned unchanged
 * rather than mangled — defence, diplomatic and temporary plates are real
 * and a display helper has no business rejecting them.
 */
export function formatRegistration(stored: string): string {
  const value = normaliseRegistration(stored);

  const standard = STANDARD.exec(value);
  if (standard) {
    return [standard[1], standard[2], standard[3], standard[4]]
      .filter(Boolean)
      .join(" ");
  }

  const bharat = BHARAT.exec(value);
  if (bharat) {
    return `${bharat[1]} ${bharat[2]} ${bharat[3]} ${bharat[4]}`;
  }

  return value;
}

/**
 * A deliberately loose sanity check.
 *
 * Rejecting anything that is not a standard plate would lock out the
 * attached and vendor vehicles this platform exists to handle, so this only
 * catches obvious nonsense: too short, too long, or all letters / all digits.
 */
export function isPlausibleRegistration(raw: string): boolean {
  const value = normaliseRegistration(raw);
  if (value.length < 5 || value.length > 15) return false;
  if (!/\d/.test(value)) return false;
  if (!/[A-Z]/.test(value)) return false;
  return true;
}
