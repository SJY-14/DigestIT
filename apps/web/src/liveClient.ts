export const POLL_MS = 30_000;
const DEBOUNCE_MS = 250;

export type Transport = 'live' | 'polling';

export interface LiveDeps {
  onChange: () => void;
  onTransport: (t: Transport) => void;
  /** Injected for tests. */
  EventSourceCtor?: typeof EventSource | undefined;
  pollMs?: number;
}

/**
 * Subscribe to /api/stream; while it is not connected, poll every 30 s instead.
 * `ready` fires on every (re)connect and means "refetch": events missed meanwhile are not replayed.
 */
export function startLive(d: LiveDeps): () => void {
  const pollMs = d.pollMs ?? POLL_MS;
  let poll: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const changed = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => !stopped && d.onChange(), DEBOUNCE_MS);
  };
  const startPolling = () => {
    d.onTransport('polling');
    poll ??= setInterval(() => d.onChange(), pollMs);
  };
  const stopPolling = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };

  const ES = d.EventSourceCtor ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
  let es: EventSource | null = null;
  if (!ES) {
    startPolling();
  } else {
    es = new ES('/api/stream');
    es.addEventListener('ready', () => {
      stopPolling();
      d.onTransport('live');
      changed();
    });
    es.addEventListener('changed', changed);
    // The browser retries a dropped stream by itself (server hint: 3 s); poll until it is back.
    es.onerror = startPolling;
  }
  return () => {
    stopped = true;
    stopPolling();
    if (debounce) clearTimeout(debounce);
    es?.close();
  };
}
