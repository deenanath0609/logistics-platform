import { cn } from "@/lib/utils";
import type { ModuleKey } from "@/lib/modules/registry";
import {
  moduleDefinition,
  type BlockedModule,
} from "@/lib/platform/plan-modules";

/**
 * Modules, at a glance.
 *
 * Three tones for three different facts, because a comma-joined string
 * made all three look identical: granted is neutral, a module listed but
 * withheld for a missing prerequisite is amber because somebody sold
 * something that is not being delivered, and a leftover free-text value is
 * red because it is a data fix rather than a configuration choice.
 *
 * Plain spans rather than the `Badge` component: these render inside
 * server components, and `Badge` is built on `useRender`.
 */

function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: "granted" | "blocked" | "unknown";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-medium",
        tone === "granted" && "bg-accent text-accent-foreground",
        tone === "blocked" && "bg-warn-muted text-warn",
        tone === "unknown" && "bg-bad-muted font-mono text-bad",
      )}
    >
      {children}
    </span>
  );
}

export function ModuleChips({
  granted,
  blocked = [],
  unrecognised = [],
  emptyText = "—",
  className,
}: {
  granted: ModuleKey[];
  blocked?: BlockedModule[];
  unrecognised?: string[];
  emptyText?: string;
  className?: string;
}) {
  const nothing =
    granted.length === 0 && blocked.length === 0 && unrecognised.length === 0;
  if (nothing) {
    return <span className="text-xs text-muted-foreground">{emptyText}</span>;
  }

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {granted.map((key) => (
        <Chip key={key} tone="granted" title={moduleDefinition(key)?.description}>
          {moduleDefinition(key)?.label ?? key}
        </Chip>
      ))}
      {blocked.map((item) => (
        <Chip
          key={item.key}
          tone="blocked"
          title="Listed on the plan, but not granted — a prerequisite is missing."
        >
          {moduleDefinition(item.key)?.label ?? item.key} · blocked
        </Chip>
      ))}
      {unrecognised.map((value) => (
        <Chip key={value} tone="unknown" title="Not a module. Grants nothing.">
          {value} · unknown
        </Chip>
      ))}
    </div>
  );
}
