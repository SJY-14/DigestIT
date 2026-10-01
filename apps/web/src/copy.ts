// All user-facing UI wording lives here (DIG-47), so it can be reviewed in one place and
// localised later. Rules: sentence case, no "(s)", no raw booleans or enum values, human dates,
// specific empty/loading/error states. Explanations themselves come from the LLM in the
// project's language; this file is the UI chrome around them, which (DIG-52) follows the same
// language: every table below has an `_EN` and a `_KO` version, picked by the `lang` a caller
// passes in (the current project's `language`), defaulting to English when omitted so call
// sites that don't care about localisation (mostly tests) keep working unchanged. Code
// identifiers (paths, hunk numbers, area ids) are never translated.
//
// `Lang` is kept as a plain literal (not imported from `@digestit/core`'s `ExplainLanguage`) so
// the browser bundle never pulls in that package's Node-only `db.js` — see the note in
// v2Fixtures.ts.
export type Lang = 'en' | 'ko';

/** "1 file" / "4 files". Pass the plural when it is not just singular + "s". English only: the
 * Korean side of every table below counts with a bare "개" instead, so it never calls this. */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

const TIME_FMT: Record<Lang, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  ko: new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
};
const DAY_MONTH_FMT: Record<Lang, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }),
  ko: new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }),
};
const DAY_MONTH_YEAR_FMT: Record<Lang, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  ko: new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', year: 'numeric' }),
};

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today, 17:05", "Yesterday, 09:12", "Sep 27, 17:05", "Dec 31, 2025, 08:00" (local time), or
 * the Korean equivalent ("오늘 17:05", "9월 27일, 17:05", …). `lang` is last (not `now`) so every
 * existing English-only call site keeps working unchanged. */
export function humanDateTime(iso: string, now: number = Date.now(), lang: Lang = 'en'): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const clock = TIME_FMT[lang].format(t);
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (lang === 'ko') {
    if (days === 0) return `오늘, ${clock}`;
    if (days === 1) return `어제, ${clock}`;
    const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
    return `${(sameYear ? DAY_MONTH_FMT.ko : DAY_MONTH_YEAR_FMT.ko).format(t)}, ${clock}`;
  }
  if (days === 0) return `Today, ${clock}`;
  if (days === 1) return `Yesterday, ${clock}`;
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return `${(sameYear ? DAY_MONTH_FMT.en : DAY_MONTH_YEAR_FMT.en).format(t)}, ${clock}`;
}

/** "+7 −3" (a real minus sign). Digits only, so this is the same in every language. */
export function lineDelta(additions: number, deletions: number): string {
  return `+${additions.toLocaleString('en-US')} −${deletions.toLocaleString('en-US')}`;
}

/** Explanation languages as shown in the language setting (each in its own language). */
export const LANGUAGE_NAMES = { en: 'English', ko: '한국어' } as const;
export const EXPLAIN_LANGUAGE_LIST = Object.keys(LANGUAGE_NAMES) as (keyof typeof LANGUAGE_NAMES)[];

/** Level switcher labels (`L0 Summary · L1 Impact · L2 Structure · L3 Code`). */
const LEVELS_EN = [
  { key: 'L0', label: 'Summary' },
  { key: 'L1', label: 'Impact' },
  { key: 'L2', label: 'Structure' },
  { key: 'L3', label: 'Code' },
] as const;
const LEVELS_KO = [
  { key: 'L0', label: '요약' },
  { key: 'L1', label: '영향' },
  { key: 'L2', label: '구조' },
  { key: 'L3', label: '코드' },
] as const;
export function levelsCopy(lang: Lang = 'en') {
  return lang === 'ko' ? LEVELS_KO : LEVELS_EN;
}

// --- Setup form and project-list guards (DIG-40/49): shown before a project is selected. The setup
// form has no project language yet and renders English; MainV2's guards pass its `lang`, which is
// 'en' until the project list has loaded.

const SETUP_EN = {
  // UX cycle 2 P3 (decision-2.md): the right column's card heading, next to the left column's
  // step list + trust box (`trustCopy` above).
  formHeading: 'Register a project',
  projectFolderLabel: 'Project folder',
  projectFolderPlaceholder: '/path/to/project',
  contextFileLabel: 'Context file (optional)',
  contextFilePlaceholder: '/path/to/context.md',
  starting: 'Starting…',
  start: 'Start',
  projectsLoadError: (msg: string) => `Could not load projects: ${msg}`,
  noApiHint: "This server doesn't have the v2 project API yet.",
  /** A 401 on the projects fetch: this dashboard needs an access link, distinct from a plain
   * network/server error (UX cycle 2, decision-2.md P5: "show a 401 as its own message"). The
   * operator mints the link with the CLI's `digest token` command (apps/server/src/cli.ts:11). */
  accessLinkNeeded: {
    before: 'This dashboard needs an access link. Ask whoever runs DigestIT to print one with ',
    code: 'digest token',
    after: '.',
  },
} as const;
const SETUP_KO = {
  formHeading: '프로젝트 등록',
  projectFolderLabel: '프로젝트 폴더',
  projectFolderPlaceholder: '/path/to/project',
  contextFileLabel: '컨텍스트 파일 (선택)',
  contextFilePlaceholder: '/path/to/context.md',
  starting: '시작하는 중…',
  start: '시작',
  projectsLoadError: (msg: string) => `프로젝트를 불러오지 못했습니다: ${msg}`,
  noApiHint: '이 서버에는 아직 v2 프로젝트 API가 없습니다.',
  accessLinkNeeded: {
    before: '이 대시보드를 사용하려면 접속 링크가 필요합니다. DigestIT 운영자에게 ',
    code: 'digest token',
    after: ' 명령으로 링크를 만들어 달라고 요청하세요.',
  },
} as const;
export function setupCopy(lang: Lang = 'en') {
  return lang === 'ko' ? SETUP_KO : SETUP_EN;
}

// --- Trust: what Explain sends and what DigestIT never does (UX cycle 2 P2/P5, decision-2.md
// "Changes to the brief" 4). `readOnly` is the one line shared verbatim between the first-run
// trust box and the Settings panel; `providerClaudeCode`/`providerStub`/`providerOther` are picked
// by the caller from `AboutDto.provider` (GET /api/about, packages/core/src/v2.ts).

const TRUST_EN = {
  label: 'What Explain sends',
  local: 'Registering a project and taking checkpoints stay on this machine. Nothing is sent anywhere until you run Explain, Retry, or Build context.',
  sent: 'That sends the changed lines of your tracked files — ignored files never go out — plus a project map: file paths, the README, manifest metadata, top-level doc headings, and your optional note. Anything that looks like a secret is redacted first.',
  providerClaudeCode: 'It goes to Anthropic, through the Claude Code CLI on this machine.',
  providerStub: 'This server is set to the stub provider, so nothing leaves this machine.',
  providerOther: (provider: string) => `It goes to the provider configured on this server: ${provider}.`,
  readOnly: 'DigestIT never writes to your project folder or its git history. Its own data lives in a separate data directory.',
} as const;
const TRUST_KO = {
  label: 'Explain이 보내는 것',
  local: '프로젝트 등록과 체크포인트 생성은 이 기기에만 남습니다. Explain, Retry, 컨텍스트 빌드 중 하나를 실행하기 전까지는 아무것도 전송되지 않습니다.',
  sent: '실행하면 추적 중인 파일의 변경된 줄(무시된 파일은 제외)과 프로젝트 맵(파일 경로, README, 매니페스트 메타데이터, 최상위 문서 제목, 남긴 메모)이 전송됩니다. 비밀 정보로 보이는 문자열은 먼저 마스킹됩니다.',
  providerClaudeCode: '이 기기에 설치된 Claude Code CLI를 통해 Anthropic으로 전송됩니다.',
  providerStub: '이 서버는 stub 제공자로 설정되어 있어 아무것도 이 기기 밖으로 나가지 않습니다.',
  providerOther: (provider: string) => `이 서버에 설정된 제공자(${provider})로 전송됩니다.`,
  readOnly: 'DigestIT는 프로젝트 폴더나 git 기록에 쓰지 않습니다. 자체 데이터는 별도의 데이터 디렉터리에 저장됩니다.',
} as const;
export function trustCopy(lang: Lang = 'en') {
  return lang === 'ko' ? TRUST_KO : TRUST_EN;
}

