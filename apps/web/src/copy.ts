// All user-facing UI wording lives here (DIG-47), so it can be reviewed in one place and
// localised later. Rules: sentence case, no "(s)", no raw booleans or enum values, human dates,
// specific empty/loading/error states. Explanations themselves come from the LLM in the
// project's language; this file is only the UI chrome, which stays English for now.

/** "1 file" / "4 files". Pass the plural when it is not just singular + "s". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayMonth = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dayMonthYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today, 17:05", "Yesterday, 09:12", "Sep 27, 17:05", "Dec 31, 2025, 08:00" (local time). */
export function humanDateTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const clock = time.format(t);
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days === 0) return `Today, ${clock}`;
  if (days === 1) return `Yesterday, ${clock}`;
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return `${(sameYear ? dayMonth : dayMonthYear).format(t)}, ${clock}`;
}

/** "+7 −3" (a real minus sign). */
export function lineDelta(additions: number, deletions: number): string {
  return `+${additions.toLocaleString('en-US')} −${deletions.toLocaleString('en-US')}`;
}

/** Explanation languages as shown in the language setting (each in its own language). */
export const LANGUAGE_NAMES = { en: 'English', ko: '한국어' } as const;

/** Level switcher labels (`L0 Summary · L1 Impact · L2 Structure · L3 Code`). */
export const LEVELS = [
  { key: 'L0', label: 'Summary' },
  { key: 'L1', label: 'Impact' },
  { key: 'L2', label: 'Structure' },
  { key: 'L3', label: 'Code' },
] as const;

// Each issue adds its own section below (header, digest picker, reader, walkthrough, graph,
// empty states, history). Keep strings as plain values or small functions of numbers/dates.
