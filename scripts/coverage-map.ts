/**
 * Coverage map — what is actually covered, per module, and by what.
 *
 *   npx tsx scripts/coverage-map.ts [--module billing] [--all] [--json]
 *
 * ── Why this is not `vitest --coverage` ─────────────────────────────────
 *
 * Line coverage answers "was this line executed". Every defect this repo
 * shipped this quarter was on an executed line:
 *
 *   - a search box that dropped the branch filter — the line ran, on every
 *     search, and returned another branch's LR;
 *   - `SHORT_RECEIVED` / `EXCESS_RECEIVED`, which had enum entries and
 *     escalation ladders and were raised by nothing;
 *   - `verifyCodDeposit`, which overwrote the shortfall column instead of
 *     adding to it;
 *   - route-deviation detection switching itself off ten minutes in.
 *
 * All of those sit inside modules with green suites. So this script does
 * not ask "was the line run". It asks a question a suite can fail:
 *
 *   **Is this exported symbol named by anything that could fail?**
 *
 * It resolves the import graph of every `*.test.ts(x)` and every
 * `scripts/verify-*.ts` / `scripts/smoke*.ts`, and reports, per module,
 * which exported runtime symbols are pulled in by a test, by an HTTP-driven
 * verify script, by both, or by neither.
 *
 * ── What it can and cannot tell you ────────────────────────────────────
 *
 * It CAN tell you an export is referenced by nothing that runs in CI. That
 * is a hard fact and it is the useful half: you cannot assert a rule you
 * never import.
 *
 * It CANNOT tell you an imported export is *well* asserted. `import { x }`
 * followed by one `expect(x(1)).toBeDefined()` reads here as covered. The
 * headline therefore separates two columns that are usually conflated:
 *
 *   REACHED   — some test or verify script imports this symbol.
 *   ASSERTED  — a test that imports it also contains an assertion whose
 *               text mentions it (`expect(x…`, `assert(… x …)`, `ok(x…`).
 *
 * A symbol REACHED but not ASSERTED is typically imported for setup — the
 * booking helper every hub test needs — and deleting its *rules* would not
 * turn the suite red. That gap is the honest answer to "is phase N tested".
 *
 * Exit code is always 0: this is a map, not a gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const moduleFilter = (() => {
  const i = process.argv.indexOf("--module");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const SHOW_ALL = args.has("--all");
const AS_JSON = args.has("--json");

// ── the tree ────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

const allFiles = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "scripts")),
  ...walk(path.join(ROOT, "workers")),
].map(rel);

const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const isVerify = (f: string) => /^scripts\/(verify-|smoke)/.test(f);

/** Source files whose exports we hold to account. */
const sourceFiles = allFiles.filter(
  (f) =>
    /\.tsx?$/.test(f) &&
    !isTest(f) &&
    !f.endsWith(".d.ts") &&
    (f.startsWith("src/lib/") ||
      f.startsWith("src/server/") ||
      f.startsWith("workers/") ||
      // Server actions are where the rules that matter usually live.
      /^src\/app\/.*\/(actions|queries|service)\.ts$/.test(f)),
);

const testFiles = allFiles.filter(isTest);
const verifyFiles = allFiles.filter((f) => isVerify(f) && /\.(ts|mjs)$/.test(f));

// ── exports ─────────────────────────────────────────────────────────────

const TYPE_ONLY = /^(type|interface)$/;

/** Runtime exports only — a type cannot carry a rule that breaks at run time. */
function exportsOf(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();

  // export function f / export async function f / export const x / class / enum
  const decl =
    /^export\s+(?:async\s+)?(function|const|let|var|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(decl)) {
    if (TYPE_ONLY.test(m[1])) continue;
    found.add(m[2]);
  }

  // export { a, b as c }  /  export { a } from "./x"   — skip `export type {`
  const list = /^export\s+\{([^}]*)\}/gm;
  for (const m of text.matchAll(list)) {
    for (const piece of m[1].split(",")) {
      const cleaned = piece.trim().replace(/^type\s+/, "");
      if (!cleaned || /^type\s*$/.test(piece.trim())) continue;
      if (/^type\s/.test(piece.trim())) continue;
      const asMatch = cleaned.match(/(?:\S+)\s+as\s+([A-Za-z_$][\w$]*)/);
      const name = asMatch ? asMatch[1] : cleaned.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) found.add(name);
    }
  }

  if (/^export\s+default\b/m.test(text)) found.add("default");
  return [...found];
}

