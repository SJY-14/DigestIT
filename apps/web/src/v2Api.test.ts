import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AreaProgressEvent } from '@digestit/core';
import { ApiError, deleteProject, openDigestEvents } from './v2Api.js';

class FakeES {
  static last: FakeES;
  handlers = new Map<string, (ev: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(k: string, f: (ev: { data: string }) => void) { this.handlers.set(k, f); }
  close() { this.closed = true; }
  emit(k: string, data: unknown = {}) { this.handlers.get(k)?.({ data: JSON.stringify(data) }); }
}
const ES = FakeES as unknown as typeof EventSource;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const progress: AreaProgressEvent = { areaId: 'apps-web', overview: 'o', steps: [], done: false };

describe('openDigestEvents', () => {
  it('connects to the digest’s events endpoint', () => {
    openDigestEvents(41, { onChange: vi.fn(), onProgress: vi.fn(), EventSourceCtor: ES });
    expect(FakeES.last.url).toBe('/api/digests/41/events');
  });

  it('refetches on every `parts` event, including the first (the server sends it on connect)', () => {
    const onChange = vi.fn();
    openDigestEvents(41, { onChange, onProgress: vi.fn(), EventSourceCtor: ES });
    FakeES.last.emit('parts');
    expect(onChange).toHaveBeenCalledTimes(1);
    FakeES.last.emit('parts');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('parses `area-progress` payloads and hands them to onProgress', () => {
    const onProgress = vi.fn();
    openDigestEvents(41, { onChange: vi.fn(), onProgress, EventSourceCtor: ES });
    FakeES.last.emit('area-progress', progress);
    expect(onProgress).toHaveBeenCalledWith(progress);
  });

  it('closes the stream and calls onDone on `done`', () => {
    const onDone = vi.fn();
    openDigestEvents(41, { onChange: vi.fn(), onProgress: vi.fn(), onDone, EventSourceCtor: ES });
    FakeES.last.emit('done');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(FakeES.last.closed).toBe(true);
  });

  it('falls back to polling every 2s when the stream errors, and stops once `parts` arrives again', () => {
    const onChange = vi.fn();
    openDigestEvents(41, { onChange, onProgress: vi.fn(), EventSourceCtor: ES });
    FakeES.last.onerror!();
    vi.advanceTimersByTime(6000);
    expect(onChange).toHaveBeenCalledTimes(3); // polled at 2s, 4s, 6s
    onChange.mockClear();
    FakeES.last.emit('parts');
    vi.advanceTimersByTime(6000);
    expect(onChange).toHaveBeenCalledTimes(1); // only the `parts` refetch; polling stopped
  });

  it('polls without EventSource support', () => {
    const onChange = vi.fn();
    const stop = openDigestEvents(41, { onChange, onProgress: vi.fn(), EventSourceCtor: undefined, pollMs: 1000 });
    vi.advanceTimersByTime(2500);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    onChange.mockClear();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the returned cleanup closes the stream and stops any polling', () => {
    const onChange = vi.fn();
    const stop = openDigestEvents(41, { onChange, onProgress: vi.fn(), EventSourceCtor: ES });
    FakeES.last.onerror!();
    stop();
    expect(FakeES.last.closed).toBe(true);
    vi.advanceTimersByTime(6000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('deleteProject', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the JSON content type and body the server’s v2 write gate requires', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteProject(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/7');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-digestit': '1' });
    expect(init.body).toBe('{}');
  });

  it('surfaces the server’s error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'explain_running' }, { status: 409 })));
    await expect(deleteProject(7)).rejects.toEqual(new ApiError('explain_running', 409));
  });
});
