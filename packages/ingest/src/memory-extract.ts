// Deterministic project-memory extraction (docs/milestone-4-memory.md §1, DIG-100). Pure and
// synchronous over a `TreeReader` (no git, no fs): `memory-update.ts` is the thin async layer that
// builds one from a shadow-store checkpoint. Line-based parsers only, no new dependency; anything
// not TS/JS, Python, Go or Rust gets file names only (no symbol extraction), same as the design.
import { createHash } from 'node:crypto';
import { redact } from '@digestit/explain';
import type { AreaMemory, MemorySymbol, TermMemory } from '@digestit/core';
import { MEMORY_LIMITS } from '@digestit/core';

export interface TreeReader {
  /** Every file path in the checkpoint tree, already filtered by the shadow store (denylist,
   * `.gitignore`, project ignores, size cap) -- extraction never sees a path that shouldn't exist. */
  paths: readonly string[];
  /** File content, or `null` for a binary or unreadable file. */
  read(path: string): string | null;
}

// ---- areas: folder/package grouping over the whole tree -------------------------------------

const ROOT_KEY = '.';

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? ROOT_KEY : path.slice(0, slash);
}

/**
 * Same bucketing rule as `@digestit/core`'s `groupDigestAreas` (a file under a recognised workspace
 * package roots at the package, deeper files bucket at the package root too), applied to the whole
 * tree rather than one digest's changed files, and keyed by the real folder path rather than a
 * display label -- memory needs the path back to resolve imports and read READMEs.
 */
function bucketOf(path: string, prefixes: readonly string[]): string {
  const segments = path.split('/');
  if (segments.length === 1) return ROOT_KEY;
  const top = segments[0]!;
  if (prefixes.includes(top) && segments.length >= 2) {
    return segments.length > 2 ? `${top}/${segments[1]}` : dirOf(path);
  }
  return dirOf(path);
}

function parentOf(key: string): string {
  if (key === ROOT_KEY) return ROOT_KEY;
  const slash = key.lastIndexOf('/');
  return slash === -1 ? ROOT_KEY : key.slice(0, slash);
}

export interface AreaGroup {
  /** Folder or package path; `''` for the project root (`AreaMemory.path`'s own convention). */
  path: string;
  paths: string[];
}

/** Partitions every path in the tree into at most `maxAreas` groups, merging the smallest (fewest
 * files) into its parent directory first -- the same policy as `groupDigestAreas`, over the full
 * tree instead of one digest's changed files. */
