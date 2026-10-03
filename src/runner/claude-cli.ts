import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readProcessStartTime } from '../util/proc.js';
import { LineSplitter, StreamCollector, lastJsonBlock, parseStreamLine, truncate } from './stream.js';
import type { RunHooks, Runner, RunInput } from './types.js';

const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows above this

const configSchema = z.object({
  prompt: z.string().min(1),
  allowedTools: z.array(z.string().min(1)),
  maxBudgetUsd: z.number().positive(),
  timeoutMs: z.number().int().positive().max(MAX_TIMER_MS),
  inactivityTimeoutMs: z.number().int().positive().max(MAX_TIMER_MS),
  resultFormat: z.enum(['execution', 'json']),
  permissionMode: z.string().min(1).optional(),
});

export type ClaudeCliConfig = z.infer<typeof configSchema>;

export interface ExecutionResult {
  status: 'ok' | 'error';
  summary: string;
  costUsd?: number;
  steps: string[];
  followups?: { title: string; body: string }[];
}

export interface ClaudeCliRunnerOptions {
  /** Executable to run (default `claude`). Tests point this at a stub script. */
  bin?: string;
  /** Variables added to the child environment after GitHub credentials are stripped. */
  env?: Record<string, string>;
}

/** Rejection for the inactivity watchdog and the hard wall-clock limit. */
export class RunnerTimeoutError extends Error {
  readonly reason = 'timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunnerTimeoutError';
  }
}

const SUMMARY_MAX = 4000;
const STDERR_TAIL = 2000;

const blockSchema = z.object({
  summary: z.string().optional(),
  followups: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
});

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** The parent environment minus GitHub credentials, plus `overrides`. */
export function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith('GH_') || upper.startsWith('GITHUB_')) continue; // covers GH_TOKEN, GITHUB_TOKEN
    env[k] = v;
  }
  return { ...env, ...overrides };
}

export function buildPrompt(cfg: ClaudeCliConfig, input: RunInput): string {
  const subject = JSON.stringify(input.subject ?? null, null, 2);
  let prompt = `${cfg.prompt}\n\n## Work item\n\n\`\`\`json\n${subject}\n\`\`\``;
  if (input.feedback !== undefined && input.feedback !== '') prompt += `\n\n## Feedback\n\n${input.feedback}`;
  return prompt;
}

export function buildArgs(cfg: ClaudeCliConfig, prompt: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // `claude --help` (2.1.286) does not list this requirement, but Claude Code
    // has historically refused `-p --output-format stream-json` without
    // `--verbose`; it is harmless when not required, so always pass it.
    '--verbose',
    '--max-budget-usd',
    String(cfg.maxBudgetUsd),
    // Headless: tools in --allowedTools are pre-approved; anything else that
    // would prompt is denied immediately instead of waiting for an answer.
    '--permission-prompts',
    'none',
  ];
  // `--allowedTools` is variadic; the `=` form stops it from swallowing the
  // positional prompt. Entries may contain spaces (e.g. `Bash(git *)`).
  if (cfg.allowedTools.length > 0) args.push(`--allowedTools=${cfg.allowedTools.join(',')}`);
  if (cfg.permissionMode !== undefined) args.push('--permission-mode', cfg.permissionMode);
  // `--` keeps a prompt that starts with `-` from being read as an option.
  args.push('--', prompt);
  return args;
}

