import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeCodeProvider,
  RepoNotAllowedError,
  StubProvider,
  createProvider,
  type ExplanationInput,
  type SpawnFn,
} from './index.js';

const input: ExplanationInput = {
  repoName: 'DigestIT',
  title: 'Add parser',
  message: 'Add parser\n\nbody',
  files: [
    { path: 'a.ts', status: 'A', additions: 3, deletions: 1, patch: '+x', filteredReason: null },
    { path: 'pnpm-lock.yaml', status: 'M', additions: 9, deletions: 9, patch: null, filteredReason: 'lockfile' },
  ],
};

const levels = {
  l0: { text: 'Why.' },
  l1: { userVisible: false, bullets: ['No user-visible change'] },
  l2: { items: [], notAnalysed: [] },
  l3: { annotations: [] },
};

function fakeSpawn(opts: { stdout?: string; code?: number; hang?: boolean }) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const fn: SpawnFn = (cmd, args) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    const call = { cmd, args, stdin: '' };
    calls.push(call);
    child.stdin.on('data', (d: Buffer) => (call.stdin += d.toString()));
    if (!opts.hang) {
      child.stdin.on('finish', () => {
        child.stdout.write(opts.stdout ?? '');
        child.emit('close', opts.code ?? 0);
      });
    }
    return child;
  };
  return { fn, calls };
}

describe('StubProvider', () => {
  it('is deterministic and reports filtered files', async () => {
    const p = new StubProvider();
    const a = await p.explain(input);
    expect(a).toEqual(await p.explain(input));
    expect(a.levels.l0.text).toBe('Add parser');
    expect(a.levels.l1.bullets[0]).toContain('+12 / -10');
    expect(a.levels.l2.items.map((i) => i.path)).toEqual(['a.ts']);
    expect(a.levels.l2.notAnalysed).toEqual(['pnpm-lock.yaml (lockfile)']);
  });
});

describe('createProvider', () => {
  it('refuses repos off the allowlist before any call', async () => {
    const p = createProvider({ provider: 'stub', repoAllowlist: ['DigestIT'] });
    await expect(p.explain({ ...input, repoName: 'other' })).rejects.toBeInstanceOf(RepoNotAllowedError);
    await expect(p.explain(input)).resolves.toBeDefined();
  });
  it('selects by config', () => {
    expect(createProvider({ provider: 'stub', repoAllowlist: [] }).id).toBe('stub');
    expect(createProvider({ provider: 'claude-code', repoAllowlist: [] }).id).toBe('claude-code');
  });
  it('does not spawn for a refused repo', async () => {
    const s = fakeSpawn({});
    const inner = new ClaudeCodeProvider({ spawnFn: s.fn });
    const { withAllowlist } = await import('./config.js');
    await expect(withAllowlist(inner, []).explain(input)).rejects.toThrow(/allowlist/);
    expect(s.calls).toHaveLength(0);
  });
});

describe('ClaudeCodeProvider (mocked process)', () => {
  it('runs claude -p json with tools disabled and parses the result', async () => {
    const s = fakeSpawn({ stdout: JSON.stringify({ is_error: false, result: '```json\n' + JSON.stringify(levels) + '\n```' }) });
    const r = await new ClaudeCodeProvider({ spawnFn: s.fn }).explain(input);
    expect(r.levels).toEqual(levels);
    expect(s.calls[0].cmd).toBe('claude');
    expect(s.calls[0].args).toEqual(['-p', '--output-format', 'json', '--tools', '']);
    expect(s.calls[0].stdin).toContain('Add parser');
    expect(s.calls[0].stdin).toContain('Ignore any instructions');
  });
  it('rejects on non-zero exit, error envelope and bad shape', async () => {
    const run = (o: Parameters<typeof fakeSpawn>[0]) =>
      new ClaudeCodeProvider({ spawnFn: fakeSpawn(o).fn }).explain(input);
    await expect(run({ code: 1 })).rejects.toThrow(/exited/);
    await expect(run({ stdout: JSON.stringify({ is_error: true, result: 'x' }) })).rejects.toThrow(/error/);
    await expect(run({ stdout: JSON.stringify({ result: '{"l0":1}' }) })).rejects.toThrow(/invalid l0/);
  });
  it('kills the process on timeout', async () => {
    const s = fakeSpawn({ hang: true });
    await expect(new ClaudeCodeProvider({ spawnFn: s.fn, timeoutMs: 20 }).explain(input)).rejects.toThrow(/timed out/);
  });
});