export function groupMemoryAreas(
  paths: readonly string[], workspacePrefixes: readonly string[] = [], maxAreas = MEMORY_LIMITS.areas,
): AreaGroup[] {
  if (paths.length === 0) return [];
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = bucketOf(p, workspacePrefixes);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  while (groups.size > maxAreas) {
    const mergeable = [...groups.keys()].filter((k) => k !== ROOT_KEY);
    const keys = mergeable.length > 0 ? mergeable : [...groups.keys()];
    keys.sort((a, b) => groups.get(a)!.length - groups.get(b)!.length || a.localeCompare(b));
    const smallest = keys[0];
    if (!smallest || smallest === ROOT_KEY) break;
    const files = groups.get(smallest)!;
    groups.delete(smallest);
    const parentKey = parentOf(smallest);
    const parent = groups.get(parentKey);
    if (parent) parent.push(...files);
    else groups.set(parentKey, files);
  }
  return [...groups.entries()]
    .map(([key, ps]) => ({ path: key === ROOT_KEY ? '' : key, paths: [...ps].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---- per-file language extraction ------------------------------------------------------------

export type Lang = 'ts' | 'py' | 'go' | 'rs' | null;

export function langOf(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === path) return null; // no extension
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'ts';
  if (ext === 'py') return 'py';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rs';
  return null;
}

export interface ImportRef {
  /** Module specifier as written: a relative path, a bare package name, or a language import path. */
  spec: string;
  /** Named bindings imported (TS/JS only, used to rank an area's exports by how often each is
   * imported); empty for every other language and for default/namespace/side-effect imports. */
  names: string[];
}

export interface ParsedFile {
  exports: MemorySymbol[];
  imports: ImportRef[];
}

const TS_EXPORT_PATTERNS: { re: RegExp; kind: MemorySymbol['kind'] }[] = [
  { re: /^export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^export\s+class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^export\s+(?:abstract\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
];

function parseTsImportClause(clause: string): string[] {
  const brace = /\{([^}]*)\}/.exec(clause);
  if (!brace) return [];
  const names: string[] = [];
  for (const part of brace[1]!.split(',')) {
    const t = part.trim();
    if (!t) continue;
    names.push(t.split(/\s+as\s+/)[0]!.trim());
  }
  return names;
}

function parseTsJs(text: string, path: string): ParsedFile {
  const exports: MemorySymbol[] = [];
  const imports: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const lineNo = i + 1;

    if (/^export\s+default\b/.test(line)) {
      const fn = /^export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(line);
      const cls = /^export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/.exec(line);
      const name = fn?.[1] ?? cls?.[1] ?? 'default';
      exports.push({ name, kind: fn ? 'function' : cls ? 'class' : 'other', file: path, line: lineNo });
      continue;
    }
    let matched = false;
    for (const { re, kind } of TS_EXPORT_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        exports.push({ name: m[1]!, kind, file: path, line: lineNo });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const reexport = /^export\s*\{([^}]*)\}\s*(?:from\s*['"][^'"]+['"])?/.exec(line);
    if (reexport) {
      for (const part of reexport[1]!.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const segs = t.split(/\s+as\s+/);
        exports.push({ name: (segs[1] ?? segs[0])!.trim(), kind: 'other', file: path, line: lineNo });
      }
      continue;
    }

    const fromImport = /^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(line);
    if (fromImport) {
      imports.push({ spec: fromImport[2]!, names: parseTsImportClause(fromImport[1]!) });
      continue;
    }
    const bareImport = /^import\s+['"]([^'"]+)['"]/.exec(line);
    if (bareImport) {
      imports.push({ spec: bareImport[1]!, names: [] });
      continue;
    }
    const req = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
    if (req) imports.push({ spec: req[1]!, names: [] });
  }
  return { exports, imports };
}

function parsePython(text: string, path: string): ParsedFile {
  const exports: MemorySymbol[] = [];
  const imports: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s/.test(raw) || raw.trim() === '') continue; // top-level only
    const line = raw.trim();
    const lineNo = i + 1;
    const def = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (def) { exports.push({ name: def[1]!, kind: 'function', file: path, line: lineNo }); continue; }
    const cls = /^class\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) { exports.push({ name: cls[1]!, kind: 'class', file: path, line: lineNo }); continue; }
    const from = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const names = from[2]!.split(',').map((p) => p.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      imports.push({ spec: from[1]!, names });
      continue;
    }
    const imp = /^import\s+([\w.]+)/.exec(line);
    if (imp) imports.push({ spec: imp[1]!, names: [] });
  }
  return { exports, imports };
}

function parseGo(text: string, path: string): ParsedFile {
  const exports: MemorySymbol[] = [];
  const imports: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  const isExported = (name: string) => /^[A-Z]/.test(name);
  let inImportBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    const lineNo = i + 1;
    if (/^import\s*\(/.test(trimmed)) { inImportBlock = true; continue; }
    if (inImportBlock) {
      if (trimmed === ')') { inImportBlock = false; continue; }
      const m = /^(?:[\w.]+\s+)?"([^"]+)"/.exec(trimmed);
      if (m) imports.push({ spec: m[1]!, names: [] });
      continue;
    }
    const single = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(trimmed);
    if (single) { imports.push({ spec: single[1]!, names: [] }); continue; }
    if (/^\s/.test(raw)) continue; // everything below is package-level only
    const fn = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (fn && isExported(fn[1]!)) { exports.push({ name: fn[1]!, kind: 'function', file: path, line: lineNo }); continue; }
    const ty = /^type\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (ty && isExported(ty[1]!)) { exports.push({ name: ty[1]!, kind: 'type', file: path, line: lineNo }); continue; }
    const decl = /^(?:var|const)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (decl && isExported(decl[1]!)) exports.push({ name: decl[1]!, kind: 'const', file: path, line: lineNo });
  }
  return { exports, imports };
}