// ── the import graph of tests and verify scripts ────────────────────────

/** module specifier -> repo-relative source file, or null when external. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  } else return null;

  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (sourceFiles.includes(cand)) return cand;
  }
  return null;
}

type Ref = { file: string; names: string[]; namespace: boolean };

const IMPORT_RE =
  /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function importsOf(file: string): Ref[] {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return [];
  }
  const refs: Ref[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[3];
    const clause = m[1] ?? "";
    const target = resolveSpecifier(file, spec);
    if (!target) continue;

    if (/\*\s+as\s+/.test(clause)) {
      refs.push({ file: target, names: [], namespace: true });
      continue;
    }
    const names: string[] = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const piece of braced[1].split(",")) {
        const cleaned = piece.trim().replace(/^type\s+/, "");
        if (!cleaned) continue;
        if (/^type\s/.test(piece.trim())) continue;
        const name = cleaned.match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (name) names.push(name);
      }
    }
    const dflt = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    if (dflt && /^[A-Za-z_$][\w$]*$/.test(dflt)) names.push("default");
    refs.push({ file: target, names, namespace: false });
  }

  // Dynamic imports. Tests that use `vi.mock` almost always pull the module
  // under test in with `const { x } = await import("./actions")`, and a map
  // that missed those reported six audited server-action modules as having
  // nothing at all — the loudest possible false alarm.
  const DYNAMIC =
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(DYNAMIC)) {
    const target = resolveSpecifier(file, m[2]);
    if (!target) continue;
    const names: string[] = [];
    for (const piece of m[1].split(",")) {
      const name = piece.trim().replace(/^type\s+/, "").match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) names.push(name);
    }
    refs.push({ file: target, names, namespace: false });
  }
  // `const mod = await import("…")` — a namespace by another name.
  const DYNAMIC_NS = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(DYNAMIC_NS)) {
    const target = resolveSpecifier(file, m[1]);
    if (target) refs.push({ file: target, names: [], namespace: true });
  }
  return refs;
}

/** Assertion lines, for the REACHED-vs-ASSERTED split. */
const ASSERTION_RE = /\b(expect|assert|ok|strictEqual|deepStrictEqual|check|must)\s*\(/;

function assertedNames(file: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    if (!ASSERTION_RE.test(line)) continue;
    for (const id of line.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(id[0]);
  }
  // Multi-line `expect(\n  foo(...)\n)` — sweep the two lines after an
  // assertion opener too, so a wrapped call is not read as unasserted.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!ASSERTION_RE.test(lines[i])) continue;
    for (const j of [i + 1, i + 2]) {
      if (!lines[j]) continue;
      for (const id of lines[j].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(id[0]);
    }
  }
  return names;
}

// ── build the index ─────────────────────────────────────────────────────

type Cover = {
  unitFiles: Set<string>;
  verifyFiles: Set<string>;
  /** export name -> where it is named */
  reachedByUnit: Map<string, Set<string>>;
  reachedByVerify: Map<string, Set<string>>;
  assertedIn: Map<string, Set<string>>;
  namespaceUnit: boolean;
  namespaceVerify: boolean;
};

const cover = new Map<string, Cover>();
const blank = (): Cover => ({
  unitFiles: new Set(),
  verifyFiles: new Set(),
  reachedByUnit: new Map(),
  reachedByVerify: new Map(),
  assertedIn: new Map(),
  namespaceUnit: false,
  namespaceVerify: false,
});

function add(map: Map<string, Set<string>>, key: string, value: string) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}

for (const consumer of [...testFiles, ...verifyFiles]) {
  const unit = isTest(consumer);
  const asserted = unit ? assertedNames(consumer) : new Set<string>();
  for (const ref of importsOf(consumer)) {
    if (!cover.has(ref.file)) cover.set(ref.file, blank());
    const c = cover.get(ref.file)!;
    (unit ? c.unitFiles : c.verifyFiles).add(consumer);
    if (ref.namespace) {
      if (unit) c.namespaceUnit = true;
      else c.namespaceVerify = true;
      continue;
    }
    for (const name of ref.names) {
      add(unit ? c.reachedByUnit : c.reachedByVerify, name, consumer);
      if (unit && asserted.has(name)) add(c.assertedIn, name, consumer);
    }
  }
}