// --- Header (DIG-49/52): project switcher, digest picker, Explain, calls left, info popover ----

const HEADER_EN = {
  loadingStatus: 'Loading…',
  statusError: (msg: string) => `Could not load the project status: ${msg}`,
  // UX cycle 2 P5 (decision-2.md): the ⓘ trigger is relabeled "Settings" — it now holds budget,
  // provider/model and the read-only line alongside the existing context/language/ignore controls.
  settingsLabel: 'Settings',
  budgetRowLabel: 'Daily budget',
  providerRowLabel: 'Provider',
  modelRowLabel: 'Model',
  legacyInsightsLink: 'Legacy insights (pre-v2 data)',
  refreshContext: 'Refresh context',
  refreshingContext: 'Refreshing…',
  languageLabel: 'Explanation language',
  languageHint: 'New digests use this language. Older digests stay as they were written.',
  languageError: (msg: string) => `Could not change the language: ${msg}`,
  nothingPendingHint: 'Nothing has changed since the last check.',
  noCallsHint: 'No Explains left today. It works again after the reset.',
  resets: (when: string) => `Resets ${when}`,
} as const;
const HEADER_KO = {
  loadingStatus: '불러오는 중…',
  statusError: (msg: string) => `프로젝트 상태를 불러오지 못했습니다: ${msg}`,
  settingsLabel: '설정',
  budgetRowLabel: '일일 예산',
  providerRowLabel: '제공자',
  modelRowLabel: '모델',
  legacyInsightsLink: '레거시 인사이트 (v2 이전 데이터)',
  refreshContext: '컨텍스트 새로고침',
  refreshingContext: '새로고침 중…',
  languageLabel: '설명 언어',
  languageHint: '새 다이제스트는 이 언어로 작성됩니다. 이전 다이제스트는 작성 당시 언어를 유지합니다.',
  languageError: (msg: string) => `언어를 변경하지 못했습니다: ${msg}`,
  nothingPendingHint: '마지막 확인 이후 변경된 내용이 없습니다.',
  noCallsHint: '오늘 남은 설명이 없습니다. 초기화 이후 다시 사용할 수 있습니다.',
  resets: (when: string) => `${when}에 초기화`,
} as const;
export function headerCopy(lang: Lang = 'en') {
  return lang === 'ko' ? HEADER_KO : HEADER_EN;
}

// --- Theme (DIG-113): the System/Light/Dark control, shown as a quiet select in the global
// header (App.tsx, on every view) and mirrored as a labelled row in the per-project Settings
// panel (ProjectHeader.tsx's InfoPopover). `ariaLabel` spells out all three choices, since the
// global header's copy has no visible "Theme" text next to it.
const THEME_EN = {
  label: 'Theme',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  ariaLabel: 'Theme: system / light / dark',
} as const;
const THEME_KO = {
  label: '테마',
  system: '시스템',
  light: '라이트',
  dark: '다크',
  ariaLabel: '테마: 시스템 / 라이트 / 다크',
} as const;
export function themeCopy(lang: Lang = 'en') {
  return lang === 'ko' ? THEME_KO : THEME_EN;
}

// --- Top nav (DIG-60, cut to Home-only by UX cycle 2 decision-2.md IA decision): follows the
// current project's language, so a Korean project never shows an English "DigestIT | Home" bar
// (see App.tsx's `lang` state). Units/Timeline/Briefing and their History menu are gone; Insights
// stays reachable only via the Settings panel's "Legacy insights" link (see `settingsLabel` etc.
// below), not from this nav.
const NAV_EN = {
  pagesLabel: 'Pages',
  home: 'Home',
  // UX cycle 2 P7 (decision-2.md): shown only once 2+ projects are registered — App.tsx.
  allProjects: 'All projects',
} as const;
const NAV_KO = {
  pagesLabel: '페이지',
  home: '홈',
  allProjects: '전체 프로젝트',
} as const;
export function navCopy(lang: Lang = 'en') {
  return lang === 'ko' ? NAV_KO : NAV_EN;
}

// --- Project panel (P4) + All-projects view (P7), decision-2.md §2 and "Build" P4/P7: the
// switcher's overlay panel (ProjectPanel.tsx) and the /projects route (AllProjects.tsx) share one
// row component (ProjectRow.tsx) and this copy table.
const PROJECTS_EN = {
  switchProjectLabel: 'Switch project',
  projectsHeading: 'Projects',
  lastActivity: (when: string) => `Last activity ${when}`,
  noActivity: 'No activity yet',
  unreadNew: 'New',
  unreadCount: (n: number) => `${n} new`,
  removeLabel: 'Remove',
  removeConfirmLabel: 'Confirm remove?',
  removeTitle: (name: string) => `Remove ${name} from this dashboard`,
  removing: 'Removing…',
  removeError: (msg: string) => `Could not remove this project: ${msg}`,
  caughtUp: 'You’re caught up',
  noHeadlineYet: 'Not explained yet',
  noDigestsYet: 'No digests yet',
  allProjectsHeading: (total: number, needAttention: number) =>
    needAttention === 0 ? `${plural(total, 'project')}, you’re all caught up` : `${plural(total, 'project')}, ${needAttention} ${needAttention === 1 ? 'needs' : 'need'} attention`,
  allProjectsSubheading: 'Sorted by what’s new since you last looked at each.',
} as const;
const PROJECTS_KO = {
  switchProjectLabel: '프로젝트 전환',
  projectsHeading: '프로젝트',
  lastActivity: (when: string) => `마지막 활동 ${when}`,
  noActivity: '아직 활동 없음',
  unreadNew: '새 항목',
  unreadCount: (n: number) => `새 항목 ${n}개`,
  removeLabel: '제거',
  removeConfirmLabel: '제거 확인',
  removeTitle: (name: string) => `${name} 제거`,
  removing: '제거 중…',
  removeError: (msg: string) => `프로젝트를 제거하지 못했습니다: ${msg}`,
  caughtUp: '모두 확인함',
  noHeadlineYet: '아직 설명되지 않음',
  noDigestsYet: '아직 다이제스트 없음',
  allProjectsHeading: (total: number, needAttention: number) =>
    needAttention === 0 ? `프로젝트 ${total}개, 모두 확인함` : `프로젝트 ${total}개, ${needAttention}개 확인 필요`,
  allProjectsSubheading: '각 프로젝트를 마지막으로 본 뒤 새로워진 순서입니다.',
} as const;
export function projectsCopy(lang: Lang = 'en') {
  return lang === 'ko' ? PROJECTS_KO : PROJECTS_EN;
}

/** The primary Explain button's label: the pending count, or a plain "nothing to do" state
 * that must not look like a broken primary action. */
export function explainButtonLabel(pendingFiles: number, lang: Lang = 'en'): string {
  if (lang === 'ko') return pendingFiles === 0 ? '새 변경 사항 없음' : `변경 사항 ${pendingFiles}개 설명하기`;
  return pendingFiles === 0 ? 'No new changes' : `Explain ${plural(pendingFiles, 'change')}`;
}

