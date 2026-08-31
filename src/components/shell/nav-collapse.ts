/**
 * Remembering which sidebar sections a person has folded away.
 *
 * The store is `localStorage`, keyed per origin — which is per carrier,
 * because each carrier is its own subdomain. Every read is defensive: a
 * browser with storage blocked, or a key someone has hand-edited into
 * nonsense, has to end with a usable menu rather than an exception, and the
 * safe answer is always "show everything".
 *
 * What is stored is the set of *collapsed* sections rather than the open
 * ones, so that a section added to `nav.ts` later arrives expanded for
 * people who already have a preference saved.
 */

export const NAV_COLLAPSE_KEY = "citylogistics.nav.collapsed";

/**
 * The collapsed set is mirrored onto `<html>` as a space-separated list, and
 * a `~=` attribute selector is what actually hides each section. That is the
 * one mechanism that can be in place before React hydrates, which is what
 * keeps a remembered section from flashing open on the first paint.
 */
export const NAV_COLLAPSE_ATTRIBUTE = "data-nav-collapsed";

/**
 * A section is identified by its label, slugged, rather than by its position
 * — reordering `NAV` must not silently fold away somebody's other sections.
 */
export function sectionId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Anything that is not an array of strings is treated as no preference. */
export function parseCollapsed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Safari in private mode and any browser with site data blocked throw on the
 * `localStorage` getter itself, not merely on `getItem` — hence the try
 * around the access rather than around the call.
 */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readCollapsed(store: Storage | null = storage()): string[] {
  if (!store) return [];
  try {
    return parseCollapsed(store.getItem(NAV_COLLAPSE_KEY));
  } catch {
    return [];
  }
}

/** Failing to remember is not worth breaking the click over. */
export function writeCollapsed(
  ids: Iterable<string>,
  store: Storage | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...ids]));
  } catch {
    /* Quota exceeded, or storage denied. The menu still works. */
  }
}

/**
 * A store, rather than component state, for two reasons. The sidebar and the
 * sheet render the nav twice and have to agree; and `useSyncExternalStore`
 * is the one way to read `localStorage` without the server and the client
 * disagreeing about the first render — React hydrates from the server
 * snapshot and swaps in the real one afterwards, on its own terms.
 *
 * The value lives in memory and is only *persisted* to storage, so a browser
 * that refuses to remember anything still gets sections that open and close
 * for the length of the visit.
 */
const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let current: readonly string[] | null = null;

export function subscribeCollapsed(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);

  // The same carrier open in a second tab is a change like any other.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== NAV_COLLAPSE_KEY) return;
    current = readCollapsed();
    onStoreChange();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    listeners.delete(onStoreChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/**
 * Referentially stable between changes, which `useSyncExternalStore`
 * requires — a fresh array every call is an infinite render loop.
 */
export function collapsedSnapshot(): readonly string[] {
  current ??= readCollapsed();
  return current;
}

/** Nothing is collapsed as far as the server is concerned. See above. */
export function collapsedServerSnapshot(): readonly string[] {
  return EMPTY;
}

export function setCollapsedSections(ids: Iterable<string>): void {
  current = [...ids];
  writeCollapsed(current);
  for (const listener of listeners) listener();
}

/** Test seam; the store is module state and would otherwise leak between cases. */
export function resetCollapsedStore(): void {
  current = null;
  listeners.clear();
}

/**
 * The section holding the current page is never hidden, however it was left
 * — otherwise a link the person just followed disappears underneath them.
 * The preference itself is kept, so the section folds away again once they
 * navigate elsewhere.
 */
export function collapsedAttributeValue(
  ids: Iterable<string>,
  activeId: string | null,
): string {
  return [...ids].filter((id) => id !== activeId).join(" ");
}

/**
 * Reads the store rather than taking a rendered value, because the one place
 * this must not be called with is React's *first* value: during hydration
 * that is the server snapshot, and writing it would undo the init script and
 * flash every section open for a frame.
 */
export function syncCollapsedAttribute(activeId: string | null): void {
  if (typeof document === "undefined") return;
  const value = collapsedAttributeValue(collapsedSnapshot(), activeId);
  if (value) {
    document.documentElement.setAttribute(NAV_COLLAPSE_ATTRIBUTE, value);
  } else {
    document.documentElement.removeAttribute(NAV_COLLAPSE_ATTRIBUTE);
  }
}

/**
 * One rule per section, rather than a single `[data-nav-panel]` rule, because
 * the selector has to name the section on `<html>` and on the panel at once.
 * Emitted by the nav itself so it lives and dies with the nav; a value left
 * on `<html>` after the shell unmounts matches nothing.
 */
export function collapseStyles(ids: readonly string[]): string {
  return ids
    .map(
      (id) =>
        `html[${NAV_COLLAPSE_ATTRIBUTE}~="${id}"] [data-nav-panel="${id}"]{display:none}` +
        `html[${NAV_COLLAPSE_ATTRIBUTE}~="${id}"] [data-nav-section="${id}"] [data-nav-chevron]{rotate:-90deg}`,
    )
    .join("");
}

/**
 * Runs while the document is still parsing, ahead of the sections it affects,
 * so the remembered state is on `<html>` before anything is painted. What it
 * sets is an attribute React never renders, which the root layout already
 * tolerates: `<html>` there carries `suppressHydrationWarning`.
 */
export function collapseInitScript(activeId: string | null): string {
  return (
    `(function(){try{` +
    `var s=localStorage.getItem(${JSON.stringify(NAV_COLLAPSE_KEY)});if(!s)return;` +
    `var c=JSON.parse(s);if(!Array.isArray(c))return;` +
    `var a=${JSON.stringify(activeId)};` +
    `var v=c.filter(function(x){return typeof x==="string"&&x!==a}).join(" ");` +
    `if(v)document.documentElement.setAttribute(${JSON.stringify(NAV_COLLAPSE_ATTRIBUTE)},v);` +
    `}catch(e){}})()`
  );
}
