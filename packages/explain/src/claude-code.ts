import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AllLevels,
  AreaInput,
  AreaResult,
  AreaStreamChunk,
  BriefingFacts,
  BriefingResult,
  CallTiming,
  ContextInput,
  ContextResult,
  DigestAreaTextContent,
  DigestAreaTextInput,
  DigestAreaTextResult,
  DigestInput,
  DigestResult,
  DigestSummaryInput,
  DigestSummaryLevels,
  DigestSummaryResult,
  Effort,
  ExplainTask,
  ExplanationInput,
  ExplanationProvider,
  MemoryAreaSummaryOut,
  MemorySummarizeAreasInput,
  MemorySummarizeAreasResult,
  MemorySummarizeThreadInput,
  MemorySummarizeThreadResult,
  ProviderResult,
  RangeInput,
  RollupInput,
  RollupResult,
} from './provider.js';
import { buildPrompt } from './prompt.js';
import { buildRangePrompt, buildRollupPrompt } from './range.js';
import { buildBriefingPrompt } from './briefing.js';
import { buildContextPrompt, CONTEXT_INSTRUCTIONS } from './context.js';
import {
  buildDigestAreaTextPrompt, buildDigestPrompt, buildDigestSummaryPrompt,
  DIGEST_AREA_TEXT_INSTRUCTIONS, DIGEST_INSTRUCTIONS, DIGEST_SUMMARY_INSTRUCTIONS,
} from './digest.js';
import { buildAreaPrompt, AREA_INSTRUCTIONS } from './area.js';
import {
  AREA_SUMMARY_INSTRUCTIONS, THREAD_SUMMARY_INSTRUCTIONS, buildAreaSummaryPrompt, buildThreadSummaryPrompt,
} from './memory-tasks.js';

export type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface TaskModelConfig {
  /** `claude --model`; a dated id, or an alias like `sonnet`/`haiku`. `'default'` omits the flag. */
  model: string;
  effort: Effort;
}

/**
 * Each option is kept behind its own switch (docs/explain-speed.md §2) so the operator A/B kit
 * can toggle it independently; off by default until the kit's measurement confirms a benefit.
 * `--bare` is deliberately not offered here: it drops OAuth.
 */
export interface CheapRunFlags {
  /** `--system-prompt <instructions>`; the diff/data stays in the user message. */
  systemPrompt: boolean;
  noSessionPersistence: boolean;
  strictMcpConfig: boolean;
  disableSlashCommands: boolean;
}

export const DEFAULT_CHEAP_RUN_FLAGS: CheapRunFlags = {
  systemPrompt: false,
  noSessionPersistence: false,
  strictMcpConfig: false,
  disableSlashCommands: false,
};

/** Starting defaults from docs/explain-speed.md §3, to be confirmed by the operator's A/B run. */
export const DEFAULT_TASK_CONFIG: Record<ExplainTask, TaskModelConfig> = {
  context: { model: 'sonnet', effort: 'low' },
  summary: { model: 'sonnet', effort: 'low' },
  area: { model: 'sonnet', effort: 'low' },
  walkthrough: { model: 'sonnet', effort: 'medium' },
  memory: { model: 'sonnet', effort: 'low' },
};

export interface ClaudeCodeOptions {
  /** Executable name or path. */
  bin?: string;
  timeoutMs?: number;
  /** Legacy default model for the un-split commit-history calls (`explain`, `explainRange`, `rollup`, `briefing`, `digest`). */
  model?: string;
  /** Per-task model/effort for the split parts (`context`, `summary`, `area`, `walkthrough`). */
  tasks?: Partial<Record<ExplainTask, Partial<TaskModelConfig>>>;
  cheapRun?: Partial<CheapRunFlags>;
  /** Spawn `cwd` for the split parts, so no `CLAUDE.md` or project settings are discovered. */
  cwd?: string;
  /** Injectable for tests. */
  spawnFn?: SpawnFn;
}

