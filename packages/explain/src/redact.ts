export const REDACTED = '[REDACTED]';

const PEM =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|(?=\n[+\- ]?\s*\n)|$)/g;

/** Whole-token patterns: the match is replaced entirely. */
const TOKENS: RegExp[] = [
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, // GitHub fine-grained
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, // user:pass@ in URLs (replaced with scheme kept below)
];

/**
 * `name = value` assignments where the name looks secret; only the value is replaced.
 * The value must look like a literal (quoted, or a bare token not followed by `.`/`(`),
 * so code such as `author: c.authorName` or `tokenizer = makeTokenizer()` is left alone.
 */
const ASSIGNMENT =
  /(\b[A-Za-z0-9_.-]*?(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|credentials?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:(["'`])([^"'`\s]{8,})\2|([A-Za-z0-9_+/=-]{8,})(?![A-Za-z0-9_+/=.(-]))/gi;

const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;

export function redact(text: string): string {
  let out = text.replace(PEM, REDACTED);
  for (const re of TOKENS) {
    out = out.replace(re, (m) => {
      const url = /^([a-z][a-z0-9+.-]*:\/\/)/i.exec(m);
      return url && m.endsWith('@') ? `${url[1]}${REDACTED}@` : REDACTED;
    });
  }
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(ASSIGNMENT, (_m, k: string, q: string | undefined) => `${k}${q ?? ''}${REDACTED}${q ?? ''}`);
  return out;
}