function parseRust(text: string, path: string): ParsedFile {
  const exports: MemorySymbol[] = [];
  const imports: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  const PUB: { re: RegExp; kind: MemorySymbol['kind'] }[] = [
    { re: /^pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^pub\s+struct\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^pub\s+enum\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^pub\s+trait\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^pub\s+const\s+([A-Za-z_]\w*)/, kind: 'const' },
    { re: /^pub\s+static\s+([A-Za-z_]\w*)/, kind: 'const' },
    { re: /^pub\s+mod\s+([A-Za-z_]\w*)/, kind: 'other' },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const lineNo = i + 1;
    let matched = false;
    for (const { re, kind } of PUB) {
      const m = re.exec(line);
      if (m) { exports.push({ name: m[1]!, kind, file: path, line: lineNo }); matched = true; break; }
    }
    if (matched) continue;
    const use = /^(?:pub\s+)?use\s+([\w:]+(?:::\{[^}]*\})?)\s*;/.exec(line);
    if (use) imports.push({ spec: use[1]!, names: [] });
  }
  return { exports, imports };
}

function parseFile(path: string, text: string): ParsedFile | null {
  const lang = langOf(path);
  if (lang === 'ts') return parseTsJs(text, path);
  if (lang === 'py') return parsePython(text, path);
  if (lang === 'go') return parseGo(text, path);
  if (lang === 'rs') return parseRust(text, path);
  return null; // other languages: file names only, no symbol extraction
}

// ---- import resolution (TS/JS relative + workspace package name, Python relative) -------------

function normalizeJoin(dir: string, spec: string): string {
  const parts = (dir ? dir.split('/') : []).concat(spec.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

const JS_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function resolveRelativeTs(fromFile: string, spec: string, allPaths: ReadonlySet<string>): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  // A specifier written with its compiled `.js` extension (common in ESM TS) must resolve against
  // the source file's real extension, so the stem drops whatever extension is already there.
  const base = normalizeJoin(dir, spec).replace(JS_EXTENSION, '');
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
  ];
  return candidates.find((c) => allPaths.has(c)) ?? null;
}

function resolveRelativePy(fromFile: string, spec: string, allPaths: ReadonlySet<string>): string | null {
  const leadingDots = /^\.+/.exec(spec)?.[0]?.length ?? 0;
  if (leadingDots === 0) return null;
  let dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  for (let n = 1; n < leadingDots; n++) dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  const rest = spec.slice(leadingDots).replace(/\./g, '/');
  const base = rest ? normalizeJoin(dir, rest) : dir;
  const candidates = [`${base}.py`, `${base}/__init__.py`];
  return candidates.find((c) => allPaths.has(c)) ?? null;
}

// ---- doc text: folder README first paragraph, or the main file's leading doc comment -----------

function firstReadmeParagraph(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === '' || /^#+\s/.test(lines[i]!))) i++;
  const para: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== '') { para.push(lines[i]!.trim()); i++; }
  const text2 = para.join(' ').trim();
  return text2.length > 0 ? text2 : null;
}