/** "12s" under a minute, "1m 05s" at or past one (or "12초" / "1분 05초"). */
export function elapsedLabel(totalSeconds: number, lang: Lang = 'en'): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (lang === 'ko') return m === 0 ? `${s}초` : `${m}분 ${ss}초`;
  return m === 0 ? `${s}s` : `${m}m ${ss}s`;
}

/** "Explaining… 12s" while an Explain is in flight, shown in place of the pending count. */
export function explainingLabel(elapsedSeconds: number, lang: Lang = 'en'): string {
  return lang === 'ko' ? `설명 작성 중… ${elapsedLabel(elapsedSeconds, lang)}` : `Explaining… ${elapsedLabel(elapsedSeconds, lang)}`;
}

/** When the daily budget comes back: just the clock ("00:00") within the next day, else a date. */
export function resetsLabel(iso: string, now: number = Date.now(), lang: Lang = 'en'): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return t > now && t - now <= 86_400_000 ? TIME_FMT[lang].format(t) : humanDateTime(iso, now, lang);
}

/** The Explains-left badge (DIG-73/76: one Explain job is one budget unit, not one LLM call):
 * "35 Explains left today", or, when spent, what happens next ("No Explains left today · resets 00:00"). */
export function callsLeftLabel(remaining: number, resetsAt: string, now: number = Date.now(), lang: Lang = 'en'): string {
  if (lang === 'ko') {
    return remaining === 0 ? `오늘 남은 설명 없음 · ${resetsLabel(resetsAt, now, lang)} 초기화` : `오늘 남은 설명 ${remaining}회`;
  }
  return remaining === 0 ? `No Explains left today · resets ${resetsLabel(resetsAt, now, lang)}` : `${plural(remaining, 'Explain', 'Explains')} left today`;
}

/** The info popover's context line: "Built just now, from 42 files, with your notes" /
 * "Built 3 hours ago, from 12 files" / "No context built yet" / "Building context…". `builtLabel`
 * is an already-formatted relative time (see format.ts's `relativeTime`), passed through as-is. */
export function contextSummary(
  status: 'none' | 'ok' | 'pending' | 'error' | 'truncated',
  builtLabel: string | null,
  fromFiles: number | null,
  hasUserContext: boolean,
  lang: Lang = 'en',
): string {
  if (lang === 'ko') {
    if (status === 'none') return '아직 빌드된 컨텍스트가 없습니다. 첫 Explain 때 만들어집니다.';
    if (status === 'pending' || !builtLabel) return '컨텍스트 빌드 중…';
    const built = status === 'error' ? `빌드 실패 (마지막 시도 ${builtLabel})` : `${builtLabel} 빌드됨`;
    const from = fromFiles !== null ? `, 파일 ${fromFiles}개 기준` : '';
    const notes = hasUserContext ? ', 사용자 노트 포함' : '';
    return `${built}${from}${notes}`;
  }
  if (status === 'none') return 'No context built yet. It is built on the first Explain.';
  if (status === 'pending' || !builtLabel) return 'Building context…';
  const built = status === 'error' ? `Failed to build (last try ${builtLabel})` : `Built ${builtLabel}`;
  const from = fromFiles !== null ? `, from ${plural(fromFiles, 'file')}` : '';
  const notes = hasUserContext ? ', with your notes' : '';
  return `${built}${from}${notes}`;
}

/** Explain outcomes that land back on the header instead of a new digest. `detail`, when given,
 * is already a user-facing sentence (see `apiErrorMessage` below), not a raw server code. */
export function explainOutcomeMessage(
  outcome: 'error' | 'budget' | 'no_changes', detail: string | undefined, resets: string, lang: Lang = 'en',
): string {
  if (lang === 'ko') {
    if (outcome === 'no_changes') return '마지막 확인 이후 변경된 내용이 없습니다. 어떤 도구로든 프로젝트에서 작업한 뒤 다시 Explain을 눌러주세요.';
    if (outcome === 'budget') return `일일 예산이 소진되어 이 다이제스트는 아직 설명되지 않았습니다. ${resets} 초기화 이후 다시 시도해주세요.`;
    return `설명에 실패했습니다.${detail ? ` ${detail}` : ''} 다시 시도하거나, 계속 실패하면 서버 로그를 확인해주세요.`;
  }
  if (outcome === 'no_changes') return 'Nothing changed since the last check. Work in the project with any tool, then press Explain again.';
  if (outcome === 'budget') return `The daily budget ran out, so this digest is not explained yet. Retry it after the reset at ${resets}.`;
  return `Explain failed.${detail ? ` ${detail}` : ''} Try again, or check the server log if it keeps failing.`;
}

// --- Ignore patterns (DIG-56): info popover section + one-click suggestions at setup -------------

const IGNORE_EN = {
  heading: 'Ignore patterns',
  hint: 'Gitignore-syntax patterns for this project, stored outside it. Never written into the project.',
  placeholder: 'e.g. out/ or *.log',
  add: 'Add',
  adding: 'Adding…',
  empty: 'No ignore patterns yet.',
  remove: (pattern: string) => `Remove ${pattern}`,
  addError: (msg: string) => `Could not add the pattern: ${msg}`,
  removeError: (msg: string) => `Could not remove the pattern: ${msg}`,
  notTrackedHeading: 'Not tracked',
  notTrackedEmpty: 'Everything in the last checkpoint is tracked.',
  notTrackedExamples: (examples: string[]) => examples.join(', '),
  suggestionsHeading: 'This folder has no .gitignore. Suggested ignore patterns:',
  suggestionsHint: 'Not applied — add the ones you want.',
  suggestionAdd: (pattern: string) => `Add ${pattern}`,
  suggestionAdded: 'Added',
  continueLabel: 'Continue',
} as const;
const IGNORE_KO = {
  heading: '무시 패턴',
  hint: '이 프로젝트를 위한 gitignore 문법 패턴으로, 프로젝트 밖에 저장됩니다. 프로젝트에는 절대 기록되지 않습니다.',
  placeholder: '예: out/ 또는 *.log',
  add: '추가',
  adding: '추가 중…',
  empty: '아직 무시 패턴이 없습니다.',
  remove: (pattern: string) => `${pattern} 제거`,
  addError: (msg: string) => `패턴을 추가하지 못했습니다: ${msg}`,
  removeError: (msg: string) => `패턴을 제거하지 못했습니다: ${msg}`,
  notTrackedHeading: '추적되지 않음',
  notTrackedEmpty: '마지막 체크포인트의 모든 항목이 추적되고 있습니다.',
  notTrackedExamples: (examples: string[]) => examples.join(', '),
  suggestionsHeading: '이 폴더에는 .gitignore가 없습니다. 제안된 무시 패턴:',
  suggestionsHint: '적용되지 않았습니다 — 원하는 것만 추가하세요.',
  suggestionAdd: (pattern: string) => `${pattern} 추가`,
  suggestionAdded: '추가됨',
  continueLabel: '계속',
} as const;
export function ignoreCopy(lang: Lang = 'en') {
  return lang === 'ko' ? IGNORE_KO : IGNORE_EN;
}

