import type { AreaWalkthrough, ExplainLanguage, HunkRef, WalkthroughStep } from '@digestit/core';
import { NO_CHANGE, LIMITS, truncateWords } from './validate.js';
import { areaHunks } from './difflines.js';
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

  /** Deterministic walkthrough: one step per file (the rest grouped into the last step), covering every hunk the prompt shows. */
  async explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    const ko = input.language === 'ko';
    const byPath = new Map(input.files.map((f) => [f.path, f]));
    const inventory = areaHunks(input.files);
    const groups = inventory.length > LIMITS.walkStepsMax
      ? [...inventory.slice(0, LIMITS.walkStepsMax - 1).map((f) => [f]), inventory.slice(LIMITS.walkStepsMax - 1)]
      : inventory.map((f) => [f]);
    const steps: WalkthroughStep[] = groups.map((group) => {
      const hunks: HunkRef[] = group.flatMap((f) => f.hunks.map((hunk) => ({ path: f.path, hunk })));
      const files = group.map((f) => byPath.get(f.path)!);
      const a = files.reduce((n, f) => n + f.additions, 0);
      const d = files.reduce((n, f) => n + f.deletions, 0);
      if (group.length > 1) {
        const names = list(group.map((f) => basename(f.path)), input.language);
        return {
          title: ko ? '나머지 파일' : 'The remaining files',
          body: ko
            ? `${names}: hunk ${hunks.length}개, ${delta(a, d, 'ko')}. 스텁 제공자는 이유를 설명하지 않습니다.`
            : `Edits ${names} in ${count(hunks.length, 'hunk')}, ${delta(a, d, 'en')}. The stub provider does not explain why.`,
          hunks, mechanical: false,
        };
      }
      const f = files[0]!;
      const name = basename(f.path);
      const verb = f.status === 'A' ? (ko ? '추가' : 'Add') : f.status === 'D' ? (ko ? '삭제' : 'Remove') : (ko ? '수정' : 'Edit');
      return {
        title: ko ? `${name} ${verb}` : `${verb} ${name}`,
        body: ko
          ? `${f.path}: hunk ${hunks.length}개, ${delta(a, d, 'ko')}. 스텁 제공자는 이유를 설명하지 않습니다.`
          : `${verb}s ${f.path} in ${count(hunks.length, 'hunk')}, ${delta(a, d, 'en')}. The stub provider does not explain why.`,
        hunks, mechanical: false,
      };
    });
    const names = list(inventory.map((f) => basename(f.path)), input.language);
    const largest = [...inventory].sort((x, y) => {
      const fx = byPath.get(x.path)!;
      const fy = byPath.get(y.path)!;
      return fy.additions + fy.deletions - (fx.additions + fx.deletions) || (x.path < y.path ? -1 : 1);
    })[0];
    const overview = ko
      ? `이 영역에서 다루는 파일은 ${names || '없음'}입니다. 스텁 제공자는 코드를 읽지 않고 파일별 hunk만 나열합니다.`
      : `This area covers ${names || 'no analysable file'}. The stub provider lists each file's hunks without reading them.`;
    const check = largest
      ? [ko ? `가장 큰 변경부터 확인하세요: ${largest.path}.` : `Read ${largest.path} first; it is the largest edit in this area.`]
      : [ko ? '분석할 수 있는 hunk가 없으니 파일을 직접 확인하세요.' : 'No hunk could be analysed; open the files directly.'];
    const content: AreaWalkthrough = { overview, steps, check };
    onProgress?.({ overview, steps, done: true });
    return { provider: this.id, model: this.model, content };
  }
}