/** `<dataHome>/explain-cwd`, created if missing: an empty directory to spawn the CLI in. */
export function explainCwd(dataHome: string): string {
  const dir = join(dataHome, 'explain-cwd');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stripFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return (m?.[1] ?? s).trim();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Shape check only; length limits and anchors are the pipeline validator's job. */
function parseJson(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(stripFence(text));
  } catch {
    throw new Error('claude output is not valid JSON');
  }
  if (!isObj(v)) throw new Error('claude output is not an object');
  return v;
}

export function parseLevels(text: string): AllLevels {
  const v = parseJson(text);
  const { l0, l1, l2, l3 } = v;
  if (!isObj(l0) || typeof l0.text !== 'string') throw new Error('invalid l0');
  if (!isObj(l1) || typeof l1.userVisible !== 'boolean' || !Array.isArray(l1.bullets)) {
    throw new Error('invalid l1');
  }
  if (!isObj(l2) || !Array.isArray(l2.items) || !Array.isArray(l2.notAnalysed)) {
    throw new Error('invalid l2');
  }
  if (!isObj(l3) || !Array.isArray(l3.annotations)) throw new Error('invalid l3');
  return v as unknown as AllLevels;
}

function parseSummaryLevels(text: string): DigestSummaryLevels {
  const v = parseJson(text);
  const { l0, l1 } = v;
  if (!isObj(l0) || typeof l0.text !== 'string') throw new Error('invalid l0');
  if (!isObj(l1) || typeof l1.userVisible !== 'boolean' || !Array.isArray(l1.bullets)) throw new Error('invalid l1');
  return v as unknown as DigestSummaryLevels;
}

function parseAreaTextContent(text: string): DigestAreaTextContent {
  const v = parseJson(text);
  if (typeof v.title !== 'string' || typeof v.effect !== 'string' || typeof v.how !== 'string' || typeof v.why !== 'string') {
    throw new Error('invalid area text');
  }
  return v as unknown as DigestAreaTextContent;
}

function isMemoryAreaSummaryShape(v: unknown): v is MemoryAreaSummaryOut {
  return isObj(v) && typeof v.path === 'string' && typeof v.summary === 'string' && Array.isArray(v.terms);
}

function parseAreaSummaries(text: string): MemoryAreaSummaryOut[] {
  const v = parseJson(text);
  if (!Array.isArray(v.areas) || !v.areas.every(isMemoryAreaSummaryShape)) throw new Error('invalid area summaries');
  return v.areas as MemoryAreaSummaryOut[];
}

function parseThreadSummary(text: string): string {
  const v = parseJson(text);
  if (typeof v.summary !== 'string') throw new Error('invalid thread summary');
  return v.summary;
}

// ---- stream-json (docs/explain-speed.md §1) ----

