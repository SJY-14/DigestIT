// The System/Light/Dark control (DIG-113): a plain `<select>`, not a custom segmented control —
// it is fully keyboard-operable and gets a real accessible name for free, and its fixed width
// (styles.css's `.theme-select`) means switching choices never shifts the layout around it. Used
// twice: bare (aria-label only) as the quiet header control in App.tsx, and wrapped in a visible
// `<label>` as the mirrored row in the Settings panel (ProjectHeader.tsx).
import { themeCopy, type Lang } from './copy.js';
import type { Theme } from './theme.js';

export function ThemeToggle({
  theme, onChange, lang, className,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  lang: Lang;
  className?: string;
}) {
  const T = themeCopy(lang);
  return (
    <select
      className={className ? `theme-select ${className}` : 'theme-select'}
      aria-label={T.ariaLabel}
      value={theme}
      onChange={(e) => onChange(e.target.value as Theme)}
    >
      <option value="system">{T.system}</option>
      <option value="light">{T.light}</option>
      <option value="dark">{T.dark}</option>
    </select>
  );
}
