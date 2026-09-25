import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateToken, loadTokenFile, resolveAccess, runTokenCli, tokensMatch } from './auth.js';

const dir = () => mkdtempSync(join(tmpdir(), 'digestit-token-'));

describe('loadTokenFile', () => {
  it('reads a trimmed token from a 0600 file', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, 'abc123\n', { mode: 0o600 });
    expect(loadTokenFile(file)).toBe('abc123');
  });

  it('rejects a file that is not mode 0600', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, 'abc123\n');
    chmodSync(file, 0o644); // writeFileSync's mode option is umask-dependent; force it explicitly
    expect(() => loadTokenFile(file)).toThrow(/0600/);
  });

  it('rejects a missing file', () => {
    expect(() => loadTokenFile(join(dir(), 'nope'))).toThrow();
  });

  it('rejects an empty token file', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, '', { mode: 0o600 });
    expect(() => loadTokenFile(file)).toThrow(/empty/);
  });
});

describe('resolveAccess', () => {
  it('is a no-op (no auth) when DIGESTIT_ALLOWED_HOSTS is unset', () => {
    const { allowedHosts, auth } = resolveAccess({});
    expect(allowedHosts.size).toBe(0);
    expect(auth).toBeUndefined();
  });

  it('fails closed when DIGESTIT_ALLOWED_HOSTS is set but DIGESTIT_TOKEN_FILE is not', () => {
    expect(() => resolveAccess({ DIGESTIT_ALLOWED_HOSTS: 'example.ts.net:4780' })).toThrow(/DIGESTIT_TOKEN_FILE/);
  });

  it('fails closed when the token file is misconfigured', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, 'abc123\n');
    chmodSync(file, 0o644);
    expect(() =>
      resolveAccess({ DIGESTIT_ALLOWED_HOSTS: 'example.ts.net:4780', DIGESTIT_TOKEN_FILE: file }),
    ).toThrow(/0600/);
  });

  it('resolves the allowlist and token when configured correctly', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, 'abc123\n', { mode: 0o600 });
    const { allowedHosts, auth } = resolveAccess({
      DIGESTIT_ALLOWED_HOSTS: 'Example.ts.net:4780, other.ts.net:4780',
      DIGESTIT_TOKEN_FILE: file,
    });
    expect(allowedHosts).toEqual(new Set(['example.ts.net:4780', 'other.ts.net:4780']));
    expect(auth).toEqual({ token: 'abc123' });
  });
});

describe('tokensMatch', () => {
  it('matches equal tokens and rejects different ones, any length', () => {
    expect(tokensMatch('a', 'a')).toBe(true);
    expect(tokensMatch('a', 'b')).toBe(false);
    expect(tokensMatch('short', 'a-much-longer-token-value')).toBe(false);
  });
});

describe('generateToken', () => {
  it('produces distinct, reasonably long tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe('runTokenCli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a 0600 token file and prints the login URL with the given host', () => {
    const file = join(dir(), 'token');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => logs.push(s));
    const code = runTokenCli(['token', 'init', '--host', 'dashboard.example.ts.net:4780', '--file', file]);
    expect(code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(logs.join('\n')).toContain(`http://dashboard.example.ts.net:4780/?token=${token}`);
  });

  it('appends the default port when --host has none', () => {
    const file = join(dir(), 'token');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => logs.push(s));
    runTokenCli(['token', 'init', '--host', 'dashboard.example.ts.net', '--file', file]);
    expect(logs.join('\n')).toContain('dashboard.example.ts.net:4780/?token=');
  });

  it('forces 0600 even when overwriting a file with looser permissions', () => {
    const file = join(dir(), 'token');
    writeFileSync(file, 'old', { mode: 0o644 });
    chmodSync(file, 0o644);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runTokenCli(['token', 'init', '--host', 'h:4780', '--file', file]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('errors with usage when --host or --file is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runTokenCli(['token', 'init', '--host', 'h:4780'])).toBe(2);
    expect(runTokenCli(['token', 'init', '--file', join(dir(), 'token')])).toBe(2);
    expect(runTokenCli(['token', 'nonsense'])).toBe(2);
  });
});
