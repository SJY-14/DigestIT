// Direction B rules (DIG-82, docs/ux/brief-2-visual-refinement.md §3) that are easy to regress
// with a one-line edit: boxes, pills, uppercase labels, the stray tab colour, and contrast of
// the dark theme's solid accent.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Every `selector { body }` block, media queries flattened (the lookbehind does not consume the
// previous rule's closing brace, so consecutive rules are all found).
const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const bodiesFor = (selector: string) => rules.filter((r) => r.sel.split(',').some((s) => s.trim() === selector)).map((r) => r.body);

function token(block: string, name: string): string {
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)![1]!.trim();
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('styles: Direction B (DIG-82)', () => {
  it('de-boxes the header, picker panel, area rows, area-glance rows and the check list', () => {
    for (const sel of ['.project-header', '.digest-picker-panel', '.area-card', '.area-glance-card', '.check']) {
      const bodies = bodiesFor(sel);
      expect(bodies.length, sel).toBeGreaterThan(0);
      for (const b of bodies) {
        expect(b, sel).not.toMatch(/(^|;)\s*border\s*:\s*1px/);
        expect(b, sel).not.toMatch(/border-radius\s*:\s*[3-9]px/);
      }
    }
  });

  it('keeps the graph viewport and code blocks as a tint with top and bottom rules, no radius', () => {
    for (const sel of ['.graph-canvas', '.hunk-block']) {
      const b = bodiesFor(sel).join(';');
      expect(b, sel).toMatch(/border-top\s*:\s*1px/);
      expect(b, sel).toMatch(/border-bottom\s*:\s*1px/);
      expect(b, sel).not.toMatch(/border-radius/);
      expect(b, sel).toMatch(/background\s*:\s*var\(--bg-inset\)/);
    }
  });

  it('has no pill shapes and no uppercase or letter-spaced labels', () => {
    expect(css).not.toMatch(/border-radius\s*:\s*(2em|999px)/);
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    expect(css).not.toMatch(/letter-spacing/);
  });

  it('marks the current level tab with the accent token, not a stray colour', () => {
    expect(css).not.toMatch(/#fd8c73/i);
    expect(bodiesFor(".level-tab[aria-selected='true']").join(';')).toMatch(/border-bottom-color\s*:\s*var\(--accent\)/);
  });

  it('gives white text ≥4.5:1 on the solid accent in both themes', () => {
    const light = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(contrast('#ffffff', token(light, '--accent-solid'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token(dark, '--accent-solid'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the focus ring ≥3:1 against the page and the code/graph tint in both themes', () => {
    const light = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)![1]!;
    for (const t of [light, dark]) {
      for (const bg of ['--bg', '--bg-inset', '--selected']) expect(contrast(token(t, '--focus'), token(t, bg))).toBeGreaterThanOrEqual(3);
    }
  });

  it('sets Korean text to break between words', () => {
    expect(bodiesFor('body:lang(ko)').join(';')).toMatch(/word-break\s*:\s*keep-all/);
  });
});
