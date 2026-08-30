import Link from "next/link";
import { Truck } from "lucide-react";

/**
 * The tenant's mark, wherever the product used to print its own.
 *
 * A tenant that has uploaded a logo gets it; one that has not gets the
 * same square-and-truck the product has always used, tinted with their
 * primary colour. Falling back to a generic mark rather than ours is
 * deliberate — a white-label product should never show a carrier's staff
 * somebody else's brand.
 */
export function TenantMark({
  name,
  logoUrl,
  href,
  className,
  showName = true,
}: {
  name: string;
  logoUrl?: string | null;
  href?: string;
  className?: string;
  showName?: boolean;
}) {
  const mark = (
    <>
      {logoUrl ? (
        // Deliberately a plain <img>: the URL is tenant-supplied and may
        // point anywhere, which next/image cannot optimise without every
        // tenant's host being configured at build time.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-7 rounded-md object-contain" />
      ) : (
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Truck className="size-4" />
        </span>
      )}
      {showName && <span className="font-semibold tracking-tight">{name}</span>}
    </>
  );

  if (!href) {
    return <span className={className ?? "flex items-center gap-2.5"}>{mark}</span>;
  }

  return (
    <Link href={href} className={className ?? "flex items-center gap-2.5"}>
      {mark}
    </Link>
  );
}
