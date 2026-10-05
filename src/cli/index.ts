import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopback, startDashboard } from '../dashboard/server.js';
import { openReadOnlyDb } from '../kernel/db.js';
import { listDeadLetters } from '../kernel/dlq.js';
import { recentEvents, type EventRow } from '../kernel/events.js';
import {
  chainJobViews,
  chainTimeline,
  formatAge,
  formatLastCheck,
  jobStateLabel,
  formatCost,
  listWorkerViews,
  parseDuration,
} from '../kernel/inspect.js';
import type { Kernel } from '../kernel/kernel.js';
import { isDraining, startDrain, stopDrain } from '../kernel/control.js';
import { countRunning } from '../kernel/queue.js';
import type { ChainView } from '../kernel/types.js';
import { describePolicy } from '../policy/resolve.js';
import { routeEngine } from '../router/router.js';
import { loadConfig } from './config.js';
import { buildRuntime, type Runtime } from './runtime.js';

export interface CliDeps {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runtime?: Runtime;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  /** Waits between polls of `drain --wait` (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = `Usage:
  factory [--config <path>] submit <issue-url> [--label <l>]... [--engine <id>]
  factory [--config <path>] worker [--poll-ms <n>] [--id <name>]
  factory [--config <path>] status [--json]
  factory [--config <path>] drain [--wait [--timeout <seconds>]]
  factory [--config <path>] resume
  factory [--config <path>] show <chain-id> [--json]
  factory [--config <path>] events [--since <duration>] [--chain <id>] [--limit <n>] [--json]
  factory [--config <path>] workers [--json]
  factory [--config <path>] dlq list
  factory [--config <path>] dlq retry <job-id>
  factory [--config <path>] dlq discard <job-id>
  factory [--config <path>] cancel <chain-id>
  factory [--config <path>] policies
  factory [--config <path>] dashboard [--port <n>] [--host <addr>]
Options:
  --config <path>   config file (default ./factory.config.json)
  -h, --help        print this help`;

class UsageError extends Error {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function parseId(raw: string | undefined, what: 'job' | 'chain'): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new UsageError(`invalid ${what} id`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new UsageError(`invalid ${what} id`);
  return id;
}

interface StatusChain {
  id: number;
  engine: string;
  status: string;
  /** The engine's one-line description (absent when the state does not validate). */
  description: string | null;
  /** The maintenance pass's last look at a waiting chain (null before the first one). */
  lastCheckedAt: number | null;
  lastCheckResult: string | null;
  jobs: ReturnType<typeof chainJobViews>;
}

function statusChains(kernel: Kernel, db: Runtime['db']): StatusChain[] {
  const rows = db
    .prepare(`SELECT id FROM chains WHERE status NOT IN ('completed', 'cancelled') ORDER BY id`)
    .all() as Array<{ id: number }>;
  const now = kernel.deps.clock();
  const chains: StatusChain[] = [];
  for (const { id } of rows) {
    const chain = db.prepare('SELECT * FROM chains WHERE id = ?').get(id) as {
      id: number;
      engine: string;
      status: ChainView<unknown>['status'];
      subject_key: string;
      engine_state: string;
      last_checked_at: number | null;
      last_check_result: string | null;
    };
    let description: string | null = null;
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
      description = engine.describe(view);
    } catch {
      // An unknown engine or invalid state: the chain is still listed.
    }
    chains.push({
      id: chain.id,
      engine: chain.engine,
      status: chain.status,
      description,
      lastCheckedAt: chain.last_checked_at,
      lastCheckResult: chain.last_check_result,
      jobs: chainJobViews(db, id, now),
    });
  }
  return chains;
}

function statusLines(chains: StatusChain[], now: number): string[] {
  const lines: string[] = [];
  for (const c of chains) {
    const checked = c.status === 'waiting' ? ` ${formatLastCheck(c.lastCheckedAt, c.lastCheckResult, now)}` : '';
    lines.push(`${c.id} ${c.engine} ${c.status}${c.description === null ? '' : ` ${c.description}`}${checked}`);
    for (const j of c.jobs) {
      const parts = [`job ${j.id}`, j.type, `attempt=${j.attempt}`, jobStateLabel(j, now), `delivery=${j.delivery}`];
      if (j.workerId !== null) parts.push(`worker=${j.workerId}`);
      if (j.sinceLastEventMs !== null) parts.push(`last-event=${formatAge(j.sinceLastEventMs)} ago`);
      if (j.leaseExpiresAt !== null) parts.push(`lease-expires=${new Date(j.leaseExpiresAt).toISOString()}`);
      lines.push(`  ${parts.join(' ')}`);
    }
  }
  return lines;
}

