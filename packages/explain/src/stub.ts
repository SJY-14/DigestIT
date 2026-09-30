import type { AreaWalkthrough, ExplainLanguage, LineRange, StepCallout, WalkthroughStep } from '@digestit/core';
import { changedCount, walkPatch, type PatchHunk, type PatchLine } from '@digestit/core/hunks';
import { NO_CHANGE, LIMITS, truncateWords } from './validate.js';
import { promptHunks } from './difflines.js';
import type {
  AreaInput, AreaResult, AreaStreamChunk, BriefingFacts, BriefingResult, BriefingSentence, ContextInput, ContextResult,
  DigestAreaTextInput, DigestAreaTextResult, DigestInput, DigestResult, DigestSummaryInput, DigestSummaryResult,
  ExplanationInput, ExplanationProvider, ProviderFile, ProviderResult, RangeInput, RollupInput, RollupResult,
} from './provider.js';

function firstSentence(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? text.trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(line);
  return (m ? m[1]! : line).trim();
}

/** "1 file" / "3 files": the stub never writes "file(s)". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function topExtension(extensions: Record<string, number>): string | null {
  const entries = Object.entries(extensions).filter(([e]) => e !== '');
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return `.${entries[0]![0]}`;
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** "adding 2 lines and removing 1" / "2줄 추가, 1줄 삭제", leaving out a zero side. */
function delta(a: number, d: number, language: ExplainLanguage): string {
  if (language === 'ko') return [a > 0 ? `${a}줄 추가` : '', d > 0 ? `${d}줄 삭제` : ''].filter(Boolean).join(', ') || '내용 변경 없음';
  const parts = [a > 0 ? `adding ${count(a, 'line')}` : '', d > 0 ? `removing ${count(d, 'line')}` : ''].filter(Boolean);
  return parts.join(' and ') || 'with no line changes';
}

