import { describe, expect, it, vi } from 'vitest';

const runExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('@digestit/explain', () => ({ runExplainCli }));
const runWatchCli = vi.fn(async (_argv: string[]) => 0);
const runManualExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('./watch.js', () => ({ runWatchCli, runManualExplainCli }));
const runInitCli = vi.fn(async (_argv: string[]) => 0);
const runProjectsCli = vi.fn(async (_argv: string[]) => 0);
const runStatusCli = vi.fn(async (_argv: string[]) => 0);
const runProjectExplainCli = vi.fn(async (_argv: string[]) => 0);
vi.mock('./project-cli.js', () => ({ runInitCli, runProjectsCli, runStatusCli, runProjectExplainCli }));
const { routeDigest } = await import('./route.js');

describe('routeDigest', () => {
  it('delegates `explain --all` and `explain --unit <id>` to the v1 explain CLI', async () => {
    const argv = ['explain', '--unit', '3', '--max-calls', '1'];
    expect(await routeDigest(argv)).toBe(0);
    expect(runExplainCli).toHaveBeenCalledWith(argv);
    runExplainCli.mockClear();
    const all = ['explain', '--all'];
    expect(await routeDigest(all)).toBe(0);
    expect(runExplainCli).toHaveBeenCalledWith(all);
  });
  it('sends `explain --unit <work-unit key>` to the scheduler, numeric ids to the explain CLI', async () => {
    runExplainCli.mockClear();
    expect(await routeDigest(['explain', '--unit', 'DIG-14'])).toBe(0);
    expect(runManualExplainCli).toHaveBeenCalledWith(['explain', '--unit', 'DIG-14']);
    expect(runExplainCli).not.toHaveBeenCalled();
    await routeDigest(['explain', '--unit', '3,4']);
    expect(runExplainCli).toHaveBeenCalledTimes(1);
  });
  it('propagates the v1 explain exit code', async () => {
    runExplainCli.mockResolvedValueOnce(2);
    expect(await routeDigest(['explain', '--all'])).toBe(2);
  });
  it('sends bare `explain` and `explain <project>` to the v2 project explain CLI', async () => {
    expect(await routeDigest(['explain'])).toBe(0);
    expect(runProjectExplainCli).toHaveBeenCalledWith(['explain']);
    runProjectExplainCli.mockClear();
    expect(await routeDigest(['explain', 'my-project'])).toBe(0);
    expect(runProjectExplainCli).toHaveBeenCalledWith(['explain', 'my-project']);
    runProjectExplainCli.mockClear();
    expect(await routeDigest(['explain', '--retry', '5'])).toBe(0);
    expect(runProjectExplainCli).toHaveBeenCalledWith(['explain', '--retry', '5']);
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
  it('delegates `init`, `projects` and `status` to the project CLI', async () => {
    expect(await routeDigest(['init', '/repo', '--name', 'x'])).toBe(0);
    expect(runInitCli).toHaveBeenCalledWith(['init', '/repo', '--name', 'x']);
    expect(await routeDigest(['projects'])).toBe(0);
    expect(runProjectsCli).toHaveBeenCalledWith(['projects']);
    expect(await routeDigest(['status', 'my-project'])).toBe(0);
    expect(runStatusCli).toHaveBeenCalledWith(['status', 'my-project']);
  });
  it('rejects unknown commands with usage', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await routeDigest(['bogus'])).toBe(2);
    expect(await routeDigest(['ingest'])).toBe(2);
    expect(await routeDigest(['init'])).toBe(2);
    err.mockRestore();
  });
});
