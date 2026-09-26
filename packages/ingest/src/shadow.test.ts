import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DENYLIST, EMPTY_TREE_SHA, diff, listTree, matchesDenylist, openShadow, pending, snapshot,
  userGitInfo, type Shadow,
} from './shadow.js';

let root: string;
let proj: string;
let data: string;

const write = (name: string, content: string | Buffer) => {
  mkdirSync(join(proj, name, '..'), { recursive: true });
  writeFileSync(join(proj, name), content);
};
const gitProj = (...args: string[]) =>
  execFileSync('git', ['-C', proj, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'digest-shadow-'));
  proj = join(root, 'project');
  data = join(root, 'data');
  mkdirSync(proj, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('openShadow', () => {
  it('creates a bare shadow.git, an index file and an info/exclude with the default denylist', async () => {
    const shadow = await openShadow(data, proj);
    expect(statSync(join(shadow.gitDir, 'HEAD')).isFile()).toBe(true);
    expect(execFileSync('git', ['--git-dir', shadow.gitDir, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim())
      .toBe('true');
    const exclude = readFileText(join(shadow.gitDir, 'info', 'exclude'));
    for (const pattern of DEFAULT_DENYLIST) expect(exclude).toContain(pattern);
  });

  it('reopening an existing shadow does not reset it', async () => {
    const s1 = await openShadow(data, proj);
    write('a.txt', 'one\n');
    const r1 = await snapshot(s1);
    const s2 = await openShadow(data, proj);
    const r2 = await snapshot(s2, { parent: r1.treeSha });
    expect(r2.unchanged).toBe(true);
  });
});

function readFileText(path: string): string {
  return execFileSync('cat', [path], { encoding: 'utf8' });
}

describe('snapshot: never writes into the project', () => {
  it('leaves the project file list, mtimes and every .git byte unchanged, even with a dirty tree', async () => {
    write('tracked.txt', 'one\ntwo\n');
    gitProj('init', '-q', '-b', 'main');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    write('tracked.txt', 'one\nDIRTY\n'); // dirty tree
    write('untracked.txt', 'new stuff\n'); // untracked file

    const before = snapshotFsState(proj);
    const shadow = await openShadow(data, proj);
    await snapshot(shadow);
    const after = snapshotFsState(proj);

    expect(after).toEqual(before);
  });
});

interface FsEntry { path: string; mtimeMs: number; size: number; hash: string | null }
function snapshotFsState(dir: string, base = dir): FsEntry[] {
  const out: FsEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    const hash = st.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : null;
    out.push({ path: full.slice(base.length), mtimeMs: st.mtimeMs, size: st.size, hash });
    if (st.isDirectory()) out.push(...snapshotFsState(full, base));
  }
  return out;
}

describe('snapshot', () => {
  it('works for a folder that is not a git repo, and includes untracked files', async () => {
    write('a.txt', 'hello\n');
    write('sub/b.txt', 'world\n');
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(r.unchanged).toBe(false);
    expect(await listTree(shadow, r.treeSha)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('respects nested .gitignore files', async () => {
    write('keep.txt', 'k\n');
    write('sub/.gitignore', 'ignored.txt\n');
    write('sub/ignored.txt', 'secret-ish but just gitignored\n');
    write('sub/kept.txt', 'kept\n');
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(await listTree(shadow, r.treeSha)).toEqual(['keep.txt', 'sub/.gitignore', 'sub/kept.txt']);
    expect(r.skipped).toEqual([]); // gitignored, not "skipped" (that's for denylist/size/etc.)
  });

  it('includes uncommitted changes on top of a real git repo', async () => {
    gitProj('init', '-q', '-b', 'main');
    write('a.txt', 'v1\n');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    write('a.txt', 'v2 uncommitted\n'); // dirty, never committed
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(await listTree(shadow, r.treeSha)).toEqual(['a.txt']);
    const files = await diff(shadow, EMPTY_TREE_SHA, r.treeSha);
    expect(files[0]).toMatchObject({ path: 'a.txt' });
  });

  it('handles deletes, renames and binary files between two checkpoints', async () => {
    write('old.txt', 'line1\nline2\nline3\n');
    write('gone.txt', 'x\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);

    renameSync(join(proj, 'old.txt'), join(proj, 'new-name.txt'));
    write('img.bin', Buffer.from([0, 1, 2, 0, 255, 0]));
    rmSync(join(proj, 'gone.txt'));
    const r2 = await snapshot(shadow, { parent: r1.treeSha });

    const files = await diff(shadow, r1.treeSha, r2.treeSha);
    const of = (p: string) => files.find((f) => f.path === p);
    expect(of('new-name.txt')).toMatchObject({ status: 'R', oldPath: 'old.txt' });
    expect(of('img.bin')).toMatchObject({ status: 'B', patch: null });
    expect(of('gone.txt')).toMatchObject({ status: 'D', deletions: 1 });
  });

  it('lists a nested repo as skipped (nested_repo) and does not descend into it', async () => {
    write('keep.txt', 'k\n');
    const nested = join(proj, 'nested_repo');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', nested], { encoding: 'utf8' });
    writeFileSync(join(nested, 'inner.txt'), 'inner\n');

    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(r.skipped).toEqual([{ path: 'nested_repo', reason: 'nested_repo' }]);
    expect(await listTree(shadow, r.treeSha)).toEqual(['keep.txt']);
  });

  it('never stores denylisted paths, and a planted secret is absent from the shadow objects', async () => {
    write('.env', 'API_KEY=super-secret-value\n');
    write('id_rsa', 'fake-private-key\n');
    write('node_modules/pkg/index.js', 'module.exports = 1;\n');
    write('keep.txt', 'k\n');
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);

    const reasons = r.skipped.map((s) => s.path).sort();
    expect(reasons).toEqual(['.env', 'id_rsa', 'node_modules']); // a denylisted dir collapses to one entry
    expect(r.skipped.every((s) => s.reason === 'denylist')).toBe(true);
    expect(await listTree(shadow, r.treeSha)).toEqual(['keep.txt']);

    const dump = execFileSync('git', ['--git-dir', shadow.gitDir, 'cat-file', '--batch-all-objects', '--batch'], { encoding: 'utf8' });
    expect(dump).not.toContain('super-secret-value');
  });

  it('collapses a whole denylisted directory into one skipped entry', async () => {
    write('keep.txt', 'k\n');
    for (let i = 0; i < 200; i++) write(`node_modules/pkg/f${i}.js`, `// ${i}\n`);
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(r.skipped).toEqual([{ path: 'node_modules', reason: 'denylist' }]);
    expect(await listTree(shadow, r.treeSha)).toEqual(['keep.txt']);
  });

  it('does not report a nested repo that sits inside a gitignored directory', async () => {
    write('keep.txt', 'k\n');
    write('.gitignore', 'ignored-dir/\n');
    const nested = join(proj, 'ignored-dir', 'nested_repo');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', nested], { encoding: 'utf8' });
    writeFileSync(join(nested, 'inner.txt'), 'inner\n');

    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(r.skipped).toEqual([]);
    expect(await listTree(shadow, r.treeSha)).toEqual(['.gitignore', 'keep.txt']);
  });

  it('still reports a gitignored .env as skipped and keeps it out of the store', async () => {
    write('keep.txt', 'k\n');
    write('.gitignore', '.env\n');
    write('.env', 'API_KEY=also-secret\n');
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(r.skipped).toEqual([{ path: '.env', reason: 'denylist' }]);
    expect(await listTree(shadow, r.treeSha)).toEqual(['.gitignore', 'keep.txt']);
    const dump = execFileSync('git', ['--git-dir', shadow.gitDir, 'cat-file', '--batch-all-objects', '--batch'], { encoding: 'utf8' });
    expect(dump).not.toContain('also-secret');
  });

  it('skips files over the size cap and reports too_large', async () => {
    write('big.txt', 'x'.repeat(100));
    write('small.txt', 'ok\n');
    const shadow = await openShadow(data, proj, { maxFileBytes: 10 });
    const r = await snapshot(shadow);
    expect(r.skipped).toEqual([{ path: 'big.txt', reason: 'too_large' }]);
    expect(await listTree(shadow, r.treeSha)).toEqual(['small.txt']);
  });

  it('keeps a tracked file at its previous content when it grows past the cap, instead of deleting it', async () => {
    write('big.txt', 'small\n');
    const shadow = await openShadow(data, proj, { maxFileBytes: 10 });
    const r1 = await snapshot(shadow);
    expect(await listTree(shadow, r1.treeSha)).toContain('big.txt');

    write('big.txt', 'x'.repeat(100)); // now over the cap
    const r2 = await snapshot(shadow, { parent: r1.treeSha });
    expect(r2.skipped).toContainEqual({ path: 'big.txt', reason: 'too_large' });
    expect(await listTree(shadow, r2.treeSha)).toContain('big.txt'); // kept, not removed
    const files = await diff(shadow, r1.treeSha, r2.treeSha);
    expect(files.find((f) => f.path === 'big.txt')).toBeUndefined(); // unchanged in the tree: no false delete
  });

  it('keeps a tracked file at its previous content when it becomes unreadable, instead of deleting it', async () => {
    write('locked.txt', 'secretish\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    chmodSync(join(proj, 'locked.txt'), 0o000);
    try {
      const r2 = await snapshot(shadow, { parent: r1.treeSha });
      if (r2.skipped.some((s) => s.path === 'locked.txt')) {
        expect(await listTree(shadow, r2.treeSha)).toContain('locked.txt');
        const files = await diff(shadow, r1.treeSha, r2.treeSha);
        expect(files.find((f) => f.path === 'locked.txt')).toBeUndefined();
      }
    } finally {
      chmodSync(join(proj, 'locked.txt'), 0o644);
    }
  });

  it('reports unreadable files without failing the whole snapshot', async () => {
    write('locked.txt', 'secretish\n');
    write('ok.txt', 'fine\n');
    chmodSync(join(proj, 'locked.txt'), 0o000);
    const shadow = await openShadow(data, proj);
    try {
      const r = await snapshot(shadow);
      // Only assert when the sandbox actually enforces the permission bits (not running as root).
      if (r.skipped.some((s) => s.path === 'locked.txt')) {
        expect(r.skipped).toEqual([{ path: 'locked.txt', reason: 'unreadable' }]);
      }
      expect(await listTree(shadow, r.treeSha)).toContain('ok.txt');
    } finally {
      chmodSync(join(proj, 'locked.txt'), 0o644);
    }
  });

  it('gives unchanged:true and creates no new checkpoint ref when the tree has not changed', async () => {
    write('a.txt', 'stable\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    const refsBefore = listRefs(shadow);
    const r2 = await snapshot(shadow, { parent: r1.treeSha });
    expect(r2).toMatchObject({ treeSha: r1.treeSha, unchanged: true });
    expect(listRefs(shadow)).toEqual(refsBefore);
  });

  it('names checkpoint refs refs/digestit/cp/<seq>, keeping objects reachable', async () => {
    write('a.txt', 'v1\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    write('a.txt', 'v2\n');
    const r2 = await snapshot(shadow, { parent: r1.treeSha });
    const refs = listRefs(shadow);
    expect(refs).toContain(`refs/digestit/cp/1 ${r1.treeSha}`);
    expect(refs).toContain(`refs/digestit/cp/2 ${r2.treeSha}`);
  });

  it('snapshots a 5k-file fixture in under 5s', async () => {
    for (let i = 0; i < 5000; i++) {
      write(`gen/f${i}.txt`, `file number ${i}\n`);
    }
    const shadow = await openShadow(data, proj);
    const start = Date.now();
    const r = await snapshot(shadow);
    const elapsed = Date.now() - start;
    expect(r.unchanged).toBe(false);
    expect((await listTree(shadow, r.treeSha)).length).toBe(5000);
    // eslint-disable-next-line no-console
    console.log(`5k-file snapshot took ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});

function listRefs(shadow: Shadow): string[] {
  const out = execFileSync('git', ['--git-dir', shadow.gitDir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/digestit/cp'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

describe('listTree', () => {
  it('lists paths with spaces and non-ASCII characters', async () => {
    write('normal.txt', 'n\n');
    write('with space.txt', 's\n');
    write('café/naïve.txt', 'u\n');
    const shadow = await openShadow(data, proj);
    const r = await snapshot(shadow);
    expect(await listTree(shadow, r.treeSha)).toEqual(
      ['café/naïve.txt', 'normal.txt', 'with space.txt'].sort(),
    );
  });
});

describe('pending', () => {
  it('counts files/additions/deletions since a checkpoint without creating a new one', async () => {
    write('a.txt', 'one\ntwo\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    const refsBefore = listRefs(shadow);

    write('a.txt', 'one\ntwo\nthree\n'); // +1 line
    write('b.txt', 'new file\nsecond line\n'); // untracked, 2 lines

    const p = await pending(shadow, r1.treeSha);
    expect(p.files).toBe(2);
    expect(p.additions).toBeGreaterThanOrEqual(3); // 1 modified + 2 new lines
    expect(listRefs(shadow)).toEqual(refsBefore); // pending never snapshots
  });

  it('excludes denylisted and gitignored files from the pending count', async () => {
    write('a.txt', 'a\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    write('.env', 'SECRET=1\n');
    write('.gitignore', 'ignored-thing.txt\n');
    write('ignored-thing.txt', 'x\n');
    const p = await pending(shadow, r1.treeSha);
    expect(p.files).toBe(1); // only .gitignore itself is a real pending change
  });

  it('counts a mass tracked-file change without hitting argv limits', async () => {
    for (let i = 0; i < 500; i++) write(`gen/f${i}.txt`, `line ${i}\n`);
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    for (let i = 0; i < 500; i++) write(`gen/f${i}.txt`, `line ${i}\nextra\n`);
    const p = await pending(shadow, r1.treeSha);
    expect(p.files).toBe(500);
    expect(p.additions).toBe(500);
  });
});

describe('env hardening', () => {
  it('ignores inherited GIT_* vars that could redirect the store', async () => {
    write('a.txt', 'x\n');
    const shadow = await openShadow(data, proj);
    const bogusGitDir = join(root, 'bogus.git');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY };
    process.env.GIT_DIR = bogusGitDir;
    process.env.GIT_OBJECT_DIRECTORY = join(bogusGitDir, 'objects');
    try {
      const r = await snapshot(shadow);
      expect(await listTree(shadow, r.treeSha)).toEqual(['a.txt']);
      expect(existsSync(bogusGitDir)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe('snapshot concurrency', () => {
  it('serializes concurrent snapshot calls on the same shadow instead of racing the shared index', async () => {
    write('a.txt', 'v1\n');
    const shadow = await openShadow(data, proj);
    const r1 = await snapshot(shadow);
    write('b.txt', 'v2\n');
    const [r2, r3] = await Promise.all([
      snapshot(shadow, { parent: r1.treeSha }),
      snapshot(shadow, { parent: r1.treeSha }),
    ]);
    expect(r2.treeSha).toBe(r3.treeSha);
    expect(await listTree(shadow, r2.treeSha)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('userGitInfo', () => {
  it('returns null for a folder that is not a git repo', async () => {
    write('a.txt', 'x\n');
    expect(await userGitInfo(proj)).toBeNull();
  });

  it('returns head and branch for a real git repo, read-only', async () => {
    gitProj('init', '-q', '-b', 'main');
    write('a.txt', 'x\n');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A');
    gitProj('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    const sha = gitProj('rev-parse', 'HEAD');
    const before = snapshotFsState(join(proj, '.git'));
    const info = await userGitInfo(proj);
    const after = snapshotFsState(join(proj, '.git'));
    expect(info).toEqual({ head: sha, branch: 'main' });
    expect(after).toEqual(before);
  });
});

describe('matchesDenylist', () => {
  it('matches file patterns anywhere in the tree', () => {
    expect(matchesDenylist('.env')).toBe(true);
    expect(matchesDenylist('sub/.env.local')).toBe(true);
    expect(matchesDenylist('deploy.pem')).toBe(true);
    expect(matchesDenylist('id_ed25519.pub')).toBe(true);
    expect(matchesDenylist('a/b/credentials.json')).toBe(true);
  });

  it('matches denylisted directories anywhere, not just at the root', () => {
    expect(matchesDenylist('packages/app/node_modules/x.js')).toBe(true);
    expect(matchesDenylist('target/debug/build')).toBe(true);
  });

  it('does not match ordinary files', () => {
    expect(matchesDenylist('src/index.ts')).toBe(false);
    expect(matchesDenylist('README.md')).toBe(false);
  });
});
