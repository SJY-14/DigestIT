import { describe, expect, it, vi } from 'vitest';

const runExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('@digestit/explain', () => ({ runExplainCli }));
const { routeDigest } = await import('./route.js');

describe('routeDigest', () => {
  it('delegates `explain` with full argv to the explain CLI', async () => {
    const argv = ['explain', '--unit', '3', '--max-calls', '1'];
    expect(await routeDigest(argv)).toBe(0);
    expect(runExplainCli).toHaveBeenCalledWith(argv);
  });
  it('propagates the explain exit code', async () => {
    runExplainCli.mockResolvedValueOnce(2);
    expect(await routeDigest(['explain'])).toBe(2);
  });
  it('leaves `ingest <path>` to the ingest handler', async () => {
    runExplainCli.mockClear();
    expect(await routeDigest(['ingest', '/repo'])).toBeUndefined();
    expect(runExplainCli).not.toHaveBeenCalled();
  });
  it('rejects unknown commands with usage', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await routeDigest(['bogus'])).toBe(2);
    expect(await routeDigest(['ingest'])).toBe(2);
    err.mockRestore();
  });
});
