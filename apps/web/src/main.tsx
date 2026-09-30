import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Self-hosted fonts (DIG-82): Fontsource's @font-face rules, bundled by Vite as same-origin
// files. Only the weights the stylesheet uses; the Korean serif ships 400/600, and its
// unicode-range slices mean a page downloads only the chunks its text needs.
import '@fontsource-variable/source-serif-4/wght.css';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/source-sans-3/wght.css';
import '@fontsource/noto-serif-kr/400.css';
import '@fontsource/noto-serif-kr/600.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
