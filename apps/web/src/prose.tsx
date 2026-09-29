import type { ReactNode } from 'react';

// Inline rendering for explanation prose (DIG-70): the model wraps identifiers in backticks and
// writes bare CLI flags, and plain-text rendering left both unreadable (literal backticks; a
// `--flag` wrapping between its dashes and its name). No markdown/HTML parsing: this only ever
// splits the input string and wraps the pieces in text nodes, so it cannot inject markup.
// - `` `x` `` becomes <code>x</code>, backticks dropped. An unmatched backtick (no closing tick
//   anywhere after it) is left as a literal character.
// - A bare `--flag` outside backticks gets a no-wrap span so the leading "--" never splits from
//   its name at a line break.
const TOKEN_RE = /`([^`]+)`|(--[a-z][\w-]*)/g;

export function renderProse(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const re = new RegExp(TOKEN_RE);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      m[1] !== undefined
        ? <code key={key++} className="inline-code">{m[1]}</code>
        : <span key={key++} className="flag">{m[0]}</span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