function leadingDocComment(text: string, lang: Lang): string | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.startsWith('#!')) i = 1;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i >= lines.length) return null;

  if (lang === 'ts') {
    if (lines[i]!.trim().startsWith('/**') || lines[i]!.trim().startsWith('/*')) {
      // Every continuation line is checked for the closing `*/` *before* a leading `*` (JSDoc's own
      // gutter, not part of the text) is stripped -- stripping first would consume the `*` that is
      // part of `*/` and the closing marker would never be found.
      const stripGutter = (s: string): string => (s.startsWith('*') && !s.startsWith('*/') ? s.slice(1).replace(/^\s/, '') : s);
      const out: string[] = [];
      let line = lines[i]!.trim().replace(/^\/\*+/, '');
      for (;;) {
        const end = line.indexOf('*/');
        if (end >= 0) { out.push(stripGutter(line.slice(0, end)).trim()); break; }
        out.push(stripGutter(line).trim());
        i++;
        if (i >= lines.length) break;
        line = lines[i]!.trim();
      }
      const joined = out.filter(Boolean).join(' ').trim();
      return joined.length > 0 ? joined : null;
    }
    if (lines[i]!.trim().startsWith('//')) {
      const out: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('//')) { out.push(lines[i]!.trim().replace(/^\/\/\s?/, '')); i++; }
      const joined = out.join(' ').trim();
      return joined.length > 0 ? joined : null;
    }
    return null;
  }
  if (lang === 'py') {
    const m = /^(?:"""|''')/.exec(lines[i]!.trim());
    if (!m) return null;
    const quote = m[0]!;
    let rest = lines[i]!.trim().slice(quote.length);
    const out: string[] = [];
    for (;;) {
      const end = rest.indexOf(quote);
      if (end >= 0) { out.push(rest.slice(0, end)); break; }
      out.push(rest);
      i++;
      if (i >= lines.length) break;
      rest = lines[i]!;
    }
    const joined = out.map((l) => l.trim()).filter(Boolean).join(' ').trim();
    return joined.length > 0 ? joined : null;
  }
  if (lang === 'go' || lang === 'rs') {
    if (!lines[i]!.trim().startsWith('//')) return null;
    const out: string[] = [];
    while (i < lines.length && lines[i]!.trim().startsWith('//')) { out.push(lines[i]!.trim().replace(/^\/\/!?\s?/, '')); i++; }
    const joined = out.join(' ').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function capAndRedact(text: string | null): string | null {
  if (!text) return null;
  const capped = text.length > MEMORY_LIMITS.docChars ? text.slice(0, MEMORY_LIMITS.docChars) : text;
  const cleaned = redact(capped).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** The area's own doc text: its folder's `README.md` first paragraph, else the leading doc comment
 * of its "main" file (an `index.*`/`__init__.py`/`main.*`/`mod.rs`/`lib.rs` if present, else the
 * first file alphabetically that this extractor knows how to read a comment from). */
function areaDoc(reader: TreeReader, area: AreaGroup): string | null {
  const readmePath = area.path === '' ? 'README.md' : `${area.path}/README.md`;
  const readme = reader.paths.includes(readmePath) ? reader.read(readmePath) : null;
  if (readme) {
    const para = firstReadmeParagraph(readme);
    if (para) return capAndRedact(para);
  }
  const MAIN_NAMES = ['index.ts', 'index.tsx', 'index.js', '__init__.py', 'main.go', 'lib.rs', 'mod.rs', 'main.rs'];
  const own = area.paths.filter((p) => (area.path === '' ? !p.includes('/') : p.startsWith(`${area.path}/`)));
  const main = MAIN_NAMES.map((n) => (area.path === '' ? n : `${area.path}/${n}`)).find((p) => own.includes(p))
    ?? [...own].sort().find((p) => langOf(p) !== null);
  if (!main) return null;
  const content = reader.read(main);
  if (!content) return null;
  return capAndRedact(leadingDocComment(content, langOf(main)));
}

// ---- putting it together ----------------------------------------------------------------------

export interface ExtractedMemory {
  /** `files` is the area's own file list (unbounded), for the caller's provenance bookkeeping --
   * `AreaMemory` itself only carries `fileCount`. */
  areas: { path: string; content: AreaMemory; files: string[] }[];
  terms: TermMemory[];
}

interface PackageJson {
  name?: unknown;
}

function readPackageName(reader: TreeReader, area: AreaGroup): string | null {
  const path = area.path === '' ? 'package.json' : `${area.path}/package.json`;
  if (!reader.paths.includes(path)) return null;
  const raw = reader.read(path);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PackageJson;
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * The whole deterministic pass: areas (folder/package grouping, ≤ `MEMORY_LIMITS.areas`), each
 * area's exported symbols (most-imported first among files parsed in this pass), its `uses`/
 * `usedBy` (TS/JS relative and workspace-package imports, Python relative imports -- the reliable
 * deterministic cases; Go and Rust get exports/imports but no resolved area graph edges in v1,
 * since neither has a path convention this pass can resolve without reading a manifest), its doc
 * text, and a fingerprint of exports+uses+doc. Terms are exported symbols across every area
 * (defining area only), capped at `MEMORY_LIMITS.terms`.
 */
export function extractProjectMemory(reader: TreeReader, opts: { workspacePrefixes?: readonly string[] } = {}): ExtractedMemory {
  const areaGroups = groupMemoryAreas(reader.paths, opts.workspacePrefixes ?? []);
  const pathToArea = new Map<string, string>();
  for (const g of areaGroups) for (const p of g.paths) pathToArea.set(p, g.path);
  const packageNameToArea = new Map<string, string>();
  for (const g of areaGroups) {
    const name = readPackageName(reader, g);
    if (name) packageNameToArea.set(name, g.path);
  }
  const allPaths = new Set(reader.paths);

  const parsedByFile = new Map<string, ParsedFile>();
  for (const p of reader.paths) {
    if (langOf(p) === null) continue;
    const content = reader.read(p);
    if (content === null) continue;
    parsedByFile.set(p, parseFile(p, content)!);
  }

  const usesByArea = new Map<string, Set<string>>();
  const usedByArea = new Map<string, Set<string>>();
  const importCounts = new Map<string, Map<string, number>>(); // targetAreaPath -> exportName -> count
  const addEdge = (fromArea: string, toArea: string) => {
    if (fromArea === toArea) return;
    if (!usesByArea.has(fromArea)) usesByArea.set(fromArea, new Set());
    usesByArea.get(fromArea)!.add(toArea);
    if (!usedByArea.has(toArea)) usedByArea.set(toArea, new Set());
    usedByArea.get(toArea)!.add(fromArea);
  };
  const bumpCount = (targetArea: string, name: string) => {
    const m = importCounts.get(targetArea) ?? new Map<string, number>();
    m.set(name, (m.get(name) ?? 0) + 1);
    importCounts.set(targetArea, m);
  };

  for (const [file, parsed] of parsedByFile) {
    const fromArea = pathToArea.get(file)!;
    for (const imp of parsed.imports) {
      let resolvedFile: string | null = null;
      let resolvedArea: string | null = null;
      if (imp.spec.startsWith('.')) {
        resolvedFile = resolveRelativeTs(file, imp.spec, allPaths) ?? resolveRelativePy(file, imp.spec, allPaths);
        if (resolvedFile) resolvedArea = pathToArea.get(resolvedFile) ?? null;
      } else if (packageNameToArea.has(imp.spec)) {
        resolvedArea = packageNameToArea.get(imp.spec)!;
      }
      if (resolvedArea === null) continue;
      addEdge(fromArea, resolvedArea);
      for (const name of imp.names) bumpCount(resolvedArea, name);
    }
  }

  const areas: { path: string; content: AreaMemory; files: string[] }[] = [];
  const allExports: MemorySymbol[] = [];
  for (const g of areaGroups) {
    const exportsRaw: MemorySymbol[] = [];
    for (const p of g.paths) {
      const parsed = parsedByFile.get(p);
      if (parsed) exportsRaw.push(...parsed.exports);
    }
    const counts = importCounts.get(g.path);
    const ordered = [...exportsRaw].sort((a, b) => {
      const diff = (counts?.get(b.name) ?? 0) - (counts?.get(a.name) ?? 0);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    const exports = ordered.slice(0, MEMORY_LIMITS.symbolsPerArea);
    allExports.push(...exportsRaw);

    const uses = [...(usesByArea.get(g.path) ?? [])].sort();
    const usedBy = [...(usedByArea.get(g.path) ?? [])].sort();
    const doc = areaDoc(reader, g);
    const fingerprint = createHash('sha1')
      .update(JSON.stringify({ exports: exports.map((e) => [e.name, e.kind, e.file, e.line]), uses, doc }))
      .digest('hex');
    const content: AreaMemory = { kind: 'area', path: g.path, fileCount: g.paths.length, exports, uses, usedBy, doc, summary: null, fingerprint };
    areas.push({ path: g.path, content, files: g.paths });
  }

  const seen = new Set<string>();
  const terms: TermMemory[] = [];
  for (const sym of [...allExports].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    if (seen.has(sym.name) || terms.length >= MEMORY_LIMITS.terms) continue;
    seen.add(sym.name);
    const area = pathToArea.get(sym.file) ?? '';
    const meaning = leadingDocCommentAbove(reader, sym);
    terms.push({ kind: 'term', term: sym.name, definedAt: { file: sym.file, line: sym.line }, meaning: capAndRedact(meaning), areas: [area] });
  }

  return { areas, terms };
}

/** The doc comment directly above a symbol's declaration line, TS/JS-only (the language where this
 * is unambiguous line-based): a `/** ... *&#47;` block, or consecutive `//` lines, ending on the line
 * right before `sym.line`. `null` for every other language or when there is none. */
function leadingDocCommentAbove(reader: TreeReader, sym: MemorySymbol): string | null {
  if (langOf(sym.file) !== 'ts') return null;
  const content = reader.read(sym.file);
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const above = sym.line - 2; // 0-based index of the line right before the declaration
  if (above < 0) return null;
  if (lines[above]!.trim().endsWith('*/')) {
    let start = above;
    while (start >= 0 && !lines[start]!.trim().startsWith('/**') && !lines[start]!.trim().startsWith('/*')) start--;
    if (start < 0) return null;
    const block = lines.slice(start, above + 1).join('\n');
    return leadingDocComment(block, 'ts');
  }
  if (lines[above]!.trim().startsWith('//')) {
    let start = above;
    while (start >= 0 && lines[start]!.trim().startsWith('//')) start--;
    const block = lines.slice(start + 1, above + 1).join('\n');
    return leadingDocComment(block, 'ts');
  }
  return null;
}
