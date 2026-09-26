// Project graph for the v2 main screen (docs/direction-v2.md §5): folders and files as nodes,
// containment as edges. Pure and deterministic, so the server can build it per request.
import type { ChangeStatus } from './types.js';
import type { GraphEdge, GraphNode } from './v2.js';

export interface GraphInput {
  /** Every file in the digest's `to` checkpoint (already filtered by ignores and the denylist). */
  paths: string[];
  /** The digest's changed files. Deleted files are added even though they are not in `paths`. */
  files: { path: string; status: ChangeStatus; additions: number; deletions: number }[];
  areas?: { id: string; paths: string[] }[];
  /** Folders the user opened: shown with every child listed, even if unchanged. */
  expand?: string[];
  /** Soft cap on the number of nodes (default 400). */
  maxNodes?: number;
  /** Unchanged files in a shown folder are listed one by one up to this many, else grouped (default 8). */
  maxLooseFiles?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalFiles: number;
  truncated: boolean;
}

interface Dir {
  path: string;
  name: string;
  depth: number;
  dirs: Map<string, Dir>;
  files: Map<string, string>;
  fileCount: number;
  changedFiles: number;
  additions: number;
  deletions: number;
}

interface Pass {
  looseFiles: number;
  groupDirs: boolean;
  /** Changed folders at this depth or deeper are folded. */
  foldDepth: number;
}

const newDir = (path: string, name: string, depth: number): Dir => ({
  path, name, depth, dirs: new Map(), files: new Map(), fileCount: 0, changedFiles: 0, additions: 0, deletions: 0,
});
const byName = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ancestors(path: string): string[] {
  const parts = path.split('/');
  const out = [''];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function buildProjectGraph(input: GraphInput): GraphResult {
  const maxNodes = input.maxNodes ?? 400;
  const maxLoose = input.maxLooseFiles ?? 8;
  const changes = new Map(input.files.map((f) => [f.path, f]));
  const root = newDir('', '', 0);

  const all = new Set(input.paths.filter((p) => p !== ''));
  for (const f of input.files) all.add(f.path);
  for (const path of all) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir.dirs.get(parts[i]!);
      if (!next) {
        next = newDir(parts.slice(0, i + 1).join('/'), parts[i]!, i + 1);
        dir.dirs.set(parts[i]!, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, path);
  }

  const sum = (d: Dir) => {
    for (const sub of d.dirs.values()) {
      sum(sub);
      d.fileCount += sub.fileCount;
      d.changedFiles += sub.changedFiles;
      d.additions += sub.additions;
      d.deletions += sub.deletions;
    }
    for (const path of d.files.values()) {
      d.fileCount++;
      const c = changes.get(path);
      if (c) {
        d.changedFiles++;
        d.additions += c.additions;
        d.deletions += c.deletions;
      }
    }
  };
  sum(root);

  const areasAt = new Map<string, Set<string>>();
  for (const area of input.areas ?? []) {
    for (const p of area.paths) {
      for (const key of [...ancestors(p).map((a) => `d:${a}`), `f:${p}`]) {
        let s = areasAt.get(key);
        if (!s) areasAt.set(key, (s = new Set()));
        s.add(area.id);
      }
    }
  }
  const areaIds = (id: string) => [...(areasAt.get(id) ?? [])].sort();

  const opened = new Set<string>();
  for (const e of input.expand ?? []) for (const a of [...ancestors(e), e]) opened.add(a);

  const emit = (pass: Pass) => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const add = (n: GraphNode) => {
      nodes.push(n);
      if (n.parentId !== null) edges.push({ source: n.parentId, target: n.id, kind: 'contains' });
    };
    const dirNode = (d: Dir, parentId: string | null, collapsed: boolean): GraphNode => ({
      id: `d:${d.path}`, kind: d.depth === 0 ? 'root' : 'dir', path: d.path, name: d.name, parentId, depth: d.depth,
      collapsed, fileCount: d.fileCount, changed: d.changedFiles > 0, changedFiles: d.changedFiles,
      additions: d.additions, deletions: d.deletions, status: null, areaIds: areaIds(`d:${d.path}`),
    });
    const isOpen = (d: Dir) =>
      d.depth === 0 || opened.has(d.path) || (d.changedFiles > 0 && d.depth < pass.foldDepth);

    const walk = (d: Dir, parentId: string | null) => {
      const node = dirNode(d, parentId, !isOpen(d));
      add(node);
      if (node.collapsed) return;
      const listAll = opened.has(d.path) && d.depth > 0;
      let groupFiles = 0;
      let groupDirs = 0;
      for (const [, sub] of byName(d.dirs)) {
        if (sub.changedFiles === 0 && pass.groupDirs && !listAll && !opened.has(sub.path)) {
          groupDirs++;
          groupFiles += sub.fileCount;
        } else walk(sub, node.id);
      }
      const files = byName(d.files);
      const unchanged = files.filter(([, p]) => !changes.has(p)).length;
      const loose = listAll || unchanged <= pass.looseFiles;
      for (const [name, path] of files) {
        const c = changes.get(path);
        if (!c && !loose) {
          groupFiles++;
          continue;
        }
        add({
          id: `f:${path}`, kind: 'file', path, name, parentId: node.id, depth: d.depth + 1, collapsed: false,
          fileCount: 1, changed: !!c, changedFiles: c ? 1 : 0, additions: c?.additions ?? 0,
          deletions: c?.deletions ?? 0, status: c?.status ?? null, areaIds: areaIds(`f:${path}`),
        });
      }
      if (groupFiles > 0 || groupDirs > 0) {
        add({
          id: `g:${d.path}`, kind: 'group', path: d.path,
          name: groupDirs > 0 ? `${plural(groupDirs, 'folder')}, ${plural(groupFiles, 'file')}` : plural(groupFiles, 'file'),
          parentId: node.id, depth: d.depth + 1, collapsed: true, fileCount: groupFiles, changed: false,
          changedFiles: 0, additions: 0, deletions: 0, status: null, areaIds: [],
        });
      }
    };
    walk(root, null);
    return { nodes, edges };
  };

  let maxDepth = 0;
  const depthOf = (d: Dir) => {
    maxDepth = Math.max(maxDepth, d.depth + 1);
    for (const sub of d.dirs.values()) depthOf(sub);
  };
  depthOf(root);

  const passes: Pass[] = [
    { looseFiles: maxLoose, groupDirs: false, foldDepth: Infinity },
    { looseFiles: 0, groupDirs: false, foldDepth: Infinity },
    { looseFiles: 0, groupDirs: true, foldDepth: Infinity },
  ];
  for (let depth = maxDepth; depth >= 1; depth--) passes.push({ looseFiles: 0, groupDirs: true, foldDepth: depth });

  let out = emit(passes[0]!);
  let truncated = false;
  for (let i = 1; i < passes.length && out.nodes.length > maxNodes; i++) {
    out = emit(passes[i]!);
    truncated = passes[i]!.foldDepth !== Infinity;
  }
  return { ...out, totalFiles: root.fileCount, truncated };
}