const NOT_TRACKED_REASON_EN: Record<string, string> = {
  denylist: "DigestIT's built-in denylist",
  gitignore: "this project's .gitignore",
  'project-ignore': 'your project ignore pattern',
  'git-exclude': 'your git excludes',
  too_large: 'over the size limit',
  nested_repo: 'a nested repository',
  unreadable: 'unreadable',
};
const NOT_TRACKED_REASON_KO: Record<string, string> = {
  denylist: 'DigestIT 기본 제외 목록',
  gitignore: '이 프로젝트의 .gitignore',
  'project-ignore': '설정한 프로젝트 무시 패턴',
  'git-exclude': 'git 제외 설정',
  too_large: '크기 제한 초과',
  nested_repo: '중첩된 저장소',
  unreadable: '읽을 수 없음',
};

/** Why a "not tracked" group exists, as a short phrase ("this project's .gitignore"), for the
 * pattern-source distinction DIG-56 asks for (project pattern vs .gitignore vs denylist). */
export function notTrackedReasonLabel(reason: string, lang: Lang = 'en'): string {
  const table = lang === 'ko' ? NOT_TRACKED_REASON_KO : NOT_TRACKED_REASON_EN;
  return table[reason] ?? reason;
}

// --- Digest picker (DIG-49/52): an overlay list, one row per digest ------------------------------

/** "Today, 17:05 · 15 files · Adds retry to uploads" (or "Not explained yet" with no L0). */
export function digestRowLabel(atIso: string, files: number, l0Text: string | null, now: number = Date.now(), lang: Lang = 'en'): string {
  if (lang === 'ko') return `${humanDateTime(atIso, now, lang)} · 파일 ${files}개 · ${l0Text ?? '아직 설명되지 않음'}`;
  return `${humanDateTime(atIso, now, lang)} · ${plural(files, 'file')} · ${l0Text ?? 'Not explained yet'}`;
}

const PICKER_EN = {
  label: 'Digests',
  choose: 'Choose a digest',
  listLabel: 'Past digests, newest first',
  loading: 'Loading…',
  loadError: (msg: string) => `Could not load digests: ${msg}`,
  startOfHistory: 'Start of history',
  retry: 'Retry',
  retrying: 'Retrying…',
  retryNoBudget: 'No Explains left today',
  status: {
    pending: 'Not explained yet',
    error: 'Explain failed',
    truncated: 'Partly explained',
  } as Record<'pending' | 'error' | 'truncated', string>,
} as const;
const PICKER_KO = {
  label: '다이제스트',
  choose: '다이제스트 선택',
  listLabel: '지난 다이제스트, 최신순',
  loading: '불러오는 중…',
  loadError: (msg: string) => `다이제스트를 불러오지 못했습니다: ${msg}`,
  startOfHistory: '기록의 시작',
  retry: '재시도',
  retrying: '재시도 중…',
  retryNoBudget: '오늘 남은 설명 없음',
  status: {
    pending: '아직 설명되지 않음',
    error: '설명 실패',
    truncated: '일부만 설명됨',
  } as Record<'pending' | 'error' | 'truncated', string>,
} as const;
export function pickerCopy(lang: Lang = 'en') {
  return lang === 'ko' ? PICKER_KO : PICKER_EN;
}

// --- First-run empty states (DIG-49/52): teach register → work → Explain -------------------------

const EMPTY_EN = {
  noProjects: {
    heading: 'Start your first project',
    steps: [
      'Register a project folder below.',
      'Work in it with any tool: an editor, an AI agent, a script.',
      'Come back and press Explain to see what changed.',
    ],
  },
  /** First-run reading pane state for a project with no digests yet (DIG-57): specific to the
   * project and, once known, how much is already waiting to be explained. */
  noDigests: (projectName: string, pendingFiles: number) => ({
    heading: `No explanations yet for ${projectName}`,
    body: pendingFiles > 0
      ? `${plural(pendingFiles, 'file')} changed since you registered it. Press Explain above to see what happened.`
      : 'Work in this project with any tool, then press Explain above. Each Explain turns the changes since the last one into a digest.',
  }),
  digestNoChanges: 'This digest has no file changes to explain. Keep working, then press Explain again.',
} as const;
const EMPTY_KO = {
  noProjects: {
    heading: '첫 프로젝트 시작하기',
    steps: [
      '아래에 프로젝트 폴더를 등록하세요.',
      '에디터, AI 에이전트, 스크립트 등 원하는 도구로 작업하세요.',
      '다시 돌아와 Explain을 눌러 무엇이 바뀌었는지 확인하세요.',
    ],
  },
  noDigests: (projectName: string, pendingFiles: number) => ({
    heading: `${projectName}에 대한 설명이 아직 없습니다`,
    body: pendingFiles > 0
      ? `등록 이후 파일 ${pendingFiles}개가 변경되었습니다. 위의 Explain을 눌러 무엇이 바뀌었는지 확인하세요.`
      : '이 프로젝트에서 어떤 도구로든 작업한 뒤 위의 Explain을 눌러주세요. Explain을 누를 때마다 마지막 이후의 변경 사항이 다이제스트로 만들어집니다.',
  }),
  digestNoChanges: '이 다이제스트에는 설명할 파일 변경 사항이 없습니다. 계속 작업한 뒤 다시 Explain을 눌러주세요.',
} as const;
export function emptyCopy(lang: Lang = 'en') {
  return lang === 'ko' ? EMPTY_KO : EMPTY_EN;
}

// --- Server error codes -> sentences (DIG-49 copy sweep, DIG-52 Korean) ---------------------------
// The API returns a short machine code (`{error: 'bad_root_path'}`) so other code and tests can
// branch on it; this is the one place that turns it into something a person reads.

const API_ERROR_MESSAGE_EN: Record<string, string> = {
  bad_root_path: 'Enter a project folder to register.',
  root_not_found: 'That folder does not exist.',
  root_not_allowed: 'That folder is outside the folders this server can register.',
  bad_context_path: 'Enter a valid context file path.',
  context_not_found: 'That context file does not exist.',
  context_not_allowed: 'The context file must be inside the project folder.',
  project_roots_not_configured: 'This server has no allowed project folders configured.',
  bad_language: 'That language is not supported.',
  bad_body: 'The request was missing required fields.',
  not_found: 'That project or digest no longer exists.',
  explain_running: 'An Explain is already running for this project.',
  no_provider: 'No explanation provider is configured on this server.',
  explain_failed: 'The explanation provider returned an error.',
  context_failed: 'Building the project context failed.',
  unauthorized: 'Your session expired. Reload the page and sign in again.',
  bad_action: 'That is not a valid ignore-pattern action.',
  bad_patterns: 'Enter at least one pattern.',
};
const API_ERROR_MESSAGE_KO: Record<string, string> = {
  bad_root_path: '등록할 프로젝트 폴더를 입력하세요.',
  root_not_found: '해당 폴더가 존재하지 않습니다.',
  root_not_allowed: '이 서버가 등록할 수 있는 폴더 범위를 벗어났습니다.',
  bad_context_path: '유효한 컨텍스트 파일 경로를 입력하세요.',
  context_not_found: '해당 컨텍스트 파일이 존재하지 않습니다.',
  context_not_allowed: '컨텍스트 파일은 프로젝트 폴더 안에 있어야 합니다.',
  project_roots_not_configured: '이 서버에는 허용된 프로젝트 폴더가 설정되어 있지 않습니다.',
  bad_language: '지원하지 않는 언어입니다.',
  bad_body: '요청에 필수 항목이 누락되었습니다.',
  not_found: '해당 프로젝트 또는 다이제스트가 더 이상 존재하지 않습니다.',
  explain_running: '이 프로젝트는 이미 Explain이 실행 중입니다.',
  no_provider: '이 서버에 설명 제공자가 설정되어 있지 않습니다.',
  explain_failed: '설명 제공자가 오류를 반환했습니다.',
  context_failed: '프로젝트 컨텍스트 빌드에 실패했습니다.',
  unauthorized: '세션이 만료되었습니다. 페이지를 새로고침한 뒤 다시 로그인하세요.',
  bad_action: '올바른 무시 패턴 작업이 아닙니다.',
  bad_patterns: '패턴을 하나 이상 입력하세요.',
};

