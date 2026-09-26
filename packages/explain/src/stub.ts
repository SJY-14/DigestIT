import { NO_CHANGE, truncateWords } from './validate.js';
import type {
  BriefingFacts, BriefingResult, BriefingSentence, ExplanationInput, ExplanationProvider,
  ProviderResult, RangeInput, RollupInput, RollupResult,
} from './provider.js';

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
            `Touches ${input.files.length} file(s): +${additions} / -${deletions} lines.`,
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
    r.levels.l1.bullets[1] = `${input.members.length} commit(s), ${input.files.length} file(s) in the range.`;
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
        l0: { text: `${n} unit(s) moved in this window.` },
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
      sentences.push({ text: `${u.unit} is still unreviewed (${u.size} line(s) changed).`, units: [u.unit] });
    }
    if (sentences.length === 0 && input.units.length > 0) {
      const u = input.units[0]!;
      sentences.push({ text: `${u.key}: ${truncateWords(u.l0, 30)}`, units: [u.key] });
    }
    return { sentences: sentences.slice(0, 5), provider: this.id, model: this.model };
  }
}
