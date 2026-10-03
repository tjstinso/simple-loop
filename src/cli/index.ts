import { parseArgs } from 'node:util';
import { discardDeadLetter, listDeadLetters } from '../kernel/dlq.js';
import type { Kernel } from '../kernel/kernel.js';
import type { ChainView } from '../kernel/types.js';
import { routeEngine } from '../router/router.js';
import { loadConfig } from './config.js';
import { buildRuntime, type Runtime } from './runtime.js';

export interface CliDeps {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runtime?: Runtime;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

const USAGE = `Usage:
  factory [--config <path>] submit <issue-url> [--label <l>]... [--engine <id>]
  factory [--config <path>] worker [--poll-ms <n>] [--id <name>]
  factory [--config <path>] status
  factory [--config <path>] dlq list
  factory [--config <path>] dlq retry <job-id>
  factory [--config <path>] dlq discard <job-id>
Options:
  --config <path>   config file (default ./factory.config.json)
  -h, --help        print this help`;

class UsageError extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function parseJobId(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new UsageError('invalid job id');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new UsageError('invalid job id');
  return id;
}

function statusLines(kernel: Kernel, db: Runtime['db']): string[] {
  const rows = db
    .prepare(`SELECT id FROM chains WHERE status NOT IN ('completed', 'cancelled') ORDER BY id`)
    .all() as Array<{ id: number }>;
  const lines: string[] = [];
  for (const { id } of rows) {
    const chain = db.prepare('SELECT * FROM chains WHERE id = ?').get(id) as {
      id: number;
      engine: string;
      status: ChainView<unknown>['status'];
      subject_key: string;
      engine_state: string;
    };
    const head = `${chain.id} ${chain.engine} ${chain.status}`;
    try {
      const engine = kernel.deps.engines.get(chain.engine);
      const parsed = engine.stateSchema.parse(JSON.parse(chain.engine_state));
      const view: ChainView<unknown> = {
        id: chain.id,
        engine: chain.engine,
        subjectKey: chain.subject_key,
        status: chain.status,
        state: parsed,
      };
      lines.push(`${head} ${engine.describe(view)}`);
    } catch {
      lines.push(head);
    }
  }
  return lines;
}

async function execute(argv: string[], rt: Runtime, deps: Required<Pick<CliDeps, 'stdout' | 'stderr' | 'onSignal'>>): Promise<number> {
  const { stdout, stderr } = deps;
  const [cmd, ...rest] = argv;
  const { kernel } = rt;
  const clock = kernel.deps.clock;

  switch (cmd) {
    case 'submit': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { label: { type: 'string', multiple: true }, engine: { type: 'string' } },
      });
      if (positionals.length !== 1) throw new UsageError('submit takes exactly one issue url');
      const labels = [...(values.label ?? [])];
      if (values.engine !== undefined) labels.push(`factory:engine:${values.engine}`);
      try {
        const engine = routeEngine(labels, rt.defaultEngine, kernel.deps.engines.ids());
        const { chain, job } = await kernel.enqueue(engine, { issueUrl: positionals[0]! });
        stdout(`chain ${chain.id} job ${job.id} engine ${engine}`);
        return 0;
      } catch (e) {
        stderr(`error: ${message(e)}`);
        return 1;
      }
    }
    case 'worker': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'poll-ms': { type: 'string' }, id: { type: 'string' } },
      });
      if (positionals.length > 0) throw new UsageError('worker takes no arguments');
      let pollMs: number | undefined;
      if (values['poll-ms'] !== undefined) {
        if (!/^[0-9]+$/.test(values['poll-ms'])) throw new UsageError('--poll-ms must be a non-negative integer');
        pollMs = Number(values['poll-ms']);
      }
      const worker = kernel.startWorker({
        ...(pollMs === undefined ? {} : { pollMs }),
        ...(values.id === undefined ? {} : { id: values.id }),
        onError: (err) => stderr(`error: ${message(err)}`),
      });
      const stop = () => {
        void worker.stop();
      };
      deps.onSignal('SIGINT', stop);
      deps.onSignal('SIGTERM', stop);
      stdout(`worker ${worker.id} started`);
      await worker.done;
      stdout(`worker ${worker.id} stopped`);
      return 0;
    }
    case 'status': {
      if (rest.length > 0) throw new UsageError('status takes no arguments');
      const lines = statusLines(kernel, rt.db);
      if (lines.length === 0) stdout('no open chains');
      for (const l of lines) stdout(l);
      return 0;
    }
    case 'dlq': {
      const [sub, ...args] = rest;
      if (sub === 'list') {
        if (args.length > 0) throw new UsageError('dlq list takes no arguments');
        const dls = listDeadLetters(rt.db, { unresolved: true });
        if (dls.length === 0) stdout('no dead letters');
        for (const d of dls) {
          const first = (d.error.split('\n')[0] ?? '').slice(0, 120);
          stdout(`job ${d.jobId} chain ${d.chainId} ${d.reason} ${first}`);
        }
        return 0;
      }
      if (sub === 'retry' || sub === 'discard') {
        if (args.length !== 1) throw new UsageError(`dlq ${sub} takes exactly one job id`);
        const id = parseJobId(args[0]);
        try {
          if (sub === 'retry') {
            await kernel.retryDeadLetter(id);
            stdout(`requeued job ${id}`);
          } else {
            discardDeadLetter(rt.db, id, clock());
            stdout(`discarded job ${id}`);
          }
          return 0;
        } catch (e) {
          stderr(`error: ${message(e)}`);
          return 1;
        }
      }
      throw new UsageError('dlq needs a subcommand: list, retry or discard');
    }
    default:
      throw new UsageError(cmd === undefined ? 'missing command' : `unknown command: ${cmd}`);
  }
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((l: string) => console.log(l));
  const stderr = deps.stderr ?? ((l: string) => console.error(l));
  const onSignal = deps.onSignal ?? ((s, h) => void process.on(s, h));
  const usageError = (msg: string): number => {
    stderr(`error: ${msg}`);
    stderr(USAGE);
    return 2;
  };

  let config: string | undefined;
  let command: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (parsed.values.help === true) {
      stdout(USAGE);
      return 0;
    }
    if (typeof parsed.values.config === 'string') config = parsed.values.config;
    else if (parsed.values.config !== undefined) return usageError('--config needs a path');
    // Re-parse without the global options; they may appear anywhere.
    command = stripGlobals(argv);
  } catch (e) {
    return usageError(message(e));
  }

  let runtime = deps.runtime;
  const built = runtime === undefined;
  try {
    if (command[0] === undefined) return usageError('missing command');
    if (!['submit', 'worker', 'status', 'dlq'].includes(command[0])) {
      return usageError(`unknown command: ${command[0]}`);
    }
    if (runtime === undefined) runtime = buildRuntime(loadConfig(config, cwd));
    return await execute(command, runtime, { stdout, stderr, onSignal });
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS'))) {
      return usageError(message(e));
    }
    stderr(`error: ${message(e)}`);
    return 1;
  } finally {
    if (built && runtime !== undefined) runtime.close();
  }
}

/** Removes `--config <path>`, `--config=<path>`, `-h` and `--help` from argv. */
function stripGlobals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config') i++;
    else if (a.startsWith('--config=') || a === '-h' || a === '--help') continue;
    else out.push(a);
  }
  return out;
}