// ── HTTP surface: which routes a verify script actually drives ──────────

const httpPaths = new Map<string, Set<string>>(); // route path -> scripts
for (const script of verifyFiles) {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, script), "utf8");
  } catch {
    continue;
  }
  for (const m of text.matchAll(/["'`](\/(?:api|ops|portal|field|platform|track)?[A-Za-z0-9/_$[\]{}.-]*)["'`]/g)) {
    const p = m[1];
    if (p.length < 2 || p.includes(" ")) continue;
    if (/\.(ts|tsx|mjs|json|csv|png|jpg|md)$/.test(p)) continue;
    add(httpPaths, p.replace(/\$\{[^}]*\}/g, ":x"), script);
  }
}

// ── modules ─────────────────────────────────────────────────────────────

function moduleOf(file: string): string {
  if (file.startsWith("src/lib/")) return `lib/${file.split("/")[2]}`;
  if (file.startsWith("src/server/")) return `server/${file.split("/")[2]}`;
  if (file.startsWith("workers/")) return "workers";
  const m = file.match(/^src\/app\/(\([^)]+\))\/([^/]+)\//);
  if (m) return `app/${m[1]}/${m[2]}`;
  return `app/${file.split("/").slice(0, 3).join("/")}`;
}

type ModuleRow = {
  name: string;
  files: number;
  exports: number;
  reachedUnit: number;
  reachedVerify: number;
  asserted: number;
  unitFiles: Set<string>;
  verifyFiles: Set<string>;
  dark: Array<{ file: string; names: string[] }>;
  reachedNotAsserted: Array<{ file: string; names: string[] }>;
};

const modules = new Map<string, ModuleRow>();

for (const file of sourceFiles) {
  const names = exportsOf(file);
  const key = moduleOf(file);
  if (!modules.has(key)) {
    modules.set(key, {
      name: key,
      files: 0,
      exports: 0,
      reachedUnit: 0,
      reachedVerify: 0,
      asserted: 0,
      unitFiles: new Set(),
      verifyFiles: new Set(),
      dark: [],
      reachedNotAsserted: [],
    });
  }
  const row = modules.get(key)!;
  row.files += 1;
  row.exports += names.length;

  const c = cover.get(file);
  if (!c) {
    if (names.length) row.dark.push({ file, names });
    continue;
  }
  for (const f of c.unitFiles) row.unitFiles.add(f);
  for (const f of c.verifyFiles) row.verifyFiles.add(f);

  const dark: string[] = [];
  const soft: string[] = [];
  for (const name of names) {
    const u = c.namespaceUnit || c.reachedByUnit.has(name);
    const v = c.namespaceVerify || c.reachedByVerify.has(name);
    if (u) row.reachedUnit += 1;
    if (v) row.reachedVerify += 1;
    if (!u && !v) {
      dark.push(name);
      continue;
    }
    if (c.assertedIn.has(name)) row.asserted += 1;
    else soft.push(name);
  }
  if (dark.length) row.dark.push({ file, names: dark });
  if (soft.length) row.reachedNotAsserted.push({ file, names: soft });
}

// ── report ──────────────────────────────────────────────────────────────

function verdict(r: ModuleRow): string {
  const anyReached = r.exports - r.dark.reduce((n, d) => n + d.names.length, 0);
  if (r.exports === 0) return "no exports";
  if (anyReached === 0) return "NOTHING";
  if (r.unitFiles.size === 0 && r.verifyFiles.size > 0) return "verify only";
  if (r.verifyFiles.size === 0 && r.unitFiles.size > 0) return "unit only";
  return "unit + verify";
}

const rows = [...modules.values()]
  .filter((r) => !moduleFilter || r.name.includes(moduleFilter))
  .sort((a, b) => {
    const da = a.dark.reduce((n, d) => n + d.names.length, 0);
    const db = b.dark.reduce((n, d) => n + d.names.length, 0);
    return db - da || b.exports - a.exports;
  });

