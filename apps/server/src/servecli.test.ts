import { afterEach, describe, expect, it, vi } from 'vitest';
import { runServeCli } from './servecli.js';

describe('runServeCli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a malformed --port before attempting to bind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runServeCli(['serve', '--port', 'not-a-number'])).toBe(1);
  });

  it('rejects an unknown flag', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runServeCli(['serve', '--bogus'])).toBe(2);
  });
});
