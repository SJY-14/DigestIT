import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { proseLabel, renderProse } from './prose.js';

// Flattens the returned node array back to a plain string, tagging each element's text with its
// tag so tests can assert on structure without rendering to a real DOM.
function tag(nodes: ReturnType<typeof renderProse>): string {
  return nodes
    .map((n) => {
      if (typeof n === 'string') return n;
      if (isValidElement<{ children?: ReactChildren }>(n)) {
        const kind = n.type === 'code' ? 'code' : 'flag';
        return `[${kind}:${n.props.children}]`;
      }
      return String(n);
    })
    .join('');
}
type ReactChildren = string;

describe('renderProse', () => {
  it('turns a backtick span into a <code> element and drops the backticks', () => {
    const nodes = renderProse('cli.js가 `dry-run: { type: \'boolean\' }`을 추가해');
    expect(tag(nodes)).toBe("cli.js가 [code:dry-run: { type: 'boolean' }]을 추가해");
    const code = nodes.find((n) => isValidElement(n));
    expect(isValidElement(code) && code.type).toBe('code');
    expect(isValidElement(code) && (code.props as { className?: string }).className).toBe('inline-code');
  });

  it('leaves an unmatched backtick as a literal character', () => {
    const nodes = renderProse('it uses the ` symbol here');
    expect(nodes).toEqual(['it uses the ` symbol here']);
  });

  it('wraps a bare flag at the end of a line so "--" never wraps alone', () => {
    const nodes = renderProse('Config validates and defaults --retries');
    expect(tag(nodes)).toBe('Config validates and defaults [flag:--retries]');
    const flag = nodes.find((n) => isValidElement(n));
    expect(isValidElement(flag) && (flag.props as { className?: string }).className).toBe('flag');
  });

  it('handles Korean text with an embedded code span and no other markup', () => {
    const nodes = renderProse('설정이 `--retries` 기본값을 검증합니다');
    expect(tag(nodes)).toBe('설정이 [code:--retries] 기본값을 검증합니다');
  });

  it('does not treat a flag inside a code span as a separate token', () => {
    const nodes = renderProse('run `cmd --retries 3` now');
    expect(tag(nodes)).toBe('run [code:cmd --retries 3] now');
  });

  it('handles both a code span and a bare flag in the same string', () => {
    const nodes = renderProse('set `dry-run` then pass --retries');
    expect(tag(nodes)).toBe('set [code:dry-run] then pass [flag:--retries]');
  });

  it('renders HTML-looking content inside a code span as inert text, never as markup', () => {
    const nodes = renderProse('see `<img onerror=alert(1)>` here');
    const code = nodes.find((n) => isValidElement(n));
    expect(isValidElement(code) && (code.props as { children?: string }).children).toBe('<img onerror=alert(1)>');
    // Never dangerouslySetInnerHTML: the tag is a plain text child, not parsed markup.
    expect(isValidElement(code) && (code.props as Record<string, unknown>).dangerouslySetInnerHTML).toBeUndefined();
  });

  it('returns plain text unchanged when there is nothing to wrap', () => {
    expect(renderProse('no code or flags here')).toEqual(['no code or flags here']);
  });

  it('does not wrap a flag with an uppercase letter after the dashes', () => {
    const nodes = renderProse('a --Foo flag');
    expect(nodes).toEqual(['a --Foo flag']);
  });
});

describe('proseLabel', () => {
  it('drops matched backtick pairs for attribute text and keeps an unmatched one', () => {
    expect(proseLabel('설정이 `--retries` 값을 검증합니다')).toBe('설정이 --retries 값을 검증합니다');
    expect(proseLabel('a ` b')).toBe('a ` b');
  });
});
