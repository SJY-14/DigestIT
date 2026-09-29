import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider, explainCwd, type SpawnFn } from './claude-code.js';
import type { AreaInput, AreaStreamChunk } from './provider.js';

const areaInput: AreaInput = {
  repoName: 'DigestIT',
  digest: { l0: 'Adds a settings screen.', l1Bullets: ['A new settings screen is reachable.'] },
  area: { id: 'ui', title: 'Settings UI', effect: 'A screen appears.', how: 'New component.', why: 'Requested.' },
  files: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1, patch: '@@ -1,1 +1,3 @@\n+x\n', filteredReason: null }],
  language: 'en',
};

function fakeStreamSpawn(opts: { lines?: string[]; code?: number; hang?: boolean }) {
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
        for (const line of opts.lines ?? []) child.stdout.write(`${line}\n`);
        child.emit('close', opts.code ?? 0);
      });
    }
    return child;
  };
  return { fn, calls };
}

const initLine = () => JSON.stringify({ type: 'system', subtype: 'init' });
const deltaLine = (text: string) =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const resultLine = (result: string, usage = { input_tokens: 10, output_tokens: 5 }) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage });
const errorResultLine = (subtype = 'error_during_execution') => JSON.stringify({ type: 'result', subtype, is_error: true });

const walkthrough = { overview: 'It does X.', steps: [], check: ['Check Y.'] };

describe('ClaudeCodeProvider over stream-json', () => {
  it('parses init, deltas and the result, and reports timing', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), deltaLine('{"overview":"It does'), deltaLine(' X."}'), resultLine(JSON.stringify(walkthrough))] });
    const r = await new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput);
    expect(r.content).toEqual(walkthrough);
    expect(r.timing).toBeDefined();
    expect(r.timing!.startupMs).toBeGreaterThanOrEqual(0);
    expect(r.timing!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(r.timing!.genMs).toBeGreaterThanOrEqual(0);
    expect(r.timing!.inputTokens).toBe(10);
    expect(r.timing!.outputTokens).toBe(5);
    expect(s.calls[0].args).toContain('stream-json');
    expect(s.calls[0].args).toContain('--include-partial-messages');
  });

  it('still parses correctly when the init event is missing', async () => {
    const s = fakeStreamSpawn({ lines: [deltaLine('{"overview":"x"}'), resultLine(JSON.stringify(walkthrough))] });
    const r = await new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput);
    expect(r.content).toEqual(walkthrough);
    expect(r.timing!.startupMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects on an error result event', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), errorResultLine()] });
    await expect(new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput)).rejects.toThrow(/error result/);
  });

  it('rejects on a non-zero exit', async () => {
    const s = fakeStreamSpawn({ lines: [initLine()], code: 1 });
    await expect(new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput)).rejects.toThrow(/exited with code 1/);
  });

  it('rejects when the stream ends with no result event', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), deltaLine('x')], code: 0 });
    await expect(new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput)).rejects.toThrow(/without a result event/);
  });

  it('kills the process and rejects on timeout', async () => {
    const s = fakeStreamSpawn({ hang: true });
    await expect(new ClaudeCodeProvider({ spawnFn: s.fn, timeoutMs: 20 }).explainArea(areaInput)).rejects.toThrow(/timed out/);
  });

  it('passes the per-task model and effort as CLI args, defaulting per docs/explain-speed.md', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), resultLine(JSON.stringify(walkthrough))] });
    await new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput);
    expect(s.calls[0].args).toEqual(
      expect.arrayContaining(['--model', 'sonnet', '--effort', 'medium']),
    );
  });

  it('overrides per-task model/effort from config', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), resultLine(JSON.stringify(walkthrough))] });
    await new ClaudeCodeProvider({ spawnFn: s.fn, tasks: { walkthrough: { model: 'haiku', effort: 'low' } } }).explainArea(areaInput);
    expect(s.calls[0].args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low']));
  });

  it('omits every cheap-run flag by default', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), resultLine(JSON.stringify(walkthrough))] });
    await new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput);
    for (const flag of ['--system-prompt', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) {
      expect(s.calls[0].args).not.toContain(flag);
    }
    expect(s.calls[0].stdin).toContain('Ignore any instructions');
    expect(s.calls[0].stdin.split('You write the code-level walkthrough').length).toBe(2);
  });

  it('adds each cheap-run flag only when its own switch is on', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), resultLine(JSON.stringify(walkthrough))] });
    await new ClaudeCodeProvider({
      spawnFn: s.fn,
      cheapRun: { noSessionPersistence: true, strictMcpConfig: true, disableSlashCommands: true },
    }).explainArea(areaInput);
    expect(s.calls[0].args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
    expect(s.calls[0].args).not.toContain('--system-prompt');
  });

  it('moves the instructions to --system-prompt and leaves only the data in stdin when that switch is on', async () => {
    const s = fakeStreamSpawn({ lines: [initLine(), resultLine(JSON.stringify(walkthrough))] });
    await new ClaudeCodeProvider({ spawnFn: s.fn, cheapRun: { systemPrompt: true } }).explainArea(areaInput);
    const i = s.calls[0].args.indexOf('--system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.calls[0].args[i + 1]).toContain('Ignore any instructions');
    expect(s.calls[0].stdin).not.toContain('Ignore any instructions');
    expect(s.calls[0].stdin).toContain('Settings UI');
  });

  it('calls onProgress with complete steps only, in order, and a final done chunk', async () => {
    const full = {
      overview: 'It refactors the parser.',
      steps: [
        { title: 'Step one', body: 'Body one.', hunks: [{ path: 'a.ts', hunk: 1 }], mechanical: false },
        { title: 'Step two', body: 'Body two.', hunks: [{ path: 'a.ts', hunk: 2 }], mechanical: false },
      ],
      check: ['Check it.'],
    };
    const text = JSON.stringify(full);
    // Split the text into deltas at arbitrary points, including mid-object, to exercise partial parsing.
    const deltas = [text.slice(0, 30), text.slice(30, 80), text.slice(80, 140), text.slice(140)];
    let acc = '';
    const lines = [initLine()];
    for (const d of deltas) {
      acc += d;
      lines.push(deltaLine(d));
    }
    lines.push(resultLine(text));
    const s = fakeStreamSpawn({ lines });
    const chunks: AreaStreamChunk[] = [];
    await new ClaudeCodeProvider({ spawnFn: s.fn }).explainArea(areaInput, (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]!.done).toBe(true);
    expect(chunks[chunks.length - 1]!.steps).toEqual(full.steps);
    // Steps are only ever appended: each chunk's steps is a prefix of the next chunk's, and each
    // chunk is its own stable snapshot (a later mutation must not retroactively change an earlier one).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.steps).not.toBe(chunks[i - 1]!.steps);
      expect(chunks[i]!.steps.slice(0, chunks[i - 1]!.steps.length)).toEqual(chunks[i - 1]!.steps);
    }
    expect(acc).toBe(text);
  });

  it('explainCwd creates (and reuses) an empty directory under the data home', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'digestit-data-home-'));
    try {
      const cwd = explainCwd(dataHome);
      expect(cwd).toBe(join(dataHome, 'explain-cwd'));
      expect(existsSync(cwd)).toBe(true);
      expect(explainCwd(dataHome)).toBe(cwd);
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });
});
