// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrimitivesGallery } from './PrimitivesGallery.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PrimitivesGallery', () => {
  it('renders one of each chart primitive with no inline styles (CSP style-src self)', async () => {
    await act(async () => root.render(<PrimitivesGallery />));
    expect(host.querySelectorAll('svg.chart')).toHaveLength(5);
    expect(host.textContent).toContain('Bar series (grouped)');
    expect(host.textContent).toContain('Bar series (stacked)');
    expect(host.textContent).toContain('Line series');
    expect(host.textContent).toContain('Grid heatmap');
    expect(host.textContent).toContain('Dot strip');
    expect(host.querySelectorAll('[style]')).toHaveLength(0);
  });
});