/** A server error code (or an arbitrary message, for network/parse failures) as a sentence. */
export function apiErrorMessage(code: string, lang: Lang = 'en'): string {
  const table = lang === 'ko' ? API_ERROR_MESSAGE_KO : API_ERROR_MESSAGE_EN;
  if (table[code]) return table[code];
  if (!/^[a-z][a-z0-9_]*$/.test(code)) return code;
  return lang === 'ko' ? '서버에 문제가 발생했습니다.' : 'Something went wrong on the server.';
}

// --- Reader (DIG-50/52): level switcher, breadcrumb, the L0–L3 views -----------------------------

const READER_EN = {
  switcherLabel: 'Explanation level',
  switcherHint: 'Press 0–3 to switch level',
  breadcrumbLabel: 'You are here',
  digestCrumb: (when: string) => `Digest · ${when}`,
  loadingDigest: 'Loading this digest…',
  digestLoadError: (msg: string) => `Couldn't load this digest: ${msg}`,
  // Digest-level status notices, shown above every level.
  digestPending: 'This digest is still being explained.',
  digestError: "This digest couldn't be explained. Try again, or pick another digest.",
  digestTruncated: 'Part of this digest was cut to fit the size limit, so some areas may be missing.',
  retry: 'Try again',
  retrying: 'Trying again…',
  retryNoBudget: 'No Explains left today',
  // L0
  noHeadline: 'This digest has no summary yet.',
  period: (from: string, to: string) => `${from} → ${to}`,
  fileCount: (n: number) => plural(n, 'file'),
  // L1
  noImpact: 'This digest has no impact summary yet.',
  internalOnly: 'Nothing a user would notice: these changes are internal.',
  // L2
  noAreas: 'This digest has no areas yet.',
  areaHow: 'What changed',
  areaWhy: 'Why',
  openArea: 'Walk through the code',
  filteredTo: (shown: number, total: number) => `${shown} of ${plural(total, 'area')} touch`,
  noAreaForNode: 'No area covers this part of the project.',
  clearFilter: 'Show all areas',
  filterAnnounce: (path: string) => `Showing the areas that touch ${path}`,
  filterCleared: 'Showing all areas',
  notAnalysed: 'Not analysed',
  // L3 without an area
  pickArea: 'Pick an area to walk through its code.',
  // "Next level" link at the bottom of L0–L2
  nextLevel: (key: string, label: string) => `Next: ${key} ${label}`,
  // L0 "Areas in this digest" cards (DIG-61 P2): land on L2 with the area selected, not L3, so
  // the label is deliberately not "Walk through the code" (openArea above).
  areasGlanceHeading: 'Areas in this digest',
  openAreaCard: 'Open area',
  // Fast Explain (DIG-73/76): the deterministic files/graph/areas land at once; each part's text
  // (L0/L1, one per area) fills in on its own as it lands, so these replace `noHeadline`/`noImpact`
  // while a part is still in flight (as opposed to a digest that genuinely has none).
  summaryWriting: 'Writing the summary…',
  impactWriting: 'Writing the impact…',
  areaWriting: 'Writing this area…',
  partFailed: "Couldn't write this part.",
  partBudget: 'The daily budget ran out before this part could run.',
  // First Explain of a project (DIG-76 scope item 6): the context part runs alongside the digest
  // parts instead of blocking them.
  contextBuilding: "Building this project's context alongside this Explain.",
} as const;
const READER_KO = {
  switcherLabel: '설명 단계',
  switcherHint: '0~3 키로 단계를 전환하세요',
  breadcrumbLabel: '현재 위치',
  digestCrumb: (when: string) => `다이제스트 · ${when}`,
  loadingDigest: '이 다이제스트를 불러오는 중…',
  digestLoadError: (msg: string) => `이 다이제스트를 불러오지 못했습니다: ${msg}`,
  digestPending: '이 다이제스트는 아직 설명 중입니다.',
  digestError: '이 다이제스트를 설명하지 못했습니다. 다시 시도하거나 다른 다이제스트를 선택하세요.',
  digestTruncated: '이 다이제스트의 일부가 크기 제한으로 잘려, 일부 영역이 누락되었을 수 있습니다.',
  retry: '다시 시도',
  retrying: '다시 시도하는 중…',
  retryNoBudget: '오늘 남은 설명 없음',
  noHeadline: '이 다이제스트에는 아직 요약이 없습니다.',
  period: (from: string, to: string) => `${from} → ${to}`,
  fileCount: (n: number) => `파일 ${n}개`,
  noImpact: '이 다이제스트에는 아직 영향 요약이 없습니다.',
  internalOnly: '사용자가 체감할 변화는 없습니다: 내부적인 변경입니다.',
  noAreas: '이 다이제스트에는 아직 영역이 없습니다.',
  areaHow: '무엇이 바뀌었는지',
  areaWhy: '이유',
  openArea: '코드 살펴보기',
  filteredTo: (shown: number, total: number) => `영역 ${total}개 중 ${shown}개 관련`,
  noAreaForNode: '프로젝트의 이 부분을 다루는 영역이 없습니다.',
  clearFilter: '모든 영역 보기',
  filterAnnounce: (path: string) => `${path}와 관련된 영역을 표시합니다`,
  filterCleared: '모든 영역을 표시합니다',
  notAnalysed: '분석되지 않음',
  pickArea: '코드를 살펴볼 영역을 선택하세요.',
  nextLevel: (key: string, label: string) => `다음: ${key} ${label}`,
  areasGlanceHeading: '이 다이제스트의 영역',
  openAreaCard: '영역 열기',
  summaryWriting: '요약을 작성하는 중…',
  impactWriting: '영향을 작성하는 중…',
  areaWriting: '이 영역을 작성하는 중…',
  partFailed: '이 부분을 작성하지 못했습니다.',
  partBudget: '일일 예산이 소진되어 이 부분은 아직 실행되지 않았습니다.',
  contextBuilding: '이번 설명과 함께 프로젝트 컨텍스트를 빌드하는 중입니다.',
} as const;
export function readerCopy(lang: Lang = 'en') {
  return lang === 'ko' ? READER_KO : READER_EN;
}

// --- Welcome-back strip (DIG-61 P6): client-only "N digests since you last looked" ---------------

const WELCOME_BACK_EN = {
  strip: (digests: number, sinceLabel: string, files: number) =>
    `${plural(digests, 'digest')} since you last looked, ${sinceLabel} · ${plural(files, 'file')} total`,
  openDigestList: 'Open digest list',
} as const;
const WELCOME_BACK_KO = {
  strip: (digests: number, sinceLabel: string, files: number) =>
    `마지막으로 본 이후 다이제스트 ${digests}개, ${sinceLabel} · 파일 ${files}개`,
  openDigestList: '다이제스트 목록 열기',
} as const;
export function welcomeBackCopy(lang: Lang = 'en') {
  return lang === 'ko' ? WELCOME_BACK_KO : WELCOME_BACK_EN;
}

// --- Per-area reviewed mark (DIG-61 P5 option A): shared by the L3 header toggle and the small
// L2/L3-picker indicator ---------------------------------------------------------------------------

