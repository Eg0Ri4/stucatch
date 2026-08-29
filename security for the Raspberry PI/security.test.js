// Tests for security.js. Run: node --test security.test.js
// Plain JS + node:test, no deps. The module itself is Deno-safe; these tests
// use node:test only because that's what's on this machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecurityMonitor, normalize, seqIsNewer, DEFAULT_CONFIG } from "./security.js";

// ---- helpers ---------------------------------------------------------------

const HUB = "A0B0C0D0";
const S1 = "A1B1C1D1";
const S2 = "A2B2C2D2";

function line(o) {
  return JSON.stringify({ v: 4, stamped: 1, epoch: 100, hops: 0, via: o.origin, ...o });
}
const ping = (origin, seq) => line({ kind: 1, origin, seq });
const sync = (origin, seq) => line({ kind: 0, origin, seq, authority: 5000 });
const alarm = (origin, seq, mag = 0.4, bearing = 90) => line({ kind: 3, origin, seq, rssi: -60, mag, bearing });
const status = (origin, seq, over = {}) =>
  line({ kind: 4, origin, seq, fw: 6, role: 1, boots: 1, up: 100, syncAge: 3, tx: 1, rx: 1, drop: 0, ...over });

// ---- normalize -----------------------------------------------------------

test("normalize: data line (alarm)", () => {
  const m = normalize(alarm(S1, 10, 0.42, 135));
  assert.equal(m.ok, true);
  assert.equal(m.type, "data");
  assert.equal(m.kindName, "alarm");
  assert.equal(m.origin, S1);
  assert.equal(m.seq, 10);
  assert.equal(m.payload.mag, 0.42);
  assert.equal(m.payload.bearing, 135);
});

test("normalize: each kind's payload", () => {
  assert.equal(normalize(sync(HUB, 1)).payload.authority, 5000);
  assert.equal(normalize(ping(S1, 1)).payload.authority, undefined);
  assert.deepEqual(
    normalize(line({ kind: 2, origin: S1, seq: 1, rssi: -50, peer: HUB, peerRssi: -48 })).payload,
    { peer: HUB, peerRssi: -48 },
  );
  const st = normalize(status(HUB, 1, { role: 0 }));
  assert.equal(st.payload.roleName, "hub");
  assert.equal(st.payload.tx, 1);
});

test("normalize: log line, with role", () => {
  const m = normalize('{"type":"log","ev":"boot","id":"A1B1C1D1","t":20,"role":1}');
  assert.equal(m.type, "log");
  assert.equal(m.ev, "boot");
  assert.equal(m.id, S1);
  assert.equal(m.role, 1);
});

test("normalize: accepts raw bytes (Uint8Array / Buffer) as well as a string", () => {
  const s = '{"v":4,"kind":1,"origin":"A1B1C1D1","seq":7,"stamped":1,"epoch":0,"via":"A1B1C1D1","hops":0}';
  const bytes = new TextEncoder().encode(s + "\r\n");
  const e = normalize(bytes);
  assert.equal(e.ok, true);
  assert.equal(e.type, "data");
  assert.equal(e.kindName, "ping");
  assert.equal(e.seq, 7);
});

test("normalize: garbage never throws, returns ok:false", () => {
  for (const bad of ["", "   ", "not json", "42", '"a string"', "[1,2,3]", "null", '{"v":3}', '{"v":4}', undefined, null, 123]) {
    const m = normalize(bad);
    assert.equal(m.ok, false, `expected ok:false for ${JSON.stringify(bad)}`);
    assert.equal(typeof m.reason, "string");
  }
});

test("normalize: bad fields rejected", () => {
  assert.equal(normalize('{"v":4,"kind":9,"origin":"A1","seq":1,"hops":0}').ok, false);
  assert.equal(normalize('{"v":4,"kind":1,"origin":"ZZZZ","seq":1,"hops":0}').ok, false);
  assert.equal(normalize('{"v":4,"kind":1,"origin":"A1","seq":70000,"hops":0}').ok, false);
  assert.equal(normalize('{"v":4,"kind":1,"origin":"A1","seq":-1,"hops":0}').ok, false);
  assert.equal(normalize('{"v":4,"kind":1,"origin":"A1","seq":1,"hops":-1}').ok, false);
});

test("normalize: origin upper-cased", () => {
  assert.equal(normalize('{"v":4,"kind":1,"origin":"a1b2c3d4","seq":1,"hops":0}').origin, "A1B2C3D4");
});

