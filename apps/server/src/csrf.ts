import type { FastifyRequest } from 'fastify';

export type Reject = { code: number; error: string };

export const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * CSRF gate for a browser-originated write: same-origin fetch plus our custom header (a
 * cross-origin `<form>` post can set almost any header value, but the fetch spec forbids a
 * cross-origin request from setting a custom header without a preflight the origin has to opt
 * into, so requiring one here is enough to rule out simple form-based CSRF).
 */
export function checkSameOrigin(req: FastifyRequest): Reject | null {
  const origin = header(req, 'origin');
  const host = header(req, 'host');
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    /* malformed → rejected below */
  }
  if (!originHost || !host || originHost !== host) return { code: 403, error: 'bad_origin' };
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return { code: 403, error: 'cross_site' };
  if (header(req, 'x-digestit') !== '1') return { code: 403, error: 'missing_header' };
  return null;
}
