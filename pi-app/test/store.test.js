import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const cfg = {
  alarmHistory: 100,
  eventHistory: 80,
  liveness: {
    hub: { stale: 25000, silent: 60000 },
    sensor: { stale: 13000, silent: 40000 },
    relay: { stale: 25000, silent: 60000 },
    unknown: { stale: 20000, silent: 50000 },
  },
  rebootAgeMs: 60000,
  maxNodes: 64,
};

// origins must be 1-8 hex chars, like the firmware prints them
const HUB = 'A0B0C0D0';
const S1 = 'A1B1C1D1';
const S2 = 'A2B2C2D2';
const RELAY = 'FE01';

const data = (o) =>
  JSON.stringify({ v: 4, stamped: 1, epoch: 100, hops: 0, ...o, via: o.via ?? o.origin });

test('counts line classes', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 1, origin: S1, seq: 1 }), 1000);
  s.ingestLine('rst:0x1 boot noise', 1000);
  s.ingestLine('', 1000);
  s.ingestLine(`{"v":9,"kind":1,"origin":"${S1}","seq":1,"stamped":0,"epoch":0,"via":"${S1}","hops":0}`, 1000);
  s.ingestLine(`{"type":"log","ev":"boot","id":"${S1}"}`, 1000);
  assert.equal(s.counters.data, 1);
  assert.equal(s.counters.junk, 1);
  assert.equal(s.counters.blank, 1);
  assert.equal(s.counters.invalid, 1);
  assert.equal(s.counters.log, 1);
});

test('dedup: relayed / resent copy of same (origin,seq) is a dupe', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 3, origin: S1, seq: 100, rssi: -60, mag: 0.4, bearing: 10 }), 1000);
  s.ingestLine(data({ kind: 3, origin: S1, seq: 100, rssi: -61, mag: 0.4, bearing: 10, via: RELAY, hops: 1 }), 1100);
  s.ingestLine(data({ kind: 3, origin: S1, seq: 100, rssi: -60, mag: 0.4, bearing: 10 }), 1300);
  const n = s.snapshot(1400).nodes.find((x) => x.id === S1);
  assert.equal(n.msgCount, 1);
  assert.equal(n.dupeCount, 2);
  assert.equal(s.snapshot(1400).alarms.length, 1); // 3x firmware resend collapses
});

test('dedup: newer seq advances, wraparound aware', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 65534 }), 1000);
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 65535 }), 1100);
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 1 }), 1200); // wrapped forward -> new
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 60000 }), 1300); // far behind -> dupe
  const n = s.snapshot(1400).nodes[0];
  assert.equal(n.msgCount, 3);
  assert.equal(n.dupeCount, 1);
  assert.equal(n.lastSeq, 1);
});

test('reboot: unlucky low random seq is dupe until rebootAgeMs of silence', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 40000 }), 1000);
  // 20000 is > 32768 behind 40000 -> reads as backward -> dupe
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 20000 }), 2000);
  assert.equal(s.snapshot(2000).nodes[0].dupeCount, 1);
  // same frame after > 60s silence -> aged out -> accepted as a fresh boot
  s.ingestLine(data({ kind: 1, origin: HUB, seq: 20000 }), 2000 + 61000);
  const n = s.snapshot(2000 + 61000).nodes[0];
  assert.equal(n.msgCount, 2);
  assert.equal(n.lastSeq, 20000);
});

test('reboot: status payload (boots up / uptime back) rebuilds dedup immediately', () => {
  const s = new Store(cfg);
  const st = (extra) => data({ kind: 4, origin: S2, fw: 4, role: 1, boots: 1, up: 300, syncAge: 3, tx: 1, rx: 1, drop: 0, ...extra });
  s.ingestLine(st({ seq: 40000, boots: 1, up: 300 }), 1000);
  s.ingestLine(data({ kind: 1, origin: S2, seq: 40001 }), 1500);
  // reboot: boots 1 -> 2, uptime 300 -> 4, and a low seq that would look backward
  s.ingestLine(st({ seq: 9, boots: 2, up: 4 }), 5000);
  s.ingestLine(data({ kind: 1, origin: S2, seq: 10 }), 5200);
  const n = s.snapshot(5300).nodes[0];
  assert.equal(n.lastSeq, 10); // the post-reboot ping was accepted
  assert.ok(s.snapshot(5300).events.some((e) => e.ev === 'node_reboot' && e.id === S2));
});

