import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLive } from './liveClient.js';

class FakeES {
  static last: FakeES;
  handlers = new Map<string, () => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(k: string, f: () => void) { this.handlers.set(k, f); }
  close() { this.closed = true; }
}
const ES = FakeES as unknown as typeof EventSource;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startLive', () => {
  it('refetches (debounced) on stream events', () => {
    const onChange = vi.fn();
    const onTransport = vi.fn();
    startLive({ onChange, onTransport, EventSourceCtor: ES });
    FakeES.last.handlers.get('ready')!();
    FakeES.last.handlers.get('changed')!();
    FakeES.last.handlers.get('changed')!();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onTransport).toHaveBeenLastCalledWith('live');
  });
  it('polls every 30 s while the stream is down and stops when it is back', () => {
    const onChange = vi.fn();
    startLive({ onChange, onTransport: vi.fn(), EventSourceCtor: ES });
    FakeES.last.onerror!();
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    FakeES.last.handlers.get('ready')!();
    onChange.mockClear();
    vi.advanceTimersByTime(29_000);
    expect(onChange).toHaveBeenCalledTimes(1); // only the debounced refetch from `ready`
  });
  it('polls without EventSource and cleans up', () => {
    const onChange = vi.fn();
    const onTransport = vi.fn();
    const stop = startLive({ onChange, onTransport, EventSourceCtor: undefined, pollMs: 1000 });
    // In node there is no global EventSource, so this exercises the fallback.
    if (typeof EventSource === 'undefined') {
      vi.advanceTimersByTime(2500);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onTransport).toHaveBeenCalledWith('polling');
    }
    stop();
    onChange.mockClear();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