interface Outcome {
  collector: StreamCollector;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function failureReason(o: Outcome): string | null {
  const r = o.collector.result;
  let reason: string | null = null;
  if (o.signal !== null) reason = `claude was killed by signal ${o.signal}`;
  else if (r === null) {
    reason = o.code !== 0
      ? `claude exited with code ${o.code} without a result event`
      : 'claude output ended without a result event';
  } else if (!o.collector.succeeded()) {
    const subtype = typeof r.subtype === 'string' ? r.subtype : 'unknown';
    const text = o.collector.finalText();
    reason = `claude reported an error result (${subtype})${text ? `: ${text}` : ''}`;
  } else if (o.code !== 0) reason = `claude exited with code ${o.code}`;
  if (reason === null) return null;
  const stderr = o.stderr.trim();
  return truncate(stderr ? `${reason}; stderr: ${stderr}` : reason, SUMMARY_MAX);
}

function buildResult(cfg: ClaudeCliConfig, o: Outcome): unknown {
  const failure = failureReason(o);
  const text = o.collector.finalText();
  const block = lastJsonBlock(text);

  if (cfg.resultFormat === 'json') {
    if (failure !== null) return { status: 'error', summary: failure };
    return block.ok ? block.value : { status: 'error', summary: block.reason };
  }

  const parsed = block.ok ? blockSchema.safeParse(block.value) : null;
  const fromBlock = parsed?.success ? parsed.data : undefined;
  const result: ExecutionResult = {
    status: failure === null ? 'ok' : 'error',
    summary: truncate(failure ?? fromBlock?.summary ?? text ?? '', SUMMARY_MAX),
    steps: [...o.collector.steps],
  };
  const cost = o.collector.costUsd();
  if (cost !== undefined) result.costUsd = cost;
  if (fromBlock?.followups !== undefined) result.followups = fromBlock.followups;
  return result;
}

/**
 * Runs `claude -p` headless in the job's workspace, reading stream-json events.
 * The child runs detached (its own process group) so timeouts and aborts can
 * kill the whole tree.
 */
export class ClaudeCliRunner implements Runner {
  readonly name = 'claude-cli';
  readonly configSchema = configSchema;
  private readonly bin: string;
  private readonly env: Record<string, string>;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.env = opts.env ?? {};
  }

  async run(input: RunInput, signal: AbortSignal, hooks?: RunHooks): Promise<unknown> {
    if (signal.aborted) throw abortError();
    const cfg = configSchema.parse(input.config);
    const args = buildArgs(cfg, buildPrompt(cfg, input));

    return new Promise<unknown>((resolve, reject) => {
      const collector = new StreamCollector();
      const splitter = new LineSplitter();
      let stderr = '';
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let settled = false;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;

      const child = spawn(this.bin, args, {
        cwd: input.workspace.path,
        env: childEnv(this.env),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pid = child.pid;

      const killGroup = (): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* ESRCH: the group is already gone */
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        clearTimeout(hardTimer);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const fail = (err: unknown): void => {
        settle(() => reject(err));
        killGroup();
      };
      const onAbort = (): void => fail(abortError());
      const armInactivity = (): void => {
        if (settled) return;
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => fail(new RunnerTimeoutError(`no output from claude for ${cfg.inactivityTimeoutMs} ms`)),
          cfg.inactivityTimeoutMs,
        );
      };
      const handleLine = (line: string): void => {
        const ev = parseStreamLine(line);
        if (ev === null) return;
        armInactivity();
        collector.add(ev);
      };

      child.on('error', fail); // e.g. ENOENT; `close` may follow and is ignored
      child.stdout.on('data', (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      child.on('exit', (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        // Reap anything the child left behind in its group; this also closes
        // pipes a background grandchild may hold, so `close` can fire.
        killGroup();
        if (pid !== undefined && hooks?.onExit) {
          try {
            hooks.onExit(pid, code);
          } catch (err) {
            fail(err);
          }
        }
      });
      child.on('close', () => {
        const rest = splitter.end();
        if (rest !== null) handleLine(rest);
        settle(() => {
          try {
            resolve(buildResult(cfg, { collector, code: exitCode, signal: exitSignal, stderr }));
          } catch (err) {
            reject(err);
          }
        });
      });

      if (pid === undefined) return; // spawn failed; the `error` event settles

      signal.addEventListener('abort', onAbort, { once: true });
      hardTimer = setTimeout(
        () => fail(new RunnerTimeoutError(`claude exceeded the ${cfg.timeoutMs} ms time limit`)),
        cfg.timeoutMs,
      );
      armInactivity();
      try {
        // A detached child leads its own process group, so pgid === pid.
        hooks?.onSpawn?.({ pid, pgid: pid, startTime: readProcessStartTime(pid) ?? 0 });
      } catch (err) {
        fail(err);
      }
    });
  }
}
