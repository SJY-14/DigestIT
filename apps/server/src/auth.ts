import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';

// Mirrors serve.ts's DEFAULT_PORT (not imported, to avoid a serve.ts <-> auth.ts cycle).
const DEFAULT_PORT = 4780;

export const SESSION_COOKIE = 'digestit_session';

export interface AuthOptions {
  /** The one valid token. Its presence on AppOptions means every route requires a credential. */
  token: string;
}

/** Reads and validates a token file: must exist, be a regular file, mode 0600, and hold a non-empty token. */
export function loadTokenFile(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`DIGESTIT_TOKEN_FILE is not a regular file: ${path}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`DIGESTIT_TOKEN_FILE must be mode 0600 (owner read/write only), got ${mode.toString(8)}: ${path}`);
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!token) throw new Error(`DIGESTIT_TOKEN_FILE is empty: ${path}`);
  return token;
}

export interface ResolvedAccess {
  allowedHosts: Set<string>;
  auth?: AuthOptions;
}

/**
 * Allowed hosts + access token from env. Fails closed: once DIGESTIT_ALLOWED_HOSTS names any
 * host, a valid DIGESTIT_TOKEN_FILE is mandatory or the process throws before it ever binds a port.
 */
export function resolveAccess(env: NodeJS.ProcessEnv = process.env): ResolvedAccess {
  const allowedHosts = new Set(
    (env.DIGESTIT_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedHosts.size === 0) return { allowedHosts };
  const tokenFile = env.DIGESTIT_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error('DIGESTIT_ALLOWED_HOSTS is set but DIGESTIT_TOKEN_FILE is not; refusing to start without an access token');
  }
  return { allowedHosts, auth: { token: loadTokenFile(tokenFile) } };
}

/** Constant-time equality on digests, so callers never compare raw token lengths either. */
export function tokensMatch(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export const TOKEN_USAGE =
  'usage: digest token init --host <host[:port]> [--file <path>] [--port <n>]\n' +
  '  writes a fresh token to --file (or $DIGESTIT_TOKEN_FILE), mode 0600, and prints the one-time login URL\n' +
  '  --port defaults to $DIGESTIT_PORT or 4780 and is only used when --host has no port';

/** `digest token init`: create the token file (0600) and print the one-time `/?token=` login URL. */
export function runTokenCli(argv: string[]): number {
  const [, sub, ...rest] = argv;
  if (sub !== 'init') {
    console.error(TOKEN_USAGE);
    return 2;
  }
  let values: { host?: string; file?: string; port?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { host: { type: 'string' }, file: { type: 'string' }, port: { type: 'string' } },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${TOKEN_USAGE}`);
    return 2;
  }
  const file = values.file ?? process.env.DIGESTIT_TOKEN_FILE;
  if (!values.host || !file) {
    console.error(TOKEN_USAGE);
    return 2;
  }
  const token = generateToken();
  // Write a fresh 0600 file and rename it over the target, so the new token is never written
  // into an existing file that still has looser permissions (writeFileSync's mode only applies
  // on create; a later chmod would leave a window where another user could read it).
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600); // exact mode regardless of umask; loadTokenFile requires 0600
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    console.error(`token init failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const port = values.port ?? process.env.DIGESTIT_PORT ?? String(DEFAULT_PORT);
  const host = values.host.includes(':') ? values.host : `${values.host}:${port}`;
  console.log(`wrote token to ${file} (mode 0600)`);
  console.log(`login URL: http://${host}/?token=${token}`);
  return 0;
}