function eventLine(e: EventRow, withChain: boolean): string {
  const detail = Object.keys(e.detail).length === 0 ? '' : ` ${JSON.stringify(e.detail)}`;
  const where = [withChain ? `chain=${e.chainId}` : '', e.jobId === null ? '' : `job=${e.jobId}`, e.delivery === null ? '' : `delivery=${e.delivery}`]
    .filter(Boolean)
    .join(' ');
  return `${new Date(e.at).toISOString()} ${e.kind}${where ? ` ${where}` : ''}${detail}`;
}

function parseCount(raw: string, what: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) throw new UsageError(`${what} must be a positive integer`);
  return Number(raw);
}

async function execute(
  argv: string[],
  rt: Runtime,
  deps: Required<Pick<CliDeps, 'stdout' | 'stderr' | 'onSignal'>> & Pick<CliDeps, 'sleep'>,
): Promise<number> {
  const { stdout, stderr } = deps;
  const [cmd, ...rest] = argv;
  const { kernel } = rt;

  switch (cmd) {
    case 'submit': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { label: { type: 'string', multiple: true }, engine: { type: 'string' } },
      });
      if (positionals.length !== 1) throw new UsageError('submit takes exactly one issue url');
      rt.requireGithub?.();
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
      rt.requireGithub?.();
      await rt.verifyIdentity?.();
      const worker = kernel.startWorker({
        ...(pollMs === undefined ? {} : { pollMs }),
        ...(rt.maintenanceMs === undefined ? {} : { maintenanceMs: rt.maintenanceMs }),
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
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (positionals.length > 0) throw new UsageError('status takes no arguments');
      const chains = statusChains(kernel, rt.db);
      if (values.json) {
        stdout(JSON.stringify(chains));
        return 0;
      }
      const max = kernel.deps.config.maxConcurrentJobs;
      const running = countRunning(rt.db);
      const lines = statusLines(chains, kernel.deps.clock());
      if (lines.length === 0) stdout('no open chains');
      for (const l of lines) stdout(l);
      stdout(`slots: ${running}${max === undefined ? ' (no limit)' : ` of ${max}`}`);
      if (isDraining(rt.db)) stdout(`DRAINING (${running} job(s) still running)`);
      return 0;
    }
    case 'drain': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { wait: { type: 'boolean' }, timeout: { type: 'string' } },
      });
      if (positionals.length > 0) throw new UsageError('drain takes no arguments');
      if (values.timeout !== undefined && !values.wait) throw new UsageError('--timeout needs --wait');
      let timeoutMs: number | undefined;
      if (values.timeout !== undefined) timeoutMs = parseCount(values.timeout, '--timeout') * 1000;
      startDrain(rt.db, kernel.deps.clock());
      if (!values.wait) {
        stdout(`draining: ${countRunning(rt.db)} job(s) running`);
        return 0;
      }
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = timeoutMs === undefined ? undefined : kernel.deps.clock() + timeoutMs;
      for (;;) {
        const n = countRunning(rt.db);
        if (n === 0) {
          stdout('drained');
          return 0;
        }
        if (deadline !== undefined && kernel.deps.clock() >= deadline) {
          stderr(`still draining: ${n} job(s) running`);
          return 1;
        }
        await sleep(2000);
      }
    }
    case 'resume': {
      if (rest.length > 0) throw new UsageError('resume takes no arguments');
      stopDrain(rt.db, kernel.deps.clock());
      stdout('resumed');
      return 0;
    }
    case 'show': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (positionals.length !== 1) throw new UsageError('show takes exactly one chain id');
      const id = parseId(positionals[0], 'chain');
      const t = chainTimeline(rt.db, id);
      if (!t) {
        stderr(`error: chain ${id} not found`);
        return 1;
      }
      if (values.json) {
        stdout(JSON.stringify(t));
        return 0;
      }
      stdout(`chain ${t.chain.id} ${t.chain.engine} ${t.chain.status} ${t.chain.subjectKey}`);
      if (t.chain.status === 'waiting') {
        stdout(formatLastCheck(t.chain.lastCheckedAt, t.chain.lastCheckResult, kernel.deps.clock()));
      }
      for (const e of t.events) stdout(eventLine(e, false));
      for (const j of t.cost.jobs) {
        stdout(`cost job ${j.jobId} ${j.type} attempt=${j.attempt} ${j.costUsd === null ? 'unknown' : formatCost(j.costUsd)}`);
      }
      stdout(`cost total ${formatCost(t.cost.totalUsd)}`);
      return 0;
    }
    case 'events': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { since: { type: 'string' }, chain: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
      });
      if (positionals.length > 0) throw new UsageError('events takes no arguments');
      const filter: { since?: number; chainId?: number; limit?: number } = {};
      if (values.since !== undefined) {
        const ms = parseDuration(values.since);
        if (ms === null) throw new UsageError('--since must look like 30s, 15m, 2h or 7d');
        filter.since = kernel.deps.clock() - ms;
      }
      if (values.chain !== undefined) filter.chainId = parseId(values.chain, 'chain');
      if (values.limit !== undefined) filter.limit = parseCount(values.limit, '--limit');
      const events = recentEvents(rt.db, filter);
      if (values.json) {
        stdout(JSON.stringify(events));
        return 0;
      }
      if (events.length === 0) stdout('no events');
      for (const e of events) stdout(eventLine(e, true));
      return 0;
    }
    case 'workers': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (positionals.length > 0) throw new UsageError('workers takes no arguments');
      const workers = listWorkerViews(rt.db, kernel.deps.clock());
      if (values.json) {
        stdout(JSON.stringify(workers));
        return 0;
      }
      if (workers.length === 0) stdout('no workers');
      for (const w of workers) {
        const alive = w.alive ? 'alive' : 'dead';
        const job = w.currentJobId === null ? 'idle' : `job=${w.currentJobId} delivery=${w.currentDelivery}`;
        stdout(`${w.id} pid=${w.pid} host=${w.host} ${alive} ${job} heartbeat=${formatAge(w.heartbeatAgeMs)} ago`);
      }
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
        const id = parseId(args[0], 'job');
        try {
          if (sub === 'retry') {
            await kernel.retryDeadLetter(id);
            stdout(`requeued job ${id}`);
          } else {
            await kernel.discardDeadLetter(id);
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
    case 'policies': {
      if (rest.length > 0) throw new UsageError('policies takes no arguments');
      const all = rt.effectivePolicies ?? [];
      if (all.length === 0) stdout('no policies');
      for (const e of all) for (const l of describePolicy(e)) stdout(l);
      return 0;
    }
    case 'cancel': {
      if (rest.length !== 1) throw new UsageError('cancel takes exactly one chain id');
      const id = parseId(rest[0], 'chain');
      try {
        await kernel.cancelChain(id);
        stdout(`cancelled chain ${id}`);
        return 0;
      } catch (e) {
        stderr(`error: ${message(e)}`);
        return 1;
      }
    }
    default:
      throw new UsageError(cmd === undefined ? 'missing command' : `unknown command: ${cmd}`);
  }
}