const REVIEWED_EN = {
  mark: 'Mark as reviewed',
  reviewed: 'Reviewed',
  badge: 'Reviewed',
} as const;
const REVIEWED_KO = {
  mark: '검토됨으로 표시',
  reviewed: '검토됨',
  badge: '검토됨',
} as const;
export function reviewedCopy(lang: Lang = 'en') {
  return lang === 'ko' ? REVIEWED_KO : REVIEWED_EN;
}

// --- L3 walkthrough (DIG-50/52) -------------------------------------------------------------------

const WALKTHROUGH_EN = {
  regionLabel: (title: string) => `Code walkthrough: ${title}`,
  loading: 'Loading this area…',
  loadError: (msg: string) => `Couldn't load this area: ${msg}`,
  generate: 'Explain this code',
  generateCost: (left: number) => `Uses 1 of ${plural(left, 'Explain', 'Explains')} left today`,
  noBudget: 'No Explains left today. The walkthrough can be generated after the daily limit resets.',
  notGenerated: 'This area has no walkthrough yet. The diff is below.',
  generating: 'Writing the walkthrough…',
  generateError: "Couldn't write the walkthrough.",
  retry: 'Try again',
  truncated: 'The walkthrough was cut short; the parts it skipped are listed at the end.',
  overview: 'Overview',
  stepLabel: (n: number) => `Step ${n}`,
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  mechanical: 'Mechanical',
  stepsNav: 'Steps',
  previous: 'Previous',
  next: 'Next',
  stepKeysHint: 'Press n / p for the next or previous step',
  check: 'What to check',
  fullDiff: 'The diff',
  showFullDiff: 'View full diff',
  hideFullDiff: 'Hide full diff',
  missingRange: (path: string, start: number, end: number) => {
    const r = start === end ? `line ${start}` : `lines ${start}–${end}`;
    return `${r} of ${path} are not in the stored diff.`;
  },
  showAll: (n: number) => `Show all ${plural(n, 'line')}`,
  showLess: 'Show less',
  showCode: 'Show code',
  hideCode: 'Hide code',
  noTextChange: 'No text changes to show (binary or mode change).',
  notAnalysed: 'Not analysed',
  // Step ↔ code mapping (DIG-71/81/96): the range a snippet or hunk-block line covers, and the
  // aria-live announcement fired on a step change.
  rangeLabel: (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}–${end}`),
  goToStep: (n: number) => `Go to step ${n}`,
  // Fast Explain (DIG-73/76): the area's L2 text (this line) and its L3 walkthrough land
  // separately and on different schedules, so this area's own placeholder is distinct from
  // `generating` above (which is about the walkthrough itself).
  areaWriting: 'Writing this area…',
} as const;
const WALKTHROUGH_KO = {
  regionLabel: (title: string) => `코드 설명: ${title}`,
  loading: '이 영역을 불러오는 중…',
  loadError: (msg: string) => `이 영역을 불러오지 못했습니다: ${msg}`,
  generate: '이 코드 설명하기',
  generateCost: (left: number) => `오늘 남은 설명 ${left}회 중 1회 사용`,
  noBudget: '오늘 남은 설명이 없습니다. 일일 한도가 초기화된 후 설명을 생성할 수 있습니다.',
  notGenerated: '이 영역에는 아직 설명이 없습니다. 아래에 diff가 있습니다.',
  generating: '설명을 작성하는 중…',
  generateError: '설명을 작성하지 못했습니다.',
  retry: '다시 시도',
  truncated: '설명이 중간에 잘렸습니다. 다루지 못한 부분은 마지막에 나열되어 있습니다.',
  overview: '개요',
  stepLabel: (n: number) => `${n}단계`,
  stepOf: (n: number, total: number) => `${total}단계 중 ${n}단계`,
  mechanical: '기계적 변경',
  stepsNav: '단계',
  previous: '이전',
  next: '다음',
  stepKeysHint: 'n / p 키로 다음 또는 이전 단계로 이동하세요',
  check: '확인할 사항',
  fullDiff: 'Diff',
  showFullDiff: '전체 diff 보기',
  hideFullDiff: '전체 diff 숨기기',
  missingRange: (path: string, start: number, end: number) => {
    const r = start === end ? `${start}번째 줄` : `${start}–${end}번째 줄`;
    return `${path}의 ${r}이 저장된 diff에 없습니다.`;
  },
  showAll: (n: number) => `${n}줄 모두 보기`,
  showLess: '간략히 보기',
  showCode: '코드 보기',
  hideCode: '코드 숨기기',
  noTextChange: '표시할 텍스트 변경이 없습니다 (바이너리 또는 모드 변경).',
  notAnalysed: '분석되지 않음',
  // Draft, not a native-speaker sign-off (docs/ux/dig71-step-code-mapping.md §5) — native check requested in the handoff comment.
  rangeLabel: (start: number, end: number) => (start === end ? `${start}번째 줄` : `${start}–${end}번째 줄`),
  goToStep: (n: number) => `${n}단계로 이동`,
  areaWriting: '이 영역을 작성하는 중…',
} as const;
export function walkthroughCopy(lang: Lang = 'en') {
  return lang === 'ko' ? WALKTHROUGH_KO : WALKTHROUGH_EN;
}

// --- Graph pane (DIG-50/52) -------------------------------------------------------------------------

const GRAPH_EN = {
  label: 'Project graph',
  // DIG-82: changed nodes are filled and the rest hollow, so the legend names the shape, not a colour.
  legendChanged: 'Filled: changed in this digest',
  legendSelected: 'Outlined: selected area',
  fitChanges: 'Fit to changes',
  fitAll: 'Show everything',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  loading: 'Loading the graph…',
  loadError: (msg: string) => `Couldn't load the graph: ${msg}`,
  folded: 'Some unchanged folders are folded to keep the graph readable.',
  keysHint: 'Arrow keys move between nodes; Enter opens one.',
  show: 'Show graph',
  hide: 'Hide graph',
  nodeFiles: (n: number) => plural(n, 'file'),
  summaryNone: 'No files changed.',
  summary: (files: number, folders: number) =>
    folders > 0 ? `${plural(files, 'file')} changed in ${plural(folders, 'folder')}.` : `${plural(files, 'file')} changed.`,
  openHint: (areas: number) => (areas === 1 ? 'Opens its area at L3' : areas > 1 ? `Touches ${plural(areas, 'area')}; opens them at L2` : 'Not in any area'),
  expandHint: 'Folded; press to unfold',
} as const;
const GRAPH_KO = {
  label: '프로젝트 그래프',
  legendChanged: '채운 점: 이 다이제스트에서 변경됨',
  legendSelected: '테두리: 선택된 영역',
  fitChanges: '변경 사항에 맞추기',
  fitAll: '전체 보기',
  zoomIn: '확대',
  zoomOut: '축소',
  loading: '그래프를 불러오는 중…',
  loadError: (msg: string) => `그래프를 불러오지 못했습니다: ${msg}`,
  folded: '그래프를 보기 쉽게 유지하기 위해 변경되지 않은 일부 폴더를 접었습니다.',
  keysHint: '방향키로 노드 사이를 이동하고, Enter로 엽니다.',
  show: '그래프 보기',
  hide: '그래프 숨기기',
  nodeFiles: (n: number) => `파일 ${n}개`,
  summaryNone: '변경된 파일이 없습니다.',
  summary: (files: number, folders: number) =>
    folders > 0 ? `폴더 ${folders}개에서 파일 ${files}개가 변경되었습니다.` : `파일 ${files}개가 변경되었습니다.`,
  openHint: (areas: number) => (areas === 1 ? 'L3에서 해당 영역을 엽니다' : areas > 1 ? `${areas}개 영역과 관련됨; L2에서 엽니다` : '어떤 영역에도 속하지 않음'),
  expandHint: '접힘; 펼치려면 누르세요',
} as const;
export function graphCopy(lang: Lang = 'en') {
  return lang === 'ko' ? GRAPH_KO : GRAPH_EN;
}

