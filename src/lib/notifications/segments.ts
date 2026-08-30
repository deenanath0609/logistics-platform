/**
 * How many SMS segments a body costs.
 *
 * Its own module, and deliberately pure: the template editor is a client
 * component and needs this to warn an author before they save. It used to
 * live in `channels/mock.ts`, which was harmless until that file grew an
 * import of the carrier lookup — and with it the Prisma client, `pg`, and
 * `node:dns`, none of which exist in a browser. The whole templates screen
 * stopped building.
 *
 * The rule this file exists to hold: anything a client component imports
 * must reach nothing that touches the database.
 *
 * GSM-7 counts 160 characters per segment and 153 in a concatenated one.
 * Anything outside that alphabet drops the message to UCS-2 at 70/67.
 * Approximate, but close enough to make a template that quietly costs three
 * segments visible before the first invoice does.
 */
const GSM_7 =
  /^[\r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\[\]~|€\\]*$/;

export function segmentsFor(body: string): number {
  const unicode = !GSM_7.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;

  if (body.length === 0) return 1;
  if (body.length <= single) return 1;
  return Math.ceil(body.length / multi);
}
