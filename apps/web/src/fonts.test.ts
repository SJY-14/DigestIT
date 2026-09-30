// Font resolution (DIG-82): the font stacks are the specified tokens, and the self-hosted
// Fontsource faces really end up in the production bundle, same-origin, woff2 only. On a host
// where every unmatched family (generic keywords included) resolves to some arbitrary OS font,
// this is what keeps Latin text in the intended faces.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const SERIF = '"Source Serif 4 Variable", "Noto Serif CJK KR", "Noto Serif KR", Georgia, serif';
const SANS = '"Source Sans 3 Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", sans-serif';
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** The value of a custom property declared in the first `:root` block. */
function rootToken(css: string, name: string): string | undefined {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root)?.[1]?.trim();
}

function fontFaces(css: string): { family: string; weight: string; display: string; urls: string[] }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const body = m[1]!;
    const prop = (p: string) => new RegExp(`(?:^|;|\\s)${p}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim() ?? '';
    return {
      family: prop('font-family').replace(/^['"]|['"]$/g, ''),
      weight: prop('font-weight'),
      display: prop('font-display'),
      urls: [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((u) => u[1]!),
    };
  });
}

describe('font stacks in styles.css (DIG-82)', () => {
  const css = stripComments(readFileSync(join(here, 'styles.css'), 'utf8'));

  it('declares --serif, --sans and --mono exactly as specified', () => {
    expect(rootToken(css, '--serif')).toBe(SERIF);
    expect(rootToken(css, '--sans')).toBe(SANS);
    expect(rootToken(css, '--mono')).toBe(MONO);
  });

  it('names the families the Fontsource CSS actually declares', () => {
    const declared = (file: string) => fontFaces(readFileSync(join(webRoot, 'node_modules', file), 'utf8')).map((f) => f.family);
    expect(new Set(declared('@fontsource-variable/source-serif-4/wght.css'))).toEqual(new Set(['Source Serif 4 Variable']));
    expect(new Set(declared('@fontsource-variable/source-sans-3/wght.css'))).toEqual(new Set(['Source Sans 3 Variable']));
    expect(new Set(declared('@fontsource/noto-serif-kr/400.css'))).toEqual(new Set(['Noto Serif KR']));
  });

  it('has no url() at all: fonts come in through main.tsx, not the stylesheet', () => {
    expect(css).not.toMatch(/url\(/);
  });

  it('sets the body in the sans and reading text in the serif', () => {
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*var\(--sans\)/);
    expect(css).toMatch(/\.l0-headline\s*\{[^}]*font-family:\s*var\(--serif\)/);
  });
});

describe('production bundle (vite build)', () => {
  let bundleCss = '';
  let html = '';
  let assetNames: string[] = [];

  beforeAll(async () => {
    const out = await build({ root: webRoot, logLevel: 'silent', build: { write: false } }) as Rollup.RollupOutput;
    for (const o of out.output) {
      if (o.type !== 'asset') continue;
      assetNames.push(o.fileName);
      const text = typeof o.source === 'string' ? o.source : Buffer.from(o.source).toString('utf8');
      if (o.fileName.endsWith('.css')) bundleCss += text;
      if (o.fileName === 'index.html') html = text;
    }
    assetNames = assetNames.sort();
  }, 60_000);

  it('contains the @font-face rules for the three self-hosted families, all font-display: swap', () => {
    const faces = fontFaces(bundleCss);
    const families = new Set(faces.map((f) => f.family));
    for (const f of ['Source Serif 4 Variable', 'Source Sans 3 Variable', 'Noto Serif KR']) expect(families).toContain(f);
    for (const f of faces) expect(f.display).toBe('swap');
  });

  it('ships the Korean serif in weights 400 and 600 only', () => {
    const weights = new Set(fontFaces(bundleCss).filter((f) => f.family === 'Noto Serif KR').map((f) => f.weight));
    expect(weights).toEqual(new Set(['400', '600']));
  });

  it('points every font url() at a same-origin woff2 file that is in the bundle', () => {
    const urls = fontFaces(bundleCss).flatMap((f) => f.urls);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^\/assets\/[^/]+\.woff2$/);
      expect(assetNames).toContain(u.slice(1));
    }
  });

  it('has no off-origin url() anywhere in the CSS', () => {
    const all = [...bundleCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!);
    for (const u of all) expect(u).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
  });

  it('keeps index.html free of inline styles and external URLs (CSP style-src/font-src self)', () => {
    expect(html).not.toMatch(/<style|\sstyle=/i);
    expect(html).not.toMatch(/(?:src|href)=["'](?:https?:)?\/\//i);
  });
});