test("seqIsNewer: uint16 wraparound", () => {
  assert.equal(seqIsNewer(5, 4), true);
  assert.equal(seqIsNewer(4, 5), false);
  assert.equal(seqIsNewer(4, 4), false);
  assert.equal(seqIsNewer(1, 65535), true);
  assert.equal(seqIsNewer(65535, 1), false);
});

// ---- monitor: lifecycle -------------------------------------------------

test("getReport works before any ingest", () => {
  const sec = createSecurityMonitor();
  const r = sec.getReport(1000);
  assert.equal(r.nodes.length, 0);
  assert.equal(r.summary.threatLevel, "none");
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("ingest never throws on anything", () => {
  const sec = createSecurityMonitor();
  for (const bad of [undefined, null, "", "x", "{", "[]", "42", '{"v":4}', {}, [], 999]) {
    assert.doesNotThrow(() => sec.ingest(bad, 1000));
  }
  assert.ok(sec.getReport(1000).summary.malformed >= 5);
});

test("reset clears everything", () => {
  const sec = createSecurityMonitor();
  sec.ingest(ping(S1, 1), 1000);
  sec.reset();
  const r = sec.getReport(2000);
  assert.equal(r.nodes.length, 0);
  assert.equal(r.summary.messages, 0);
});

// ---- learning vs watching --------------------------------------------

test("learning window adopts new origins quietly; after it, unknown_node fires", () => {
  const sec = createSecurityMonitor();
  sec.ingest(ping(S1, 1), 1000); // inside 20s learn window
  sec.ingest(ping(S2, 1), 5000);
  let r = sec.getReport(6000);
  assert.equal(r.mode, "learning");
  assert.ok(!r.events.some((e) => e.kind === "unknown_node"));

  sec.ingest(ping("BEEF", 1), 45000); // after the 40s window
  r = sec.getReport(45001);
  assert.equal(r.mode, "watching");
  assert.ok(r.events.some((e) => e.kind === "unknown_node" && e.node === "BEEF"));
  const n = r.nodes.find((x) => x.id === "BEEF");
  assert.equal(n.state, "suspect");
});

test("unknown node stays suspect while it keeps transmitting (not just for flagTtlMs)", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, flagTtlMs: 1000 });
  sec.ingest(ping("BAD1", 1), 1000);
  sec.ingest(ping("BAD1", 2), 3000);
  sec.ingest(ping("BAD1", 3), 20000); // long after flagTtlMs
  const n = sec.getReport(20001).nodes.find((x) => x.id === "BAD1");
  assert.equal(n.state, "suspect");
  assert.equal(n.known, false);
  assert.ok(n.flags.includes("unknown_node"));
});

test("knownNodes config trusts ids from the start, any case", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: ["a1b1c1d1", "A0B0C0D0"] });
  sec.ingest(ping(S1, 1), 5000);
  sec.ingest(sync(HUB, 1), 5000);
  sec.ingest(ping("BADBAD", 1), 5000); // valid hex, not in the list
  const r = sec.getReport(5001);
  assert.equal(r.nodes.find((x) => x.id === S1).state, "ok");
  assert.equal(r.nodes.find((x) => x.id === HUB).state, "ok");
  assert.equal(r.nodes.find((x) => x.id === "BADBAD").state, "suspect");
});

// ---- replay ----------------------------------------------------------