if (AS_JSON) {
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        module: r.name,
        files: r.files,
        exports: r.exports,
        verdict: verdict(r),
        darkExports: r.dark.reduce((n, d) => n + d.names.length, 0),
        assertedExports: r.asserted,
        unitFiles: [...r.unitFiles],
        verifyFiles: [...r.verifyFiles],
        dark: r.dark,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

console.log("");
console.log("City Logistics — coverage map");
console.log("=".repeat(96));
console.log(
  `${testFiles.length} test files, ${verifyFiles.length} verify/smoke scripts, ` +
    `${sourceFiles.length} source files, ` +
    `${rows.reduce((n, r) => n + r.exports, 0)} runtime exports.`,
);
console.log("");
console.log(
  "  DARK     = exported and named by no test and no verify script. Deleting the rule inside",
  "\n             it cannot turn the suite red.",
  "\n  SOFT     = imported by a test, but that test contains no assertion mentioning it —",
  "\n             usually setup. Weaker than it looks on a green run.",
  "\n  ASSERTED = imported by a test that asserts on it by name.",
);
console.log("");
console.log(
  pad("MODULE", 30) +
    padL("FILES", 6) +
    padL("EXP", 6) +
    padL("DARK", 6) +
    padL("SOFT", 6) +
    padL("ASSERT", 8) +
    "  COVERED BY",
);
console.log("-".repeat(96));

for (const r of rows) {
  const dark = r.dark.reduce((n, d) => n + d.names.length, 0);
  const soft = r.reachedNotAsserted.reduce((n, d) => n + d.names.length, 0);
  const by = verdict(r);
  console.log(
    pad(r.name, 30) +
      padL(String(r.files), 6) +
      padL(String(r.exports), 6) +
      padL(dark ? String(dark) : "·", 6) +
      padL(soft ? String(soft) : "·", 6) +
      padL(r.asserted ? String(r.asserted) : "·", 8) +
      "  " +
      by,
  );
}

console.log("-".repeat(96));
const totalExports = rows.reduce((n, r) => n + r.exports, 0);
const totalDark = rows.reduce((n, r) => n + r.dark.reduce((m, d) => m + d.names.length, 0), 0);
const totalSoft = rows.reduce(
  (n, r) => n + r.reachedNotAsserted.reduce((m, d) => m + d.names.length, 0),
  0,
);
const totalAsserted = rows.reduce((n, r) => n + r.asserted, 0);
const pct = (n: number) => `${((n / totalExports) * 100).toFixed(1)}%`;
console.log(
  pad("TOTAL", 30) +
    padL(String(rows.reduce((n, r) => n + r.files, 0)), 6) +
    padL(String(totalExports), 6) +
    padL(String(totalDark), 6) +
    padL(String(totalSoft), 6) +
    padL(String(totalAsserted), 8),
);
console.log("");
console.log(
  `  dark ${pct(totalDark)}   ·   reached but unasserted ${pct(totalSoft)}   ·   asserted ${pct(totalAsserted)}`,
);
console.log("");

// ── the dark list, which is the part worth reading ──────────────────────

const withDark = rows.filter((r) => r.dark.length > 0);
if (withDark.length) {
  console.log("Dark exports — nothing imports these from a test or a verify script");
  console.log("=".repeat(96));
  for (const r of withDark) {
    const total = r.dark.reduce((n, d) => n + d.names.length, 0);
    console.log(`\n${r.name}  (${total})`);
    const shown = SHOW_ALL ? r.dark : r.dark.slice(0, 6);
    for (const d of shown) {
      const names = SHOW_ALL ? d.names : d.names.slice(0, 8);
      const more = d.names.length > names.length ? ` … +${d.names.length - names.length}` : "";
      console.log(`  ${pad(d.file, 52)} ${names.join(", ")}${more}`);
    }
    if (!SHOW_ALL && r.dark.length > 6) {
      console.log(`  … and ${r.dark.length - 6} more files (--all)`);
    }
  }
  console.log("");
}

// ── HTTP surface ────────────────────────────────────────────────────────

const drivenRoutes = [...httpPaths.keys()].filter((p) => !p.startsWith("/api/")).length;
const drivenApi = [...httpPaths.keys()].filter((p) => p.startsWith("/api/")).length;
console.log(
  `HTTP surface driven by verify scripts: ${drivenRoutes} page paths, ${drivenApi} API paths.`,
);
console.log(
  "  A page path here means a script fetched it. Fetching a page proves it renders;",
);
console.log(
  "  it does not prove the control on it was exercised. Read the script to know which.",
);
console.log("");
console.log(
  "Reminder: `npm run coverage` (vitest line coverage) answers a weaker question than this map.",
);
console.log("");
