import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AllLevels,
  BriefingFacts,
  BriefingResult,
  ContextInput,
  ContextResult,
  DigestInput,
  DigestResult,
  ExplanationInput,
  ExplanationProvider,
  ProviderResult,
  RangeInput,
  RollupInput,
  RollupResult,
} from './provider.js';
import { buildPrompt } from './prompt.js';
import { buildRangePrompt, buildRollupPrompt } from './range.js';
import { buildBriefingPrompt } from './briefing.js';
import { buildContextPrompt } from './context.js';
import { buildDigestPrompt } from './digest.js';

export type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeOptions {
  /** Executable name or path. */
  bin?: string;
  timeoutMs?: number;
  model?: string;
  /** Injectable for tests. */
  spawnFn?: SpawnFn;
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

/** `claude -p --output-format json` with all tools disabled. Sends code to Anthropic (Board decision D2). */
export class ClaudeCodeProvider implements ExplanationProvider {
  readonly id = 'claude-code';
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.model = opts.model ?? 'default';
    this.spawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: 'pipe' }));
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

  async explainContext(input: ContextInput): Promise<ContextResult> {
    const v = parseJson(await this.call(buildContextPrompt(input)));
    if (typeof v.purpose !== 'string' || !Array.isArray(v.modules) || !Array.isArray(v.glossary) || !Array.isArray(v.conventions)) {
      throw new Error('invalid project context');
    }
    return { content: v as unknown as ContextResult['content'], provider: this.id, model: this.model };
  }

  async digest(input: DigestInput): Promise<DigestResult> {
    const v = parseJson(await this.call(buildDigestPrompt(input)));
    const { l0, l1, l2 } = v;
    if (!isObj(l0) || typeof l0.text !== 'string') throw new Error('invalid l0');
    if (!isObj(l1) || typeof l1.userVisible !== 'boolean' || !Array.isArray(l1.bullets)) throw new Error('invalid l1');
    if (!isObj(l2) || !Array.isArray(l2.items) || !Array.isArray(l2.notAnalysed)) throw new Error('invalid l2');
    return { levels: { l0, l1, l2 } as unknown as DigestResult['levels'], provider: this.id, model: this.model };
  }

  /** Runs one prompt and returns the model's text result. */
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