test("replay: firmware 3x resend of an alarm is NOT a replay", () => {
  const sec = createSecurityMonitor();
  sec.ingest(alarm(S1, 100), 1000);
  sec.ingest(alarm(S1, 100), 1200); // resend
  sec.ingest(alarm(S1, 100), 2000); // resend
  const r = sec.getReport(2100);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("replay: a relay copy (same seq, higher hops, seconds later) is NOT a replay", () => {
  const sec = createSecurityMonitor();
  sec.ingest(alarm(S1, 100), 1000);
  sec.ingest(line({ kind: 3, origin: S1, seq: 100, rssi: -61, mag: 0.4, bearing: 90, via: "FE01", hops: 1 }), 1050);
  const r = sec.getReport(1100);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("replay: an old seq resurfacing after the resend window IS a replay", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  sec.ingest(ping(S1, 100), 1000);
  sec.ingest(ping(S1, 101), 2000);
  sec.ingest(ping(S1, 102), 3000);
  sec.ingest(ping(S1, 95), 12000); // 9s after we moved past it, and 7 behind
  const r = sec.getReport(12001);
  assert.ok(r.events.some((e) => e.kind === "replay" && e.node === S1));
});

test("replay: a reboot (silence then low seq) is not flagged as replay", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  sec.ingest(ping(S1, 50000), 1000);
  sec.ingest(ping(S1, 12), 1000 + 61000); // >60s silence -> reboot
  const r = sec.getReport(1000 + 61001);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
  assert.ok(r.events.some((e) => e.kind === "node_reboot"));
});

test("replay: reboot from a status frame suppresses the false replay", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  sec.ingest(status(S1, 200, { boots: 1, up: 300 }), 1000);
  sec.ingest(ping(S1, 205), 1500);
  sec.ingest(status(S1, 9, { boots: 2, up: 4 }), 3000); // boots up, uptime down -> reboot
  sec.ingest(ping(S1, 12), 3200); // low seq right after -> must NOT be replay
  const r = sec.getReport(3300);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
  assert.ok(r.events.some((e) => e.kind === "node_reboot" && e.node === S1));
});

// ---- rate spike / id flood -----------------------------------------

test("rate_spike fires when a node exceeds the threshold in one second", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, ratePerSec: 5 });
  for (let i = 0; i < 8; i++) sec.ingest(ping(S1, 1000 + i), 5000 + i);
  const r = sec.getReport(5100);
  assert.ok(r.events.some((e) => e.kind === "rate_spike" && e.node === S1));
});

test("id_flood fires past maxNodes and memory stays bounded", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, maxNodes: 8 });
  for (let i = 1; i <= 200; i++) sec.ingest(ping((0x1000 + i).toString(16), 1), 5000 + i);
  const r = sec.getReport(6000);
  assert.ok(r.events.some((e) => e.kind === "id_flood"));
  assert.ok(r.nodes.length <= 8, `nodes should be capped, got ${r.nodes.length}`);
});

// ---- impossible / malformed ---------------------------------------

test("impossible: out-of-range fields flagged", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  sec.ingest(line({ kind: 3, origin: S1, seq: 1, rssi: -60, mag: 0.4, bearing: 999 }), 1000);
  sec.ingest(line({ kind: 1, origin: S2, seq: 1, hops: 50 }), 1000);
  const r = sec.getReport(1100);
  const kinds = r.events.filter((e) => e.kind === "impossible").map((e) => e.detail);
  assert.ok(kinds.some((d) => d.includes("bearing")));
  assert.ok(kinds.some((d) => d.includes("hops")));
});

test("malformed: unparseable lines counted, one collapsed row", () => {
  const sec = createSecurityMonitor();
  for (let i = 0; i < 10; i++) sec.ingest("garbage " + i, 1000 + i);
  const r = sec.getReport(1100);
  const mal = r.events.filter((e) => e.kind === "malformed");
  assert.equal(mal.length, 1);
  assert.equal(mal[0].count, 10);
  assert.equal(r.summary.malformed, 10);
});

// ---- silence / jamming ------------------------------------------

test("silent fires only for a node that had a real heartbeat", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  // establish steadiness: >=3 msgs over >8s
  sec.ingest(ping(S1, 1), 1000);
  sec.ingest(ping(S1, 2), 6000);
  sec.ingest(ping(S1, 3), 11000);
  assert.equal(sec.getReport(12000).nodes[0].state, "ok");
  const r = sec.getReport(11000 + 25000); // 25s later, past silenceMs
  assert.equal(r.nodes[0].state, "silent");
  assert.ok(r.events.some((e) => e.kind === "silent"));
});

test("hub / relay on a 30s heartbeat do NOT flap silent", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [HUB] });
  // hub identifies itself as role 0 via status, then heartbeats every 30s
  let t = 1000;
  for (let i = 0; i < 6; i++) {
    sec.ingest(status(HUB, 100 + i, { role: 0 }), t);
    t += 30000;
    const r = sec.getReport(t - 1); // just before the next beat, ~30s quiet
    assert.ok(!r.events.some((e) => e.kind === "silent"), `silent should not fire at ${t - 1}`);
    assert.notEqual(r.nodes[0].state, "silent");
  }
});

