/**
 * The tenant's logo at the top of a printed document.
 *
 * Deliberately without the truck `TenantMark` falls back to. Inside the app
 * a generic mark is fine — the carrier's own staff know whose screen they
 * are looking at. On paper the reader is a consignee or an accounts clerk
 * who has never heard of us, and a mark the carrier did not choose is our
 * brand on their letterhead. No logo therefore means no image, and the
 * masthead's own name line is the fallback (ADR 001 §3).
 *
 * The mastheads themselves are not shared: an invoice leads with the legal
 * name and carries PAN and CIN, an LR leads with the trading name and the
 * booking branch, and a POD with the delivering branch. Only the mark is
 * genuinely one thing across all four.
 */
export function DocumentLogo({
  src,
  name,
}: {
  src: string | null;
  name: string;
}) {
  if (!src) return null;

  return (
    // A plain <img>: the URL is tenant-supplied and may point anywhere,
    // which next/image cannot optimise without every tenant's host
    // configured at build time. `alt` is the carrier's name so a logo that
    // fails to fetch still prints something true.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      className="mb-2 h-12 w-auto max-w-[13rem] object-contain"
    />
  );
}
