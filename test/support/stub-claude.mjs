#!/usr/bin/env node
// Stand-in for the `claude` CLI used by test/runner/claude-cli.test.ts.
// It never talks to a model. Behaviour is selected by STUB_MODE:
//
//   echo       emit an init event, then a success result whose text ends with a
//              ```json block holding { argv, env, cwd } of this process
//   steps      emit STUB_STEPS (default 3) tool_use assistant events, then a
//              success result (total_cost_usd 0.42, text from STUB_RESULT_TEXT);
//              the result line is written in two chunks to exercise buffering
//   silent     spawn a grandchild, emit one event, then sleep silently forever
//   forever    spawn a grandchild, emit an event every 20 ms forever
//   truncated  emit one assistant event, then a truncated result line, exit 0
//   noise      print non-JSON lines only, exit 0
//   no-result  emit assistant events but no result event, exit 0
//   exit-nonzero  write to stderr and exit 3 with no result event
//   scripted   append { argv } as a line to STUB_ARGV_FILE, then answer with the entry of the JSON
//              array STUB_RESULTS whose index is the number of lines already in that file; when
//              STUB_WRITE_FILE is set and the answer is an execute result, also write that file
//   orphan     spawn a grandchild that holds stdout open, emit a result, exit 0
//
// When STUB_PID_FILE is set, the stub writes {"pid":..,"grandchild":..,"home":..} to it
// (after spawning the grandchild, if any) so tests can verify process death and
// the removal of the per-run HOME. With STUB_LIST_HOME set, echo mode also reports
// the entries of HOME and of each XDG_*_HOME directory as `homeEntries`.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const mode = process.env.STUB_MODE ?? 'echo';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnGrandchild(stdout = 'ignore') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', stdout, 'ignore'],
  });
  gc.unref(); // do not keep the stub alive (matters for the orphan mode)
  return gc.pid;
}

function writePids(grandchild) {
  if (process.env.STUB_PID_FILE) {
    writeFileSync(process.env.STUB_PID_FILE, JSON.stringify({ pid: process.pid, grandchild, home: process.env.HOME ?? null }));
  }
}

function assistantToolUse(i) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo step ${i}` } }] },
  };
}

function result(text, extra = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.42, ...extra };
}

switch (mode) {
  case 'echo': {
    writePids(null);
    out({ type: 'system', subtype: 'init' });
    const payload = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() };
    if (process.env.STUB_LIST_GH_CONFIG) {
      try {
        payload.ghConfigEntries = readdirSync(process.env.GH_CONFIG_DIR ?? '');
      } catch {
        payload.ghConfigEntries = null;
      }
    }
    if (process.env.STUB_LIST_HOME) {
      payload.homeEntries = {};
      for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        try {
          payload.homeEntries[k] = readdirSync(process.env[k] ?? '');
        } catch {
          payload.homeEntries[k] = null;
        }
      }
    }
    // Escape backticks so the prompt's own ``` fences cannot end the block early.
    const json = JSON.stringify(payload).replace(/`/g, '\\u0060');
    const text = 'echo done\n```json\n' + json + '\n```';
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    out(result(text));
    break;
  }
  case 'scripted': {
    const file = process.env.STUB_ARGV_FILE;
    const call = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    appendFileSync(file, JSON.stringify({ argv: process.argv.slice(2) }) + '\n');
    const text = JSON.parse(process.env.STUB_RESULTS)[call];
    if (process.env.STUB_WRITE_FILE && text.includes('"status"')) writeFileSync(process.env.STUB_WRITE_FILE, 'stub change\n');
    out({ type: 'system', subtype: 'init' });
    out(result(text));
    break;
  }
  case 'steps': {
    writePids(null);
    out({ type: 'system', subtype: 'init' });
    const n = Number(process.env.STUB_STEPS ?? 3);
    for (let i = 1; i <= n; i++) out(assistantToolUse(i));
    const text = process.env.STUB_RESULT_TEXT ?? 'all steps done';
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const line = JSON.stringify(result(text)) + '\n';
    const mid = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, mid));
    await sleep(30);
    process.stdout.write(line.slice(mid));
    break;
  }
  case 'silent': {
    writePids(spawnGrandchild());
    out({ type: 'system', subtype: 'init' });
    setInterval(() => {}, 1000);
    break;
  }
  case 'forever': {
    writePids(spawnGrandchild());
    let i = 0;
    setInterval(() => out(assistantToolUse(++i)), 20);
    break;
  }
  case 'truncated': {
    out(assistantToolUse(1));
    process.stdout.write('{"type":"result","subtype":"succ');
    break;
  }
  case 'noise': {
    process.stdout.write('hello there\nnot json at all\n[1,2,3]\n{"no_type":true}\n');
    break;
  }
  case 'no-result': {
    out(assistantToolUse(1));
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'I stopped early' }] } });
    break;
  }
  case 'exit-nonzero': {
    process.stderr.write('stub: something went wrong\n');
    process.exitCode = 3;
    break;
  }
  case 'orphan': {
    writePids(spawnGrandchild('inherit'));
    out(result('done, but left a background process'));
    break;
  }
  default:
    process.stderr.write(`stub: unknown STUB_MODE ${mode}\n`);
    process.exitCode = 99;
}
