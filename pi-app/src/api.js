// HTTP surface:
//   GET /            -> dashboard (single HTML page)
//   GET /api/state   -> current snapshot (JSON)
//   GET /api/stream  -> Server-Sent Events: a snapshot every sseIntervalMs,
//                       plus an immediate push on every alarm
//   GET /health      -> { ok, serial, uptimeMs }
//
// No framework. Depends only on node:http.

import http from 'node:http';
import { DASHBOARD_HTML } from './dashboard.js';

export function createServer(store, httpCfg) {
  const clients = new Set();

  const broadcast = () => {
    if (!clients.size) return;
    const data = `data: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch {
        clients.delete(res);
      }
    }
  };

  const ticker = setInterval(broadcast, httpCfg.sseIntervalMs);
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 15000);
  ticker.unref?.();
  heartbeat.unref?.();

  // push immediately when an alarm lands
  store.on('alarm', broadcast);

  // read-only telemetry on a trusted LAN — allow a separate frontend (e.g. a
  // second analysis UI) to read the API cross-origin
  const CORS = { 'Access-Control-Allow-Origin': '*' };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET' });
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('method not allowed');
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url === '/api/state') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(store.snapshot()));
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, serial: store.serial.state, uptimeMs: Date.now() - store.startedAt }));
      return;
    }

    if (url === '/api/stream') {
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.on('close', () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
  });

  return server;
}
