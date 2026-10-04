import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/index.js';
import { PAGE_HTML } from '../../src/dashboard/page.js';
import { buildOverview } from '../../src/dashboard/overview.js';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopback, startDashboard, type DashboardServer } from '../../src/dashboard/server.js';
import { openReadOnlyDb } from '../../src/kernel/db.js';
import { addChain, addJob, event, makeDb, NOW, type TempDb } from './support.js';

let t: TempDb | undefined;
let dash: DashboardServer | undefined;
afterEach(async () => {
  await dash?.close();
  dash = undefined;
  t?.cleanup();
  t = undefined;
});

const url = (path: string) => `http://127.0.0.1:${dash!.port}${path}`;

async function start() {
  t = makeDb();
  const c = addChain(t.db, { status: 'active', issue: 1 });
  addJob(t.db, c, { status: 'queued' });
  event(t.db, c, 'chain.created', NOW - 1000);
  dash = await startDashboard({ db: openReadOnlyDb(t.path), port: 0, now: () => NOW });
  return c;
}

describe('dashboard server', () => {
  it('defaults to loopback and port 4173', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(4173);
    expect(isLoopback(DEFAULT_HOST)).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.5')).toBe(false);
  });

  it('serves the page, the overview, a chain timeline, 404 and 405', async () => {
    const chainId = await start();
    expect(dash!.host).toBe('127.0.0.1');

    const page = await fetch(url('/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Needs you');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\/(?!github\.com\/)[a-z]/i);

    const api = await fetch(url('/api/overview'));
    expect(api.status).toBe(200);
    const body = (await api.json()) as ReturnType<typeof buildOverview>;
    expect(body.generatedAt).toBe(NOW);
    expect(body.openChains.map((c) => c.id)).toEqual([chainId]);

    const timeline = await fetch(url(`/api/chains/${chainId}`));
    expect(timeline.status).toBe(200);
    expect(((await timeline.json()) as { events: unknown[] }).events).toHaveLength(1);
    expect((await fetch(url('/api/chains/999'))).status).toBe(404);

    expect((await fetch(url('/nope'))).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(url('/api/overview'), { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
    expect((await fetch(url('/'), { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('never writes: the connection is read-only', async () => {
    t = makeDb();
    const ro = openReadOnlyDb(t.path);
    expect(() => ro.prepare(`INSERT INTO chains (engine, subject_key, status, engine_state, created_at, updated_at) VALUES ('e','k','active','{}',0,0)`).run()).toThrow(/readonly/i);
    ro.close();
  });
});

describe('dashboard command', () => {
  it('starts on loopback, serves, and shuts down on a signal', async () => {
    t = makeDb();
    const dir = mkdtempSync(join(tmpdir(), 'dash-cfg-'));
    try {
      const cfg = join(dir, 'factory.config.json');
      writeFileSync(cfg, JSON.stringify({ dbPath: t.path }));
      const out: string[] = [];
      const err: string[] = [];
      const handlers: Record<string, () => void> = {};
      const done = run(['--config', cfg, 'dashboard', '--port', '0'], {
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
        onSignal: (s, h) => void (handlers[s] = h),
      });
      for (let i = 0; i < 100 && out.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const m = /^dashboard listening on http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(out[0] ?? '');
      expect(m).not.toBeNull();
      expect(err).toEqual([]);
      expect((await fetch(`http://127.0.0.1:${m![1]}/api/overview`)).status).toBe(200);
      handlers.SIGTERM!();
      expect(await done).toBe(0);
      expect(out).toContain('dashboard stopped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when bound to a non-loopback address', async () => {
    t = makeDb();
    const dir = mkdtempSync(join(tmpdir(), 'dash-cfg-'));
    try {
      const cfg = join(dir, 'factory.config.json');
      writeFileSync(cfg, JSON.stringify({ dbPath: t.path }));
      const out: string[] = [];
      const err: string[] = [];
      const handlers: Record<string, () => void> = {};
      const done = run(['--config', cfg, 'dashboard', '--port', '0', '--host', '0.0.0.0'], {
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
        onSignal: (s, h) => void (handlers[s] = h),
      });
      for (let i = 0; i < 100 && out.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(err.join('\n')).toContain('no authentication');
      handlers.SIGINT!();
      expect(await done).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a bad port', async () => {
    const err: string[] = [];
    expect(await run(['dashboard', '--port', 'x'], { stderr: (l) => err.push(l), stdout: () => {} })).toBe(2);
  });
});

// A minimal DOM that records what the page builds. Setting innerHTML (or any other markup parser) throws.
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  constructor(public tag: string, public text: string | null = null) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  hasAttribute(k: string) { return k in this.attrs; }
  appendChild(c: FakeNode) { this.children.push(c); return c; }
  replaceChildren(...cs: Array<FakeNode | null>) { this.children = cs.filter((c): c is FakeNode => c !== null); }
  addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); }
  set innerHTML(_v: string) { throw new Error('innerHTML is not allowed'); }
  set outerHTML(_v: string) { throw new Error('outerHTML is not allowed'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML is not allowed'); }
  walk(f: (n: FakeNode) => void) { f(this); for (const c of this.children) c.walk(f); }
}

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  return m![1]!;
}

describe('page rendering', () => {
  it('renders text from GitHub and agents as text, never as markup', async () => {
    t = makeDb();
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const c = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 1, subjectKey: evil, branch: evil });
    addJob(t.db, c, { status: 'succeeded' });
    event(t.db, c, 'review.verdict', NOW - 1000, { verdict: 'request_changes', feedback: evil, error: '<b onmouseover=x>' });
    const overview = buildOverview(t.db, NOW);
    overview.openChains[0]!.subject = null;
    const timeline = { chain: { id: c }, events: overview.openChains[0]!.events, cost: { jobs: [], totalUsd: 0 } };

    const root = new FakeNode('div');
    const document = {
      getElementById: () => root,
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (text: string) => new FakeNode('#text', text),
      addEventListener: () => {},
      hidden: false,
    };
    const respond = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    const fetchStub = (u: string) => respond(u.startsWith('/api/chains/') ? timeline : overview);
    vm.runInNewContext(scriptOf(PAGE_HTML), { document, fetch: fetchStub, setTimeout: () => 0, clearTimeout: () => {}, Date, JSON, Object, Promise, String, Number, Math, Array });
    await new Promise((r) => setTimeout(r, 20));

    const render = () => {
      const tags: string[] = [];
      const texts: string[] = [];
      root.walk((n) => {
        tags.push(n.tag);
        if (n.text !== null) texts.push(n.text);
      });
      return { tags, texts: texts.join('\n') };
    };
    let r = render();
    expect(r.texts).toContain(evil); // the subject, as text
    expect(r.tags).not.toContain('script');
    expect(r.tags).not.toContain('img');

    // Expand the chain: the full timeline shows the event details, still as text.
    let details: FakeNode | undefined;
    root.walk((n) => {
      if (n.tag === 'details') details = n;
    });
    details!.setAttribute('open', '');
    details!.listeners.toggle![0]!();
    await new Promise((r2) => setTimeout(r2, 20));
    r = render();
    expect(r.texts).toContain('onerror=alert(2)');
    expect(r.tags).not.toContain('script');
    expect(r.tags).not.toContain('img');
    root.walk((n) => {
      expect(Object.keys(n.attrs).filter((k) => k.startsWith('on'))).toEqual([]);
    });
  });

  it('never uses a markup-parsing API', () => {
    expect(PAGE_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});