test("gateway self-report (status, no rssi) is trusted even after the learn window", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  // no "rssi" key => this is the board on our own serial
  sec.ingest(line({ kind: 4, origin: "B0B0", seq: 1, fw: 6, role: 0, boots: 1, up: 50, syncAge: 3, tx: 1, rx: 1, drop: 0 }), 30000);
  const n = sec.getReport(30001).nodes[0];
  assert.equal(n.known, true);
  assert.equal(n.state, "ok");
});

test("reorderSlack tolerates a relay copy several seq behind, inside the window", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  for (let s = 10; s <= 16; s++) sec.ingest(ping(S1, s), 1000 + (s - 10) * 100); // burst to seq 16
  // a relayed copy of seq 11 arrives 300ms after seq 16, 5 behind
  sec.ingest(line({ kind: 1, origin: S1, seq: 11, via: "FE01", hops: 1 }), 2000);
  const r = sec.getReport(2100);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("replay: a direct (hop 0) frame several seq behind the max IS a replay", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  for (let s = 20; s <= 26; s++) sec.ingest(ping(S1, s), 1000 + (s - 20) * 100);
  sec.ingest(line({ kind: 1, origin: S1, seq: 22, hops: 0 }), 1700); // 4 behind, in window, direct
  const r = sec.getReport(1800);
  assert.ok(r.events.some((e) => e.kind === "replay" && e.node === S1));
});

test("replay: a hop-0 frame exactly 1 behind (near-simultaneous dup) is tolerated", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  sec.ingest(ping(S1, 40), 1000);
  sec.ingest(ping(S1, 41), 1010);
  sec.ingest(line({ kind: 1, origin: S1, seq: 40, hops: 0 }), 1020); // 1 behind, ~instant
  const r = sec.getReport(1100);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("replay: an old frame with an implausible hop count is NOT forgiven as a relay copy", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  for (let s = 30; s <= 40; s++) sec.ingest(ping(S1, s), 1000 + (s - 30) * 50);
  sec.ingest(line({ kind: 1, origin: S1, seq: 31, hops: 99 }), 1600); // attacker stamps a big hop count
  const r = sec.getReport(1700);
  assert.ok(r.events.some((e) => e.kind === "replay" && e.node === S1));
});

test("an id flood does not evict a listed (known) node", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, maxNodes: 6, knownNodes: [S1] });
  sec.ingest(ping(S1, 1), 1000);
  for (let i = 1; i <= 100; i++) sec.ingest(ping((0x2000 + i).toString(16), 1), 2000 + i);
  // S1 hasn't sent since t=1000 but must still be in the table, still trusted
  const s1 = sec.getReport(3000).nodes.find((x) => x.id === S1);
  assert.ok(s1, "S1 should survive the flood");
  assert.equal(s1.known, true);
});

test("a broken config does not throw", () => {
  assert.doesNotThrow(() => createSecurityMonitor({ limits: "nope" }));
  assert.doesNotThrow(() => createSecurityMonitor({ checks: 123 }));
  assert.doesNotThrow(() => createSecurityMonitor({ knownNodes: "x" }));
  const sec = createSecurityMonitor({ limits: "nope", checks: null });
  assert.doesNotThrow(() => sec.ingest(ping(S1, 1), 1000));
});

test("an explicit undefined in the config override falls back to the default", () => {
  // learnWindowMs: undefined must NOT disable the learn window
  const sec = createSecurityMonitor({ learnWindowMs: undefined, checks: { replay: undefined } });
  sec.ingest(ping(S1, 1), 1000); // well inside the default 40s window
  assert.equal(sec.getReport(1001).nodes[0].state, "ok");
  assert.equal(sec.config.checks.replay, true); // replay still on
  assert.equal(sec.config.learnWindowMs, 40000);
});

test("a complete status frame adopts a node just past the ping learn window", () => {
  const sec = createSecurityMonitor(); // default 40s window
  sec.ingest(ping(S1, 1), 0); // sets startedAt = 0
  const st = line({ kind: 4, origin: "FE01", seq: 1, rssi: -40, fw: 6, role: 2, boots: 1, up: 30, syncAge: 5, tx: 1, rx: 1, drop: 0 });
  sec.ingest(st, 45000); // 45s in: past the 40s ping window, inside the 80s status window
  const n = sec.getReport(45001).nodes.find((x) => x.id === "FE01");
  assert.equal(n.known, true);
  assert.equal(n.state, "ok");
  assert.ok(!sec.getReport(45001).events.some((e) => e.kind === "unknown_node"));
});