/** "a, b and c" / "a, b 및 c", capped at `max` names plus "N more". */
function list(names: readonly string[], language: ExplainLanguage, max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (language === 'ko') {
    const items = rest > 0 ? [...shown, `그 외 ${rest}개`] : shown;
    return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} 및 ${items[items.length - 1]}`;
  }
  const items = rest > 0 ? [...shown, `${rest} more`] : shown;
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Maximal contiguous runs of changed (`+`/`-`) lines, so a chunk boundary never lands inside one replacement block. */
function changeGroups(lines: readonly PatchLine[]): PatchLine[][] {
  const groups: PatchLine[][] = [];
  let cur: PatchLine[] = [];
  for (const l of lines) {
    if (l.kind === '+' || l.kind === '-') cur.push(l);
    else if (cur.length > 0) { groups.push(cur); cur = []; }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * `LineRange`s over one hunk's own changed lines: one range normally, several when the hunk has
 * more than `LIMITS.walkRangeMaxChanged` changed lines (never splitting inside one replacement
 * block), and at least two when this hunk alone is the file's only hunk and the file has more than
 * `LIMITS.walkFileChangedMax` changed lines (so no single range covers 100% of it, rule 3).
 */
function hunkRanges(path: string, hunk: PatchHunk, fileChanged: number): LineRange[] {
  const groups = changeGroups(hunk.lines);
  if (groups.length === 0) return [];
  const hunkChanged = groups.reduce((n, g) => n + g.length, 0);
  const wholeFile = fileChanged > LIMITS.walkFileChangedMax && hunkChanged === fileChanged;
  const cap = wholeFile ? Math.max(1, Math.ceil(hunkChanged / 2)) : LIMITS.walkRangeMaxChanged;
  const chunks: PatchLine[][] = [];
  let cur: PatchLine[] = [];
  let n = 0;
  for (const g of groups) {
    if (g.length > cap) {
      // One replacement block bigger than the cap on its own: split by position (best effort;
      // typically pure additions or pure deletions, so this never separates a delete from its add).
      if (cur.length > 0) { chunks.push(cur); cur = []; n = 0; }
      for (let i = 0; i < g.length; i += cap) chunks.push(g.slice(i, i + cap));
      continue;
    }
    if (cur.length > 0 && n + g.length > cap) { chunks.push(cur); cur = []; n = 0; }
    cur.push(...g);
    n += g.length;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.map((lines) => {
    const newNos = lines.map((l) => l.newNo).filter((no): no is number => no !== undefined);
    if (newNos.length > 0) return { path, side: 'new' as const, start: Math.min(...newNos), end: Math.max(...newNos) };
    const oldNos = lines.map((l) => l.oldNo).filter((no): no is number => no !== undefined);
    return { path, side: 'old' as const, start: Math.min(...oldNos), end: Math.max(...oldNos) };
  });
}

/** Deterministic placeholder built from the commit message and diffstat. No network, no process. */
export class StubProvider implements ExplanationProvider {
  readonly id = 'stub';
  readonly model = 'stub-1';

  async explain(input: ExplanationInput): Promise<ProviderResult> {
    const analysed = input.files.filter((f) => f.filteredReason === null);
    const skipped = input.files.filter((f) => f.filteredReason !== null);
    const additions = input.files.reduce((n, f) => n + f.additions, 0);
    const deletions = input.files.reduce((n, f) => n + f.deletions, 0);
    return {
      provider: this.id,
      model: this.model,
      levels: {
        l0: { text: truncateWords(input.title, 20) },
        l1: {
          userVisible: false,
          bullets: [
            NO_CHANGE,
            `Touches ${count(input.files.length, 'file')}: +${additions} / -${deletions} lines.`,
          ],
        },
        l2: {
          items: analysed.slice(0, 8).map((f) => ({
            path: f.path,
            role: 'file',
            change: `${f.status} +${f.additions} -${f.deletions}`,
          })),
          notAnalysed: skipped.map((f) => `${f.path} (${f.filteredReason})`),
        },
        l3: { annotations: [] },
      },
    };
  }

  /** Same placeholder as a commit, with the commit count in L1; the title is the work-unit title. */
  async explainRange(input: RangeInput): Promise<ProviderResult> {
    const r = await this.explain({ repoName: input.repoName, title: input.title, message: '', files: input.files });
    r.levels.l1.bullets[1] = `${count(input.members.length, 'commit')} and ${count(input.files.length, 'file')} in the range.`;
    return r;
  }

  /** Deterministic roll-up from unit L0/L1 text only. */
  async rollup(input: RollupInput): Promise<RollupResult> {
    const n = input.units.length;
    const visible = input.units.filter((u) => u.userVisible);
    const keys = input.units.map((u) => u.key).join(', ');
    const bullets = visible.length === 0
      ? [NO_CHANGE, `Moved: ${keys}.`]
      : visible.slice(0, 3).map((u) => `${u.key}: ${u.bullets[0] ?? u.l0}`);
    return {
      provider: this.id,
      model: this.model,
      levels: {
        l0: { text: `${count(n, 'unit')} moved in this window.` },
        l1: { userVisible: visible.length > 0, bullets },
      },
    };
  }

  /** Deterministic narrative: needs-a-decision first, then unreviewed, then a fallback on what moved. */
  async briefing(input: BriefingFacts): Promise<BriefingResult> {
    const sentences: BriefingSentence[] = [];
    for (const d of input.needsDecision) {
      if (sentences.length >= 5) break;
      sentences.push({ text: `${d.unit} needs a decision: ${d.reason.replace(/_/g, ' ')}.`, units: [d.unit] });
    }
    for (const u of input.unreviewed) {
      if (sentences.length >= 5) break;
      sentences.push({ text: `${u.unit} is still unreviewed (${count(u.size, 'line')} changed).`, units: [u.unit] });
    }
    if (sentences.length === 0 && input.units.length > 0) {
      const u = input.units[0]!;
      sentences.push({ text: `${u.key}: ${truncateWords(u.l0, 30)}`, units: [u.key] });
    }
    return { sentences: sentences.slice(0, 5), provider: this.id, model: this.model };
  }

  /** Deterministic placeholder built from the map's own directories and manifests. No network, no process. */
  async explainContext(input: ContextInput): Promise<ContextResult> {
    const { map } = input;
    const ko = input.language === 'ko';
    const topDirs = map.dirs.filter((d) => d.path !== '').sort((a, b) => b.fileCount - a.fileCount || (a.path < b.path ? -1 : 1)).slice(0, 5);
    const modules = topDirs.map((d) => {
      const ext = topExtension(d.extensions);
      const role = ko
        ? `파일 ${d.fileCount}개${ext ? `, 주로 ${ext}` : ''}`
        : `${count(d.fileCount, 'file')}${ext ? `, mostly ${ext}` : ''}`;
      return { path: d.path, role };
    });
    const manifestNames = map.manifests.map((m) => m.name).filter((n): n is string => n !== null);
    const kind = map.manifests[0]?.kind ?? 'code';
    const purpose = map.readme
      ? truncateWords(firstSentence(map.readme.content), 20)
      : ko ? `파일 ${map.totalFiles}개로 이루어진 ${kind} 프로젝트입니다.` : `A ${kind} project with ${count(map.totalFiles, 'file')}.`;
    return {
      provider: this.id,
      model: this.model,
      content: {
        purpose,
        modules,
        glossary: manifestNames.slice(0, 5).map((n) => ({
          term: n, meaning: ko ? '매니페스트에 정의된 이 프로젝트의 패키지입니다.' : 'A package of this project, named in its manifest.',
        })),
        conventions: map.manifests.flatMap((m) => m.scripts ?? []).slice(0, 10)
          .map((sc) => (ko ? `패키지 매니저 스크립트 "${sc}"로 실행합니다.` : `Run "${sc}" via the package manager.`)),
      },
    };
  }

  /** Deterministic areas: one per top-level directory of the analysed files (root files grouped together). */
  async digest(input: DigestInput): Promise<DigestResult> {
    const ko = input.language === 'ko';
    const analysed = input.files.filter((f) => f.filteredReason === null);
    const skipped = input.files.filter((f) => f.filteredReason !== null);
    const additions = input.files.reduce((n, f) => n + f.additions, 0);
    const deletions = input.files.reduce((n, f) => n + f.deletions, 0);

    const groups = new Map<string, ProviderFile[]>();
    for (const f of analysed) {
      const slash = f.path.indexOf('/');
      const top = slash < 0 ? '' : f.path.slice(0, slash);
      const g = groups.get(top);
      if (g) g.push(f);
      else groups.set(top, [f]);
    }
    const dirName = (dir: string): string => (dir !== '' ? dir : ko ? '최상위 파일' : 'top-level files');
    const seenIds = new Set<string>();
    const items = [...groups.entries()].slice(0, 8).map(([dir, files]) => {
      const a = files.reduce((n, f) => n + f.additions, 0);
      const d = files.reduce((n, f) => n + f.deletions, 0);
      const base = dir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
      let id = base;
      for (let n = 2; seenIds.has(id); n++) id = `${base}-${n}`;
      seenIds.add(id);
      const isTestsOrDocs = files.every((f) => /(^|\/)(tests?|docs?|__tests__)(\/|$)/i.test(f.path));
      const names = files.map((f) => basename(f.path));
      return {
        id,
        paths: files.map((f) => f.path),
        title: truncateWords(list(names, input.language, 2), LIMITS.digestTitleWords),
        effect: ko
          ? (isTestsOrDocs ? '테스트나 문서만 바뀌어 사용자에게는 영향이 없습니다.' : '설명 없음: 스텁 제공자는 코드를 읽지 않습니다.')
          : (isTestsOrDocs ? 'Only tests or docs; nothing changes for users.' : 'Not described: the stub provider does not read the code.'),
        how: ko
          ? `파일 ${files.length}개 수정: ${a}줄 추가, ${d}줄 삭제.`
          : `Edits ${count(files.length, 'file')}: ${count(a, 'line')} added, ${d} removed.`,
        why: ko
          ? '스텁 제공자는 의도를 추론하지 않습니다. 이유를 보려면 실제 제공자로 설명하세요.'
          : 'The stub provider does not infer intent; explain with a real provider to get the reason.',
      };
    });
    const where = list([...groups.keys()].map(dirName), input.language);

    return {
      provider: this.id,
      model: this.model,
      levels: {
        l0: {
          text: ko
            ? `${where} 작업에 대한 스텁 요약이며, 코드를 읽지 않고 작성했습니다.`
            : `Stub summary of work in ${where}, written without reading the code.`,
        },
        l1: {
          userVisible: false,
          bullets: [
            ko
              ? `스텁 제공자는 사용자가 알아챌 변화를 판단하지 못하고, 파일 ${input.files.length}개에서 ${additions}줄 추가와 ${deletions}줄 삭제만 셉니다.`
              : `The stub provider cannot tell what users notice; it only counts ${count(additions, 'line')} added and ${deletions} removed across ${count(input.files.length, 'file')}.`,
          ],
        },
        l2: {
          items,
          notAnalysed: skipped.map((f) => `${f.path} (${f.filteredReason})`),
        },
      },
    };
  }

  /** Split `summary` part (DIG-74): the same L0/L1 as `digest`, over the whole diff and the given area list. */
  async explainDigestSummary(input: DigestSummaryInput): Promise<DigestSummaryResult> {
    const r = await this.digest({ repoName: input.repoName, files: input.files, context: input.context, language: input.language });
    return { provider: this.id, model: this.model, levels: r.levels };
  }

  /** Split `area:<id>` part (DIG-74): title/effect/how/why for this area's own files only. */
  async explainDigestAreaText(input: DigestAreaTextInput): Promise<DigestAreaTextResult> {
    const ko = input.language === 'ko';
    const analysed = input.files.filter((f) => f.filteredReason === null);
    const additions = analysed.reduce((n, f) => n + f.additions, 0);
    const deletions = analysed.reduce((n, f) => n + f.deletions, 0);
    const names = list(analysed.map((f) => basename(f.path)), input.language, 2);
    const isTestsOrDocs = analysed.length > 0 && analysed.every((f) => /(^|\/)(tests?|docs?|__tests__)(\/|$)/i.test(f.path));
    return {
      provider: this.id,
      model: this.model,
      content: {
        title: truncateWords(names || input.area.label, LIMITS.digestTitleWords),
        effect: ko
          ? (isTestsOrDocs ? '테스트나 문서만 바뀌어 사용자에게는 영향이 없습니다.' : '설명 없음: 스텁 제공자는 코드를 읽지 않습니다.')
          : (isTestsOrDocs ? 'Only tests or docs; nothing changes for users.' : 'Not described: the stub provider does not read the code.'),
        how: ko
          ? `파일 ${analysed.length}개 수정: ${additions}줄 추가, ${deletions}줄 삭제.`
          : `Edits ${count(analysed.length, 'file')}: ${count(additions, 'line')} added, ${deletions} removed.`,
        why: ko
          ? '스텁 제공자는 의도를 추론하지 않습니다. 이유를 보려면 실제 제공자로 설명하세요.'
          : 'The stub provider does not infer intent; explain with a real provider to get the reason.',
      },
    };
  }

  /**
   * Deterministic walkthrough: one step per hunk (the rest grouped into the last step when there
   * are more hunks than `walkStepsMax`), each step's range(s) over just that hunk's changed lines
   * (split at `walkRangeMaxChanged` for a big hunk, docs/l3-step-snippets.md) and one callout on
   * its first changed line, so every hunk the prompt shows is covered without ever repeating a
   * whole hunk under two steps.
   */
  async explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    const ko = input.language === 'ko';
    const byPath = new Map(input.files.map((f) => [f.path, f]));
    const fileChanged = new Map(input.files
      .filter((f) => f.patch !== null && f.filteredReason === null)
      .map((f) => [f.path, changedCount(walkPatch(f.patch!))]));
    const inventory: { path: string; hunk: PatchHunk }[] = input.files
      .filter((f) => f.filteredReason === null && f.patch !== null)
      .flatMap((f) => promptHunks(f.patch).map((hunk) => ({ path: f.path, hunk })));
    const groups = inventory.length > LIMITS.walkStepsMax
      ? [...inventory.slice(0, LIMITS.walkStepsMax - 1).map((h) => [h]), inventory.slice(LIMITS.walkStepsMax - 1)]
      : inventory.map((h) => [h]);
    const steps: WalkthroughStep[] = groups.map((group) => {
      const ranges = group.flatMap(({ path, hunk }) => hunkRanges(path, hunk, fileChanged.get(path) ?? 0));
      const callout = ranges[0]!;
      const callouts: StepCallout[] = [{
        path: callout.path, side: callout.side, start: callout.start, end: callout.start,
        note: ko ? '스텁 콜아웃: 분석 없음' : 'stub callout: not analysed',
      }];
      const a = group.reduce((n, { hunk }) => n + hunk.lines.filter((l) => l.kind === '+').length, 0);
      const d = group.reduce((n, { hunk }) => n + hunk.lines.filter((l) => l.kind === '-').length, 0);
      if (group.length > 1) {
        const names = list([...new Set(group.map(({ path }) => basename(path)))], input.language);
        return {
          title: ko ? '나머지 변경' : 'The remaining changes',
          body: ko
            ? `${names}: hunk ${group.length}개, ${delta(a, d, 'ko')}. 스텁 제공자는 이유를 설명하지 않습니다.`
            : `Edits ${names} in ${count(group.length, 'hunk')}, ${delta(a, d, 'en')}. The stub provider does not explain why.`,
          ranges, callouts, mechanical: false,
        };
      }
      const { path, hunk } = group[0]!;
      const f = byPath.get(path)!;
      const name = basename(path);
      const verb = f.status === 'A' ? (ko ? '추가' : 'Add') : f.status === 'D' ? (ko ? '삭제' : 'Remove') : (ko ? '수정' : 'Edit');
      const oneHunk = inventory.filter((h) => h.path === path).length === 1;
      const label = oneHunk ? name : ko ? `${name} hunk ${hunk.index}` : `${name}, hunk ${hunk.index}`;
      return {
        title: ko ? `${label} ${verb}` : `${verb} ${label}`,
        body: ko
          ? `${path} hunk ${hunk.index}: ${delta(a, d, 'ko')}. 스텁 제공자는 이유를 설명하지 않습니다.`
          : `${verb}s ${path} hunk ${hunk.index}, ${delta(a, d, 'en')}. The stub provider does not explain why.`,
        ranges, callouts, mechanical: false,
      };
    });
    const names = list([...new Set(inventory.map((h) => basename(h.path)))], input.language);
    const largest = [...input.files].filter((f) => f.filteredReason === null && f.patch !== null).sort((x, y) =>
      (y.additions + y.deletions) - (x.additions + x.deletions) || (x.path < y.path ? -1 : 1))[0];
    const overview = ko
      ? `이 영역에서 다루는 파일은 ${names || '없음'}입니다. 스텁 제공자는 코드를 읽지 않고 hunk만 나열합니다.`
      : `This area covers ${names || 'no analysable file'}. The stub provider lists each hunk without reading them.`;
    const check = largest
      ? [ko ? `가장 큰 변경부터 확인하세요: ${largest.path}.` : `Read ${largest.path} first; it is the largest edit in this area.`]
      : [ko ? '분석할 수 있는 hunk가 없으니 파일을 직접 확인하세요.' : 'No hunk could be analysed; open the files directly.'];
    const content: AreaWalkthrough = { overview, steps, check };
    onProgress?.({ overview, steps, done: true });
    return { provider: this.id, model: this.model, content };
  }
}