/** `factory dashboard`: a read-only HTTP server over the database; it never builds the runtime (no GitHub, no writes). */
async function runDashboard(
  args: string[],
  config: string | undefined,
  cwd: string,
  deps: Required<Pick<CliDeps, 'stdout' | 'stderr' | 'onSignal'>>,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string' }, host: { type: 'string' } },
  });
  if (positionals.length > 0) throw new UsageError('dashboard takes no arguments');
  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^[0-9]+$/.test(values.port) || Number(values.port) > 65535) throw new UsageError('--port must be an integer from 0 to 65535');
    port = Number(values.port);
  }
  const host = values.host ?? DEFAULT_HOST;
  if (host === '') throw new UsageError('--host needs an address');
  const cfg = loadConfig(config, cwd);
  const db = openReadOnlyDb(cfg.dbPath);
  let dash;
  try {
    dash = await startDashboard({ db, host, port, ...(cfg.maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs: cfg.maxConcurrentJobs }) });
  } catch (e) {
    db.close();
    throw e;
  }
  if (!isLoopback(host)) {
    deps.stderr(`warning: the dashboard is bound to ${host} and has no authentication; anyone who can reach it can read your factory data`);
  }
  deps.stdout(`dashboard listening on http://${host.includes(':') ? `[${host}]` : host}:${dash.port}`);
  const stopped = new Promise<void>((resolve) => {
    const stop = () => resolve();
    deps.onSignal('SIGINT', stop);
    deps.onSignal('SIGTERM', stop);
  });
  await stopped;
  await dash.close();
  db.close();
  deps.stdout('dashboard stopped');
  return 0;
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
    if (command[0] === 'dashboard') return await runDashboard(command.slice(1), config, cwd, { stdout, stderr, onSignal });
    if (!['submit', 'worker', 'status', 'drain', 'resume','show', 'events', 'workers', 'dlq', 'cancel', 'policies'].includes(command[0])) {
      return usageError(`unknown command: ${command[0]}`);
    }
    if (runtime === undefined) runtime = buildRuntime(loadConfig(config, cwd));
    if (built && command[0] !== 'worker') {
      // The worker stops gracefully on a signal; other commands remove the auth directory and exit.
      const rt = runtime;
      for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
        onSignal(sig, () => {
          rt.close();
          process.exit(code);
        });
      }
    }
    return await execute(command, runtime, { stdout, stderr, onSignal, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
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