interface StreamInitEvent { type: 'system'; subtype: 'init' }
interface StreamDeltaEvent {
  type: 'stream_event';
  event: { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } };
}
interface StreamResultEvent {
  type: 'result';
  subtype: string;
  is_error: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
type StreamEvent = StreamInitEvent | StreamDeltaEvent | StreamResultEvent | { type: string };

function isInitEvent(e: { type: string }): e is StreamInitEvent {
  return e.type === 'system' && (e as { subtype?: string }).subtype === 'init';
}

function isDeltaEvent(e: { type: string }): e is StreamDeltaEvent {
  if (e.type !== 'stream_event') return false;
  const ev = (e as StreamDeltaEvent).event;
  return isObj(ev) && ev.type === 'content_block_delta' && isObj(ev.delta) && ev.delta.type === 'text_delta' &&
    typeof ev.delta.text === 'string';
}

function isResultEvent(e: { type: string }): e is StreamResultEvent {
  return e.type === 'result';
}

export interface StreamOutcome {
  text: string;
  timing: CallTiming;
}

/** `steps` and `overview` are appended-only, never reordered (docs/explain-speed.md §5). */
function extractOverview(text: string): string | null {
  const m = /"overview"\s*:\s*"/.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let escaped = false;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) {
      escaped = false;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === '"') {
      try {
        return JSON.parse(`"${text.slice(start, i)}"`) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Complete top-level objects of the array named `key`, after the first `already` of them, from
 * partial JSON text. Tracks string/escape state so braces quoted inside string values do not
 * confuse the brace count.
 */
function extractArrayObjects(text: string, key: string, already: number): unknown[] {
  const marker = `"${key}"`;
  const at = text.indexOf(marker);
  if (at === -1) return [];
  const open = text.indexOf('[', at + marker.length);
  if (open === -1) return [];
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    } else if (c === ']' && depth === 0) {
      break;
    }
  }
  const out: unknown[] = [];
  for (const s of objs.slice(already)) {
    try {
      out.push(JSON.parse(s));
    } catch {
      // Not a complete, valid object yet; next delta will retry from this same index.
    }
  }
  return out;
}

function isStepShape(v: unknown): v is { title: string; body: string; ranges: unknown[]; callouts: unknown[]; mechanical: boolean } {
  return isObj(v) && typeof v.title === 'string' && typeof v.body === 'string' &&
    Array.isArray(v.ranges) && Array.isArray(v.callouts) && typeof v.mechanical === 'boolean';
}

/** `claude -p --output-format json` with all tools disabled. Sends code to Anthropic (Board decision D2). */
export class ClaudeCodeProvider implements ExplanationProvider {
  readonly id = 'claude-code';
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly tasks: Record<ExplainTask, TaskModelConfig>;
  private readonly cheapRun: CheapRunFlags;
  private readonly cwd?: string;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.model = opts.model ?? 'default';
    this.cwd = opts.cwd;
    this.spawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: 'pipe', cwd: this.cwd }));
    this.cheapRun = { ...DEFAULT_CHEAP_RUN_FLAGS, ...opts.cheapRun };
    this.tasks = {
      context: { ...DEFAULT_TASK_CONFIG.context, ...opts.tasks?.context },
      summary: { ...DEFAULT_TASK_CONFIG.summary, ...opts.tasks?.summary },
      area: { ...DEFAULT_TASK_CONFIG.area, ...opts.tasks?.area },
      walkthrough: { ...DEFAULT_TASK_CONFIG.walkthrough, ...opts.tasks?.walkthrough },
      memory: { ...DEFAULT_TASK_CONFIG.memory, ...opts.tasks?.memory },
    };
  }

  async explain(input: ExplanationInput): Promise<ProviderResult> {
    return { levels: parseLevels(await this.call(buildPrompt(input))), provider: this.id, model: this.model };
  }

  async explainRange(input: RangeInput): Promise<ProviderResult> {
    return { levels: parseLevels(await this.call(buildRangePrompt(input))), provider: this.id, model: this.model };
  }

  async rollup(input: RollupInput): Promise<RollupResult> {
    const v = parseJson(await this.call(buildRollupPrompt(input)));
    const { l0, l1 } = v;
    if (!isObj(l0) || typeof l0.text !== 'string') throw new Error('invalid l0');
    if (!isObj(l1) || typeof l1.userVisible !== 'boolean' || !Array.isArray(l1.bullets)) throw new Error('invalid l1');
    return { levels: { l0, l1 } as unknown as RollupResult['levels'], provider: this.id, model: this.model };
  }

  async briefing(input: BriefingFacts): Promise<BriefingResult> {
    const v = parseJson(await this.call(buildBriefingPrompt(input)));
    if (!Array.isArray(v.sentences)) throw new Error('invalid sentences');
    return { sentences: v.sentences as BriefingResult['sentences'], provider: this.id, model: this.model };
  }

  async digest(input: DigestInput): Promise<DigestResult> {
    const v = parseJson(await this.call(buildDigestPrompt(input)));
    const { l0, l1, l2 } = v;
    if (!isObj(l0) || typeof l0.text !== 'string') throw new Error('invalid l0');
    if (!isObj(l1) || typeof l1.userVisible !== 'boolean' || !Array.isArray(l1.bullets)) throw new Error('invalid l1');
    if (!isObj(l2) || !Array.isArray(l2.items) || !Array.isArray(l2.notAnalysed)) throw new Error('invalid l2');
    return { levels: { l0, l1, l2 } as unknown as DigestResult['levels'], provider: this.id, model: this.model };
  }

  async explainContext(input: ContextInput): Promise<ContextResult> {
    const r = await this.runTask('context', CONTEXT_INSTRUCTIONS, buildContextPrompt(input));
    const v = parseJson(r.text);
    if (typeof v.purpose !== 'string' || !Array.isArray(v.modules) || !Array.isArray(v.glossary) || !Array.isArray(v.conventions)) {
      throw new Error('invalid project context');
    }
    return { content: v as unknown as ContextResult['content'], provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  async explainDigestSummary(input: DigestSummaryInput): Promise<DigestSummaryResult> {
    const r = await this.runTask('summary', DIGEST_SUMMARY_INSTRUCTIONS, buildDigestSummaryPrompt(input));
    return { levels: parseSummaryLevels(r.text), provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  async explainDigestAreaText(input: DigestAreaTextInput): Promise<DigestAreaTextResult> {
    const r = await this.runTask('area', DIGEST_AREA_TEXT_INSTRUCTIONS, buildDigestAreaTextPrompt(input));
    return { content: parseAreaTextContent(r.text), provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  async explainArea(input: AreaInput, onProgress?: (chunk: AreaStreamChunk) => void): Promise<AreaResult> {
    const steps: unknown[] = [];
    let overview: string | null = null;
    const onDelta = onProgress
      ? (acc: string): void => {
          const nextOverview = extractOverview(acc);
          if (nextOverview !== null) overview = nextOverview;
          const found = extractArrayObjects(acc, 'steps', steps.length).filter(isStepShape);
          if (found.length > 0 || (overview !== null && steps.length === 0)) {
            steps.push(...found);
            // A fresh array per event: `steps` keeps mutating, but each emitted chunk must be a stable snapshot.
            onProgress({ overview, steps: [...steps] as AreaStreamChunk['steps'], done: false });
          }
        }
      : undefined;
    const r = await this.runTask('walkthrough', AREA_INSTRUCTIONS, buildAreaPrompt(input), onDelta);
    if (onProgress) onProgress({ overview, steps: [...steps] as AreaStreamChunk['steps'], done: true });
    const v = parseJson(r.text);
    if (typeof v.overview !== 'string' || !Array.isArray(v.steps) || !Array.isArray(v.check)) {
      throw new Error('invalid area walkthrough');
    }
    return { content: v as unknown as AreaResult['content'], provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  async summarizeAreas(input: MemorySummarizeAreasInput): Promise<MemorySummarizeAreasResult> {
    const r = await this.runTask('memory', AREA_SUMMARY_INSTRUCTIONS, buildAreaSummaryPrompt(input));
    return { areas: parseAreaSummaries(r.text), provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  async summarizeThread(input: MemorySummarizeThreadInput): Promise<MemorySummarizeThreadResult> {
    const r = await this.runTask('memory', THREAD_SUMMARY_INSTRUCTIONS, buildThreadSummaryPrompt(input));
    return { summary: parseThreadSummary(r.text), provider: this.id, model: r.model, effort: r.effort, timing: r.timing };
  }

  /** Runs one prompt over `stream-json` for a Fast Explain task, timed per docs/explain-speed.md §1. */
  private async runTask(
    task: ExplainTask, instructions: string, fullPrompt: string, onDelta?: (accumulated: string) => void,
  ): Promise<{ text: string; timing: CallTiming; model: string; effort: Effort }> {
    const cfg = this.tasks[task];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', ''];
    if (cfg.model !== 'default') args.push('--model', cfg.model);
    args.push('--effort', cfg.effort);
    // Every Fast Explain prompt builder already starts with its instructions.
    let stdin = fullPrompt;
    if (this.cheapRun.systemPrompt && fullPrompt.startsWith(instructions)) {
      args.push('--system-prompt', instructions);
      stdin = fullPrompt.slice(instructions.length).replace(/^\n+/, '');
    }
    if (this.cheapRun.noSessionPersistence) args.push('--no-session-persistence');
    if (this.cheapRun.strictMcpConfig) args.push('--strict-mcp-config');
    if (this.cheapRun.disableSlashCommands) args.push('--disable-slash-commands');
    const { text, timing } = await this.runStreamJson(args, stdin, onDelta);
    return { text, timing, model: cfg.model, effort: cfg.effort };
  }

  /** Runs `claude` over `--output-format stream-json --include-partial-messages` and times the call. */
  private runStreamJson(args: string[], stdin: string, onDelta?: (accumulated: string) => void): Promise<StreamOutcome> {
    return new Promise((resolve, reject) => {
      const spawnAt = Date.now();
      const child = this.spawnFn(this.bin, args);
      let buf = '';
      let err = '';
      let settled = false;
      let initAt: number | null = null;
      let firstTextAt: number | null = null;
      let text = '';

      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(() => reject(new Error(`claude timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      const handleEvent = (e: StreamEvent): void => {
        if (isInitEvent(e)) {
          initAt ??= Date.now();
          return;
        }
        if (isDeltaEvent(e)) {
          if (firstTextAt === null) firstTextAt = Date.now();
          text += e.event.delta.text;
          onDelta?.(text);
          return;
        }
        if (isResultEvent(e)) {
          const resultAt = Date.now();
          const startupAt = initAt ?? firstTextAt ?? resultAt;
          const genFrom = firstTextAt ?? initAt ?? spawnAt;
          const timing: CallTiming = {
            startupMs: startupAt - spawnAt,
            ttftMs: firstTextAt !== null ? firstTextAt - startupAt : 0,
            genMs: resultAt - genFrom,
            inputTokens: e.usage?.input_tokens ?? null,
            outputTokens: e.usage?.output_tokens ?? null,
          };
          if (e.is_error || typeof e.result !== 'string') {
            done(() => reject(new Error(`claude returned an error result (${e.subtype})`)));
            return;
          }
          done(() => resolve({ text: e.result!, timing }));
        }
      };

      child.stdout.on('data', (d: Buffer | string) => {
        buf += d.toString();
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line !== '') {
            try {
              handleEvent(JSON.parse(line) as StreamEvent);
            } catch {
              // Not a JSON line (stray CLI diagnostic output); ignore it.
            }
          }
          nl = buf.indexOf('\n');
        }
      });
      child.stderr.on('data', (d: Buffer | string) => (err += d.toString()));
      child.on('error', (e) => done(() => reject(e)));
      child.on('close', (code) =>
        done(() => {
          if (code !== 0) reject(new Error(`claude exited with code ${code}: ${err.slice(0, 200)}`));
          else reject(new Error('claude stream ended without a result event'));
        }),
      );
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
  }

  /** Runs one prompt and returns the model's text result (legacy `-p --output-format json` path). */
  private async call(prompt: string): Promise<string> {
    const args = ['-p', '--output-format', 'json', '--tools', ''];
    if (this.model !== 'default') args.push('--model', this.model);
    const stdout = await this.run(args, prompt);
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error('claude output envelope is not valid JSON');
    }
    if (!isObj(envelope) || envelope.is_error === true || typeof envelope.result !== 'string') {
      throw new Error('claude returned an error result');
    }
    return envelope.result;
  }

  private run(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.bin, args);
      let out = '';
      let err = '';
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(() => reject(new Error(`claude timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);
      child.stdout.on('data', (d: Buffer | string) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer | string) => (err += d.toString()));
      child.on('error', (e) => done(() => reject(e)));
      child.on('close', (code) =>
        done(() =>
          code === 0
            ? resolve(out)
            : reject(new Error(`claude exited with code ${code}: ${err.slice(0, 200)}`)),
        ),
      );
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
  }
}
