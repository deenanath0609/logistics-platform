import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV } from "@/components/shell/nav";
import {
  NAV_COLLAPSE_ATTRIBUTE,
  NAV_COLLAPSE_KEY,
  collapseInitScript,
  collapseStyles,
  collapsedAttributeValue,
  collapsedServerSnapshot,
  collapsedSnapshot,
  parseCollapsed,
  readCollapsed,
  resetCollapsedStore,
  sectionId,
  setCollapsedSections,
  subscribeCollapsed,
  writeCollapsed,
} from "@/components/shell/nav-collapse";

/**
 * A minimal `Storage` that can be told to fail, because the interesting
 * cases here are the ones where the browser refuses to cooperate: private
 * windows and blocked site data throw rather than return null.
 */
function fakeStorage(options: { throws?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  const guard = () => {
    if (options.throws) throw new DOMException("denied", "SecurityError");
  };
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => {
      guard();
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      guard();
      map.set(key, value);
    },
    removeItem: (key) => {
      guard();
      map.delete(key);
    },
  } satisfies Storage;
}

describe("sectionId", () => {
  it("slugs a group label", () => {
    expect(sectionId("Control tower")).toBe("control-tower");
    expect(sectionId("Customer care")).toBe("customer-care");
    expect(sectionId("Branches & hubs")).toBe("branches-hubs");
  });

  /**
   * Section identity is what the stored preference is keyed on, so two
   * groups sharing an id would fold away together.
   */
  it("gives every nav group its own identity", () => {
    const ids = NAV.map((group) => sectionId(group.label));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });
});

describe("parseCollapsed", () => {
  it("reads a stored list", () => {
    expect(parseCollapsed('["hub","finance"]')).toEqual(["hub", "finance"]);
  });

  it("falls back to everything open on anything unexpected", () => {
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed("")).toEqual([]);
    expect(parseCollapsed("not json")).toEqual([]);
    expect(parseCollapsed('{"hub":true}')).toEqual([]);
    expect(parseCollapsed("null")).toEqual([]);
  });

  it("drops entries that are not section ids", () => {
    expect(parseCollapsed('["hub",7,null,{"a":1},"fleet"]')).toEqual([
      "hub",
      "fleet",
    ]);
  });
});

describe("readCollapsed / writeCollapsed", () => {
  it("round-trips through storage", () => {
    const store = fakeStorage();
    writeCollapsed(new Set(["hub", "masters"]), store);
    expect(store.getItem(NAV_COLLAPSE_KEY)).toBe('["hub","masters"]');
    expect(readCollapsed(store)).toEqual(["hub", "masters"]);
  });

  it("survives a browser that refuses storage", () => {
    const store = fakeStorage({ throws: true });
    expect(readCollapsed(store)).toEqual([]);
    expect(() => writeCollapsed(["hub"], store)).not.toThrow();
  });

  it("treats no storage at all as no preference", () => {
    expect(readCollapsed(null)).toEqual([]);
    expect(() => writeCollapsed(["hub"], null)).not.toThrow();
  });
});

describe("the collapsed store", () => {
  afterEach(() => resetCollapsedStore());

  it("starts every section open for the server", () => {
    expect(collapsedServerSnapshot()).toEqual([]);
  });

  /** `useSyncExternalStore` loops forever on a snapshot that is a new array. */
  it("hands out the same snapshot until something changes", () => {
    const first = collapsedSnapshot();
    expect(collapsedSnapshot()).toBe(first);

    setCollapsedSections(["hub"]);
    expect(collapsedSnapshot()).not.toBe(first);
    expect(collapsedSnapshot()).toEqual(["hub"]);
  });

  it("tells every nav on the page, so the sheet and the sidebar agree", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCollapsed(listener);

    setCollapsedSections(["hub"]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setCollapsedSections([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * The value lives in memory and is only persisted, so sections still open
   * and close where the browser refuses to remember anything.
   */
  it("still toggles with nowhere to persist to", () => {
    setCollapsedSections(["fleet"]);
    expect(collapsedSnapshot()).toEqual(["fleet"]);
  });
});

describe("collapsedAttributeValue", () => {
  it("never hides the section holding the current page", () => {
    expect(collapsedAttributeValue(["hub", "fleet"], "fleet")).toBe("hub");
  });

  it("keeps the preference for when the person navigates away", () => {
    const stored = ["hub", "fleet"];
    expect(collapsedAttributeValue(stored, "fleet")).toBe("hub");
    expect(collapsedAttributeValue(stored, "overview")).toBe("hub fleet");
  });

  it("is empty when nothing is folded away", () => {
    expect(collapsedAttributeValue([], null)).toBe("");
  });
});

describe("collapseStyles", () => {
  it("hides a panel only while its section is listed on the root", () => {
    const css = collapseStyles(["hub"]);
    expect(css).toContain(
      `html[${NAV_COLLAPSE_ATTRIBUTE}~="hub"] [data-nav-panel="hub"]{display:none}`,
    );
  });

  it("emits nothing when there are no sections to draw", () => {
    expect(collapseStyles([])).toBe("");
  });
});

describe("collapseInitScript", () => {
  it("carries the storage key and the section to leave alone", () => {
    const script = collapseInitScript("hub");
    expect(script).toContain(JSON.stringify(NAV_COLLAPSE_KEY));
    expect(script).toContain('var a="hub"');
  });

  /** It is inlined into HTML, so it must not be able to close its own tag. */
  it("cannot break out of the script element", () => {
    expect(collapseInitScript(null)).not.toContain("</");
  });
});