test('reboot: an out-of-order (older) status does NOT trigger a false reboot', () => {
  const s = new Store(cfg);
  const st = (seq, boots, up) =>
    data({ kind: 4, origin: S1, seq, fw: 4, role: 1, boots, up, syncAge: 3, tx: 1, rx: 1, drop: 0 });
  s.ingestLine(st(200, 1, 300), 1000);
  s.ingestLine(data({ kind: 1, origin: S1, seq: 205 }), 1100); // lastSeq = 205
  s.ingestLine(st(50, 1, 200), 1200); // stale status: older seq (dupe) + lower uptime
  const snap = s.snapshot(1300);
  assert.ok(!snap.events.some((e) => e.ev === 'node_reboot'), 'no false node_reboot');
  assert.equal(snap.nodes[0].lastSeq, 205); // dedup baseline was NOT reset
});

test('state derivation is wall-clock based, per role', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 4, origin: S1, seq: 1, fw: 4, role: 1, boots: 1, up: 10, syncAge: 3, tx: 1, rx: 1, drop: 0 }), 10_000);
  assert.equal(s.snapshot(15_000).nodes[0].state, 'online'); // +5s
  assert.equal(s.snapshot(25_000).nodes[0].state, 'stale'); // +15s (sensor stale @13s)
  assert.equal(s.snapshot(60_000).nodes[0].state, 'silent'); // +50s (sensor silent @40s)
});

test('status payload fills role, fw, counters; syncAge 0xFFFF -> null', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 4, origin: HUB, seq: 1, fw: 4, role: 0, boots: 7, up: 500, syncAge: 65535, tx: 9, rx: 8, drop: 2 }), 1000);
  const n = s.snapshot(1000).nodes[0];
  assert.equal(n.roleName, 'hub');
  assert.equal(n.status.boots, 7);
  assert.equal(n.status.syncAgeS, null);
  assert.equal(n.status.tx, 9);
});

test('alarm emits an "alarm" event with the record', () => {
  const s = new Store(cfg);
  let got = null;
  s.on('alarm', (rec) => { got = rec; });
  s.ingestLine(data({ kind: 3, origin: S2, seq: 1, rssi: -58, mag: 1.23, bearing: 200 }), 1000);
  assert.ok(got);
  assert.equal(got.magnitude, 1.23);
  assert.equal(got.origin, S2);
});

test('snapshot sorts worst-first and is JSON-serialisable', () => {
  const s = new Store(cfg);
  s.ingestLine(data({ kind: 1, origin: S1, seq: 1 }), 100_000);
  s.ingestLine(data({ kind: 1, origin: S2, seq: 1 }), 1_000);
  const snap = s.snapshot(100_000);
  assert.equal(snap.nodes[0].id, S2); // S2 is silent, comes first
  assert.doesNotThrow(() => JSON.stringify(snap));
});

test('node table is capped: floods of random origins evict the stalest', () => {
  const s = new Store({ ...cfg, maxNodes: 3 });
  for (let i = 1; i <= 6; i++) {
    s.ingestLine(data({ kind: 1, origin: (0x1000 + i).toString(16), seq: 1 }), i * 1000);
  }
  const snap = s.snapshot(7000);
  assert.equal(snap.nodes.length, 3);
  assert.equal(s.counters.nodesEvicted, 3);
  // the 3 most recently heard survived (0x1004, 0x1005, 0x1006 -> "1004".."1006")
  const ids = snap.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['1004', '1005', '1006']);
});

test('i2c_lost / i2c_recovered flags from log lines', () => {
  const s = new Store(cfg);
  s.ingestLine(`{"type":"log","ev":"i2c_lost","id":"${S1}","t":1}`, 1000);
  assert.equal(s.snapshot(1000).nodes[0].flags.i2c, 'lost');
  s.ingestLine(`{"type":"log","ev":"i2c_recovered","id":"${S1}","t":1}`, 2000);
  assert.equal(s.snapshot(2000).nodes[0].flags.i2c, 'ok');
});
