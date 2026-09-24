import { describe, expect, it, vi } from 'vitest';

const runExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('@digestit/explain', () => ({ runExplainCli }));
const runWatchCli = vi.fn(async (_argv: string[]) => 0);
const runManualExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('./watch.js', () => ({ runWatchCli, runManualExplainCli }));
const { routeDigest } = await import('./route.js');

describe('routeDigest', () => {
  it('delegates `explain` with full argv to the explain CLI', async () => {
    const argv = ['explain', '--unit', '3', '--max-calls', '1'];
    expect(await routeDigest(argv)).toBe(0);
    expect(runExplainCli).toHaveBeenCalledWith(argv);
  });
  it('sends `explain --unit <work-unit key>` to the scheduler, numeric ids to the explain CLI', async () => {
    runExplainCli.mockClear();
    expect(await routeDigest(['explain', '--unit', 'DIG-14'])).toBe(0);
    expect(runManualExplainCli).toHaveBeenCalledWith(['explain', '--unit', 'DIG-14']);
    expect(runExplainCli).not.toHaveBeenCalled();
    await routeDigest(['explain', '--unit', '3,4']);
    expect(runExplainCli).toHaveBeenCalledTimes(1);
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
  it('delegates `watch <path>` to the watcher', async () => {
    expect(await routeDigest(['watch', '/repo', '--interval', '2'])).toBe(0);
    expect(runWatchCli).toHaveBeenCalledWith(['watch', '/repo', '--interval', '2']);
  });
  it('rejects unknown commands with usage', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await routeDigest(['bogus'])).toBe(2);
    expect(await routeDigest(['ingest'])).toBe(2);
    err.mockRestore();
  });
});