// --- "What DigestIT knows" (DIG-97/102/104, milestone 4 project memory) --------------------------
// Route /memory?project=&digest=: docs/ux/decision-4-memory.md is the source of truth for exact
// wording (changes 1-11); docs/ux/brief-4-memory.md fills in anything the decision doesn't override.
import type { MemoryKind, MemorySource, MemoryTrigger } from '@digestit/core';

const MEMORY_KIND_LABEL_EN: Record<MemoryKind, string> = { area: 'Areas', term: 'Terms', thread: 'Ongoing work', note: 'Your notes' };
const MEMORY_KIND_LABEL_KO: Record<MemoryKind, string> = { area: '영역', term: '용어', thread: '진행 중인 작업', note: '내 메모' };
const MEMORY_KIND_NOUN_EN: Record<MemoryKind, string> = { area: 'Area', term: 'Term', thread: 'Thread', note: 'Note' };
const MEMORY_KIND_NOUN_KO: Record<MemoryKind, string> = { area: '영역', term: '용어', thread: '스레드', note: '메모' };

const MEMORY_SOURCE_BADGE_EN: Record<MemorySource, string> = {
  code: 'From the code', digest: 'From earlier digests', summary: 'Summarised', user: 'From you',
};
const MEMORY_SOURCE_BADGE_KO: Record<MemorySource, string> = {
  code: '코드에서', digest: '이전 다이제스트에서', summary: '요약됨', user: '직접 작성',
};

const MEMORY_TRIGGER_LABEL_EN: Record<MemoryTrigger, string> = {
  init: 'initial scan', 'after-explain': 'update after a digest', idle: 'background summary run',
  daily: 'daily sweep', manual: 'manual update', user: 'your edit', rollback: 'the last undo',
};
const MEMORY_TRIGGER_LABEL_KO: Record<MemoryTrigger, string> = {
  init: '최초 스캔', 'after-explain': '다이제스트 이후 업데이트', idle: '백그라운드 요약 실행',
  daily: '일일 점검', manual: '수동 업데이트', user: '직접 수정', rollback: '이전 실행 취소',
};

export function memoryKindLabel(kind: MemoryKind, lang: Lang = 'en'): string {
  return (lang === 'ko' ? MEMORY_KIND_LABEL_KO : MEMORY_KIND_LABEL_EN)[kind];
}
export function memoryKindNoun(kind: MemoryKind, lang: Lang = 'en'): string {
  return (lang === 'ko' ? MEMORY_KIND_NOUN_KO : MEMORY_KIND_NOUN_EN)[kind];
}
export function memorySourceBadge(source: MemorySource, lang: Lang = 'en'): string {
  return (lang === 'ko' ? MEMORY_SOURCE_BADGE_KO : MEMORY_SOURCE_BADGE_EN)[source];
}
export function memoryTriggerLabel(trigger: MemoryTrigger, lang: Lang = 'en'): string {
  return (lang === 'ko' ? MEMORY_TRIGGER_LABEL_KO : MEMORY_TRIGGER_LABEL_EN)[trigger];
}

const MEMORY_EN = {
  // Entry points (brief §2)
  linkLabel: 'What DigestIT knows',
  settingsUsage: (jobsToday: number, share: number) => `Background summaries: ${jobsToday} of ${share} runs today`,
  groundedLine: (n: number) => `Grounded in ${plural(n, 'memory item')}`,
  usedLinkLabel: 'What DigestIT used',
  // Page chrome
  pageTitle: (projectName: string) => `What DigestIT knows about ${projectName}`,
  breadcrumbCurrent: 'What DigestIT knows',
  backToDigest: 'Back to digest',
  loadError: (msg: string) => `Could not load memory: ${msg}`,
  // Overview line (brief §3): "Areas 42 · Terms 118 · Ongoing work 3 · Your notes 5"
  countsSummary: (counts: Record<MemoryKind, number>) =>
    (['area', 'term', 'thread', 'note'] as const).map((k) => `${MEMORY_KIND_LABEL_EN[k]} ${counts[k]}`).join(' · '),
  showAllLabel: (total: number) => `Show all ${total}`,
  activeTab: 'Active',
  hiddenTab: (n: number) => `Hidden (${n})`,
  filterPlaceholder: 'Filter items…',
  filterLabel: 'Filter memory items',
  // Status and meta (brief §4)
  staleStatus: 'stale — files changed since checked',
  hiddenDeletedAt: (when: string) => `Deleted ${when}`,
  checkedAgo: (when: string) => `checked ${when}`,
  usedInDigests: (n: number) => `used in ${plural(n, 'digest')}`,
  pinnedMeta: 'Pinned',
  overriddenByLabel: 'Overridden by your note',
  correctsLabel: (kindNoun: string, key: string) => `Corrects: ${kindNoun} ${key}`,
  contextFileHint: 'from your context file — edit it there',
  // Row actions
  correct: 'Correct',
  pin: 'Pin',
  unpin: 'Unpin',
  delete: 'Delete',
  deleteConfirmLabel: 'Confirm delete?',
  deleting: 'Deleting…',
  deleteError: (msg: string) => `Could not delete this item: ${msg}`,
  restore: 'Restore',
  restoring: 'Restoring…',
  restoreError: (msg: string) => `Could not restore this item: ${msg}`,
  pinError: (msg: string) => `Could not change this item: ${msg}`,
  edit: 'Edit',
  changedSinceDigest: 'changed since this digest',
  // Correct/Edit inline form (decision change 6)
  correctFormLabel: 'What is right instead',
  correctCounter: (used: number, max: number) => `${used} / ${max}`,
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving…',
  correctError: (msg: string) => `Could not save the correction: ${msg}`,
  // Privacy and summaries switch (decision change 8)
  privacyTopLine: (provider: string) => (provider === 'stub'
    ? 'Nothing leaves this machine.'
    : `Stored on this host. When you Explain, the items that match the change are sent to ${provider} with it.`),
  summariesToggleLabel: 'Background summaries',
  whatThisSends: 'What this sends',
  whatThisSendsBody: (provider: string, share: number) =>
    `DigestIT writes background summaries using ${provider}: a folder's exported names, what it imports and the first paragraph of its README, or the one-line summaries of a line of work. File contents and diffs are not sent. Up to ${share} runs a day, shared across all projects.`,
  usageLine: (jobsToday: number, share: number, reserve: number) =>
    `Today: ${jobsToday} of ${share} background summaries used, shared across all your projects. They pause once fewer than ${reserve} of today's Explain calls are left.`,
  settingsError: (msg: string) => `Could not change this setting: ${msg}`,
  // Last update / Undo (decision doc §6)
  lastUpdatedLine: (trigger: string, when: string, changed: number) => `Last updated: ${trigger}, ${when} (${plural(changed, 'item')} changed)`,
  undoLabel: 'Undo last update',
  undoConfirmPrompt: (trigger: string, when: string, changed: number) => `Undo the ${trigger} from ${when} — ${plural(changed, 'item')} changed?`,
  undoConfirmLabel: 'Confirm undo?',
  undoing: 'Undoing…',
  undoError: (msg: string) => `Could not undo: ${msg}`,
  // Export / Clear (decision change 9)
  exportLabel: 'Export',
  clearLabel: 'Clear',
  clearConfirmLabel: 'Confirm clear all memory?',
  clearConfirmPrompt: (projectName: string, n: number) =>
    `This deletes all ${plural(n, 'item')} for ${projectName} and can't be undone. Export first if you may want them back. Digests you've already read are not affected.`,
  clearing: 'Clearing…',
  clearError: (msg: string) => `Could not clear memory: ${msg}`,
  // Empty states (brief §7)
  emptyProject: (projectName: string) => `DigestIT hasn't looked at ${projectName} yet. Areas and terms appear after the first Explain.`,
  emptyThreads: 'No ongoing work tracked yet — a thread appears once a digest continues something from an earlier one.',
  emptyNotes: 'Nothing yet. Correct anything you see above, or add project facts to your context file — they show up here.',
  // Per-digest "used" view (brief §5)
  usedForHeading: (n: number) => `Used for this digest (${plural(n, 'item')})`,
  usedForSummary: 'Used for: L0 summary',
  usedForArea: (area: string) => `Used for: ${area} (L2)`,
  usedForWalkthrough: (area: string) => `Used for: ${area} (L3)`,
  droppedForBudget: (n: number) => `${plural(n, 'more item')} considered but left out for space.`,
  noteTitleCorrection: 'Correction',
  noteTitleContextFile: 'Note',
  threadStateOpen: 'open',
  threadStateClosed: 'closed',
} as const;

