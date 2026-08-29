#!/usr/bin/env node
// Entry point: wire serial (or simulator) -> store -> HTTP.
//
//   npm start            read the real ESP32 gateway over USB serial
//   npm run sim          no hardware: generate synthetic v4 traffic
//   SERIAL_PATH=/dev/ttyACM0 npm start     force a specific port

import os from 'node:os';
import { config } from './config.js';
import { Store } from './store.js';
import { startSimulator } from './simulator.js';
import { createServer } from './api.js';
// './serial.js' (and its `serialport` dependency) is imported lazily below, only
// when we actually need a serial port — so `npm run sim` / `npm test` work even
// before `npm install`.

const log = (tag, msg) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), tag, msg }));

const store = new Store(config.store);
const server = createServer(store, config.http);

server.on('error', (err) => {
  log('http-error', err.message);
  if (err.code === 'EADDRINUSE') {
    log('fatal', `port ${config.http.port} already in use — set HTTP_PORT`);
    process.exit(1);
  }
});

server.listen(config.http.port, config.http.host, () => {
  const urls = lanUrls(config.http.port);
  log('http', `dashboard on ${urls.join('  ')}`);
  log('http', `api: /api/state  /api/stream  /health`);
});

let stopSource = () => {};

if (process.argv.includes('--stdin')) {
  log('mode', 'STDIN — reading NDJSON from standard input (e.g. mesh-sim), no serial port opened');
  store.setSerialStatus({ state: 'stdin', path: '(stdin)', attempts: 0 });
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => store.ingestLine(line));
  rl.on('close', () => log('stdin', 'input ended — dashboard stays up with last state'));
  stopSource = () => rl.close();
} else if (config.simulate) {
  log('mode', 'SIMULATE — synthetic v4 traffic, no serial port opened');
  store.setSerialStatus({ state: 'simulated', path: '(simulator)', attempts: 0 });
  stopSource = startSimulator((line) => store.ingestLine(line));
} else {
  log('mode', config.serial.path ? `serial ${config.serial.path}` : 'serial auto-detect');
  let SerialLink;
  try {
    ({ SerialLink } = await import('./serial.js'));
  } catch (err) {
    log('fatal', `serial layer failed to load — run "npm install" first (${err.message})`);
    process.exit(1);
  }
  const link = new SerialLink(config.serial);
  link.on('status', (s) => {
    store.setSerialStatus(s);
    log('serial', `${s.state}${s.path ? ' ' + s.path : ''}${s.note ? ' — ' + s.note : ''}`);
  });
  link.on('line', (line) => store.ingestLine(line));
  link.on('error', (err) => log('serial-error', err.message));
  link.start();
  stopSource = () => link.stop();
}

// periodic health line so you can tell it's alive over SSH
setInterval(() => {
  const s = store.snapshot();
  log('health', `serial=${s.serial.state} nodes=${s.nodeCount} online=${s.onlineCount} ` +
    `lines=${s.counters.lines} data=${s.counters.data} junk=${s.counters.junk} ` +
    `invalid=${s.counters.invalid} dupes=${s.counters.dupes} alarms=${s.counters.alarms}`);
}, 30000).unref?.();

function shutdown(sig) {
  log('shutdown', `signal ${sig}`);
  try { stopSource(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  server.closeAllConnections?.(); // cut SSE keep-alives so close() completes now
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log('uncaught', err.stack || String(err)));
process.on('unhandledRejection', (err) => log('unhandled', String(err)));

function lanUrls(port) {
  const out = [`http://localhost:${port}`];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}
