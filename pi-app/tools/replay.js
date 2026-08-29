#!/usr/bin/env node
// Offline check: feed a captured serial log through the parser + store and print
// what each line became. No serial, no HTTP.
//
//   node tools/replay.js capture.txt
//   pv capture.txt | node tools/replay.js          (reads stdin)
//   ssh pi 'cat /var/log/stucatch.ndjson' | node tools/replay.js

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';

const file = process.argv[2];
const input = file ? createReadStream(file, 'utf8') : process.stdin;
const store = new Store(config.store);
const rl = createInterface({ input, crlfDelay: Infinity });

const tally = {};
for await (const line of rl) {
  const evt = store.ingestLine(line);
  tally[evt.kind] = (tally[evt.kind] || 0) + 1;
  if (evt.kind === 'invalid') console.log('INVALID:', evt.reason, '::', evt.raw.slice(0, 120));
  if (evt.kind === 'junk' && line.trim()) console.log('JUNK   :', line.slice(0, 120));
}

const snap = store.snapshot();
console.log('\n--- line classes ---');
console.table(tally);
console.log('--- nodes ---');
console.table(
  snap.nodes.map((n) => ({
    id: n.id, role: n.roleName, state: n.state,
    seq: n.lastSeq, msgs: n.msgCount, dupes: n.dupeCount,
    rssi: n.lastRssi, hops: n.lastHops,
  })),
);
console.log(`alarms: ${snap.alarms.length}   counters:`, snap.counters);