const MEMORY_KO = {
  linkLabel: 'DigestIT가 아는 것',
  settingsUsage: (jobsToday: number, share: number) => `백그라운드 요약: 오늘 ${share}회 중 ${jobsToday}회 실행`,
  groundedLine: (n: number) => `메모리 항목 ${n}개를 근거로 함`,
  usedLinkLabel: '무엇을 사용했는지 보기',
  pageTitle: (projectName: string) => `${projectName}에 대해 DigestIT가 아는 것`,
  breadcrumbCurrent: 'DigestIT가 아는 것',
  backToDigest: '다이제스트로 돌아가기',
  loadError: (msg: string) => `메모리를 불러오지 못했습니다: ${msg}`,
  countsSummary: (counts: Record<MemoryKind, number>) =>
    (['area', 'term', 'thread', 'note'] as const).map((k) => `${MEMORY_KIND_LABEL_KO[k]} ${counts[k]}개`).join(' · '),
  showAllLabel: (total: number) => `${total}개 모두 보기`,
  activeTab: '표시 중',
  hiddenTab: (n: number) => `숨김 (${n})`,
  filterPlaceholder: '항목 필터…',
  filterLabel: '메모리 항목 필터',
  staleStatus: '오래됨 — 확인 이후 파일이 변경됨',
  hiddenDeletedAt: (when: string) => `${when} 삭제됨`,
  checkedAgo: (when: string) => `${when} 확인`,
  usedInDigests: (n: number) => `다이제스트 ${n}개에서 사용됨`,
  pinnedMeta: '고정됨',
  overriddenByLabel: '내가 작성한 메모로 대체됨',
  correctsLabel: (kindNoun: string, key: string) => `${kindNoun} ${key} 수정`,
  contextFileHint: '컨텍스트 파일에서 온 항목 — 그 파일에서 수정하세요',
  correct: '수정',
  pin: '고정',
  unpin: '고정 해제',
  delete: '삭제',
  deleteConfirmLabel: '삭제 확인',
  deleting: '삭제하는 중…',
  deleteError: (msg: string) => `이 항목을 삭제하지 못했습니다: ${msg}`,
  restore: '복원',
  restoring: '복원하는 중…',
  restoreError: (msg: string) => `이 항목을 복원하지 못했습니다: ${msg}`,
  pinError: (msg: string) => `이 항목을 변경하지 못했습니다: ${msg}`,
  edit: '편집',
  changedSinceDigest: '이 다이제스트 이후 변경됨',
  correctFormLabel: '실제로 맞는 내용',
  correctCounter: (used: number, max: number) => `${used} / ${max}`,
  save: '저장',
  cancel: '취소',
  saving: '저장하는 중…',
  correctError: (msg: string) => `수정 내용을 저장하지 못했습니다: ${msg}`,
  privacyTopLine: (provider: string) => (provider === 'stub'
    ? '이 기기 밖으로 나가지 않습니다.'
    : `이 서버에 저장됩니다. Explain을 실행하면 변경 사항과 관련된 항목이 ${provider}로 함께 전송됩니다.`),
  summariesToggleLabel: '백그라운드 요약',
  whatThisSends: '무엇을 전송하는지 보기',
  whatThisSendsBody: (provider: string, share: number) =>
    `DigestIT는 ${provider}를 사용해 백그라운드 요약을 작성합니다: 폴더가 내보내는 이름, 가져오는 대상, README의 첫 문단, 또는 진행 중인 작업의 한 줄 요약입니다. 파일 내용이나 diff는 전송되지 않습니다. 전체 프로젝트에서 공유되는 하루 ${share}회 한도 안에서 실행됩니다.`,
  usageLine: (jobsToday: number, share: number, reserve: number) =>
    `오늘: 전체 프로젝트에서 공유되는 백그라운드 요약 ${share}회 중 ${jobsToday}회 사용됨. 오늘 남은 Explain 호출이 ${reserve}회 미만이 되면 일시 중지됩니다.`,
  settingsError: (msg: string) => `설정을 변경하지 못했습니다: ${msg}`,
  lastUpdatedLine: (trigger: string, when: string, changed: number) => `마지막 업데이트: ${trigger}, ${when} (${changed}개 항목 변경)`,
  undoLabel: '최근 업데이트 실행 취소',
  undoConfirmPrompt: (trigger: string, when: string, changed: number) => `${when}의 ${trigger}를 취소할까요 — ${changed}개 항목이 변경됩니다?`,
  undoConfirmLabel: '실행 취소 확인',
  undoing: '취소하는 중…',
  undoError: (msg: string) => `취소하지 못했습니다: ${msg}`,
  exportLabel: '내보내기',
  clearLabel: '모두 지우기',
  clearConfirmLabel: '모두 지우기를 확인할까요',
  clearConfirmPrompt: (projectName: string, n: number) =>
    `${projectName}의 항목 ${n}개가 모두 삭제되며 되돌릴 수 없습니다. 나중에 필요하면 먼저 내보내세요. 이미 읽은 다이제스트에는 영향이 없습니다.`,
  clearing: '지우는 중…',
  clearError: (msg: string) => `메모리를 지우지 못했습니다: ${msg}`,
  emptyProject: (projectName: string) => `아직 DigestIT가 ${projectName}를 살펴보지 않았습니다. 첫 Explain 이후 영역과 용어가 나타납니다.`,
  emptyThreads: '아직 추적 중인 진행 작업이 없습니다 — 다이제스트가 이전 작업을 이어받을 때 스레드가 생깁니다.',
  emptyNotes: '아직 메모가 없습니다. 위의 항목을 수정하거나, 컨텍스트 파일에 프로젝트 사실을 추가하면 여기에 나타납니다.',
  usedForHeading: (n: number) => `이 다이제스트에서 사용됨 (${n}개)`,
  usedForSummary: '사용 위치: L0 요약',
  usedForArea: (area: string) => `사용 위치: ${area} (L2)`,
  usedForWalkthrough: (area: string) => `사용 위치: ${area} (L3)`,
  droppedForBudget: (n: number) => `${n}개 항목을 더 검토했지만 공간 제약으로 제외했습니다.`,
  noteTitleCorrection: '수정 메모',
  noteTitleContextFile: '메모',
  threadStateOpen: '진행 중',
  threadStateClosed: '종료됨',
} as const;

export function memoryCopy(lang: Lang = 'en') {
  return lang === 'ko' ? MEMORY_KO : MEMORY_EN;
}