test("a status frame past 2x the learn window is still flagged", () => {
  const sec = createSecurityMonitor();
  sec.ingest(ping(S1, 1), 0); // startedAt = 0
  const st = line({ kind: 4, origin: "FE02", seq: 1, rssi: -40, fw: 6, role: 2, boots: 1, up: 30, syncAge: 5, tx: 1, rx: 1, drop: 0 });
  sec.ingest(st, 90000); // 90s in: past 2 * 40s
  const n = sec.getReport(90001).nodes.find((x) => x.id === "FE02");
  assert.equal(n.state, "suspect");
});

test("reboot grace covers a straggler frame that lands a few seconds after the reboot", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  const st = (seq, boots, up) =>
    line({ kind: 4, origin: S1, seq, fw: 6, role: 1, boots, up, syncAge: 3, tx: 1, rx: 1, drop: 0 });
  sec.ingest(st(500, 1, 400), 1000);
  sec.ingest(ping(S1, 505), 1500);
  sec.ingest(st(2, 2, 3), 3000); // reboot detected here
  sec.ingest(ping(S1, 30), 3200); // fresh post-reboot burst
  sec.ingest(ping(S1, 6), 9000); // a straggler from the burst, 6s later, low seq
  const r = sec.getReport(9100);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("a weird rssi value is not flagged impossible", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1] });
  sec.ingest(line({ kind: 1, origin: S1, seq: 1, rssi: 47 }), 1000); // mis-scaled positive rssi
  const r = sec.getReport(1100);
  assert.ok(!r.events.some((e) => e.kind === "impossible"));
});

test("jamming fires when two steady nodes go silent together", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, knownNodes: [S1, S2] });
  for (const s of [S1, S2]) {
    sec.ingest(ping(s, 1), 1000);
    sec.ingest(ping(s, 2), 6000);
    sec.ingest(ping(s, 3), 11000);
  }
  sec.getReport(12000);
  const r = sec.getReport(11000 + 25000);
  assert.ok(r.events.some((e) => e.kind === "jamming"));
  assert.equal(r.summary.threatLevel, "high");
});

// ---- rogue sync -------------------------------------------------

test("rogue_sync: SYNC from a non-hub origin", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0 });
  sec.ingest(sync(HUB, 1), 1000); // this defines the hub
  sec.ingest(sync("DEAD", 1), 2000); // a second SYNC source
  const r = sec.getReport(2100);
  assert.ok(r.events.some((e) => e.kind === "rogue_sync" && e.node === "DEAD"));
  assert.equal(sec.hub, HUB);
});

// ---- config toggles ------------------------------------------

test("a disabled check does not fire", () => {
  const sec = createSecurityMonitor({ learnWindowMs: 0, checks: { replay: false } });
  sec.ingest(ping(S1, 100), 1000);
  sec.ingest(ping(S1, 101), 2000);
  sec.ingest(ping(S1, 90), 12000);
  const r = sec.getReport(12001);
  assert.ok(!r.events.some((e) => e.kind === "replay"));
});

test("overriding config does not mutate DEFAULT_CONFIG", () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  createSecurityMonitor({ ratePerSec: 1, limits: { hops: [0, 1] }, checks: { replay: false } });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
});

// ---- a realistic 3-node stream stays quiet -------------------

test("normal traffic from a learned fleet raises nothing", () => {
  const sec = createSecurityMonitor();
  let t = 0;
  const seqOf = { [HUB]: 1, [S1]: 1, [S2]: 1 };
  for (let round = 0; round < 30; round++) {
    t += 1000;
    if (round % 10 === 0) sec.ingest(sync(HUB, seqOf[HUB]++), t);
    if (round % 5 === 0) {
      sec.ingest(ping(S1, seqOf[S1]++), t);
      sec.ingest(ping(S2, seqOf[S2]++), t + 100);
    }
    if (round % 30 === 15) sec.ingest(status(HUB, seqOf[HUB]++, { role: 0 }), t);
    sec.getReport(t);
  }
  const r = sec.getReport(t);
  const noisy = r.events.filter((e) => ["high", "medium"].includes(e.severity));
  assert.deepEqual(noisy, [], "no medium/high events on clean traffic: " + JSON.stringify(noisy));
  assert.equal(r.summary.threatLevel, "none");
});
