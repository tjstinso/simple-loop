import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { chainTimeline } from '../kernel/inspect.js';
import { buildOverview } from './overview.js';
import { PAGE_HTML } from './page.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4173;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** True for an address that only this machine can reach (`127.x.x.x`, `::1`, `localhost`). */
export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
}

export interface DashboardOptions {
  /** Must be a read-only connection: the server only ever reads. */
  db: Database.Database;
  host?: string;
  port?: number;
  now?: () => number;
}

export interface DashboardServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

/** Serves the dashboard page and its read-only JSON API. Resolves once it is listening. */
export function startDashboard(opts: DashboardOptions): Promise<DashboardServer> {
  const now = opts.now ?? (() => Date.now());
  const host = opts.host ?? DEFAULT_HOST;
  const send = (res: import('node:http').ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
    res.end(body);
  };
  const json = (res: import('node:http').ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);

  const server = createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/') {
        send(res, 200, 'text/html; charset=utf-8', PAGE_HTML);
        return;
      }
      if (path === '/api/overview') {
        json(res, 200, buildOverview(opts.db, now()));
        return;
      }
      const m = /^\/api\/chains\/([0-9]+)$/.exec(path);
      if (m) {
        const timeline = chainTimeline(opts.db, Number(m[1]));
        if (timeline) json(res, 200, timeline);
        else json(res, 404, { error: 'chain not found' });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject);
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        host,
        port: addr.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
