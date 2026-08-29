// security.test.js — run with:  deno test
// 33 cases: every check, the false-positive traps, learning-mode safety,
// call-rate independence, dedup correctness, and flood bounds. No external deps.

import { createSecurityMonitor, normalize } from "./security.js";

const SEV = { info: 0, low: 1, medium: 2, high: 3 };
const test = (name, fn) => Deno.test(name, fn);
const assert = (c, m) => {
  if (!c) throw new Error("assert: " + (m || ""));
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`want ${JSON.stringify(b)} got ${JSON.stringify(a)} — ${m || ""}`);
};

let SEQ = 1;
function fr(o = {}) {
  return {
    msg_id: o.msg_id ?? SEQ++ * 7 + 1,
    orig_id: o.orig_id ?? "9B05C4C0",
    fwd_id: o.fwd_id ?? o.orig_id ?? "9B05C4C0",
    type: o.type ?? 3,
    time: o.time ?? 1000,
    hops: o.hops ?? 0,
    d1: o.d1 ?? 0.4,
    d2: o.d2 ?? 135,
    rssi: o.rssi ?? -60,
  };
}
const nd = (r, id) => r.nodes.find((n) => n.id === id);

test("normalize maps the relay JSON and rejects junk", () => {
  const m = normalize(fr({ msg_id: 42, orig_id: "AA", d1: 0.7, d2: 200 }));
  eq(m.nodeId, "AA");
  eq(m.msgId, 42);
  eq(m.mag, 0.7);
  for (const x of [{}, { orig_id: "x" }, { msg_id: 1, id: "x" }, 42, "x", null, [], [1, 2]]) {
    eq(normalize(x), null, JSON.stringify(x));
  }
});

test("string-typed numeric fields are tolerated", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(
    { msg_id: "5", orig_id: "A", fwd_id: "A", type: "3", time: "1000", hops: "0", d1: "0.4", d2: "135", rssi: "-60" },
    0,
  );
  const n = s.getReport(0).nodes[0];
  eq(n.lastType, 3);
  eq(n.lastMag, 0.4);
});

test("uint32-range msg_id matches exactly for replay", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", msg_id: 4294967290 }), 0);
  s.ingest(fr({ orig_id: "A", msg_id: 4294967290 }), 9000);
  assert(s.getReport(9000).events.some((e) => e.kind === "replay"));
});

test("unknown node -> state blocked, high event, threat high, blocked count", () => {
  const s = createSecurityMonitor({ knownNodes: ["9B05C4C0"] });
  s.ingest(fr({ orig_id: "9B05C4C0", msg_id: 1 }), 0);
  s.ingest(fr({ orig_id: "DEAD", msg_id: 2 }), 0);
  const r = s.getReport(0);
  const g = nd(r, "DEAD");
  eq(g.state, "blocked");
  assert(g.flags.includes("unknown_node"));
  eq(r.summary.threatLevel, "high");
  eq(r.summary.mode, "enforcing");
  eq(r.summary.blocked, 1);
});

test("a flooding node ends up in state 'blocked'", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], rateWindowMs: 1000, rateThresholdPerSec: 20 });
  for (let i = 0; i < 60; i++) s.ingest(fr({ orig_id: "A", msg_id: 1000 + i }), i);
  eq(s.getReport(60).nodes[0].state, "blocked");
});

test("config is not shared with DEFAULT_CONFIG (frozen clone)", () => {
  const a = createSecurityMonitor();
  try {
    a.config.plausible.types.push(999);
  } catch (_e) {
    /* frozen -> throws, also fine */
  }
  eq(createSecurityMonitor().config.plausible.types.includes(999), false);
});

test("reset() restores learning mode", () => {
  const s = createSecurityMonitor({ learnWindowMs: 1000, learnMinMsgs: 1 });
  s.ingest(fr({ orig_id: "X", msg_id: 1 }), 0);
  s.getReport(5000);
  s.reset();
  s.ingest(fr({ orig_id: "Y", msg_id: 1 }), 0);
  eq(s.getReport(0).summary.mode, "learning");
});

test("a silent node stays 'silent' (no phantom recovery as the flag ages)", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], minMsgsForSilence: 3, minSpanForSilence: 2000, silenceMs: 5000 });
  for (let t = 0; t <= 3000; t += 1000) s.ingest(fr({ orig_id: "A", msg_id: 10 + t }), t);
  eq(s.getReport(10000).nodes[0].state, "silent");
  eq(s.getReport(30000).nodes[0].state, "silent");
});

test("a clock jump back is 'clock_reset' (not a reboot claim) and no false replay", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  for (let i = 0; i < 5; i++) s.ingest(fr({ orig_id: "A", msg_id: 1000 + i, time: 50000 + i * 100 }), i * 1000);
  s.ingest(fr({ orig_id: "A", msg_id: 2000, time: 200 }), 20000);
  const ev = s.getReport(20000).events.map((e) => e.kind);
  assert(ev.includes("clock_reset"), JSON.stringify(ev));
  assert(!ev.includes("replay"));
});

test("LEARNING: >= learnMinMsgs to adopt; a lone startup packet is flagged post-window", () => {
  const s = createSecurityMonitor({ learnWindowMs: 5000, learnMinMsgs: 2 });
  s.ingest(fr({ orig_id: "INJ", msg_id: 1 }), 0);
  assert(!s.getReport(100).events.some((e) => e.kind === "unknown_node"));
  s.ingest(fr({ orig_id: "R1", msg_id: 2 }), 100);
  s.ingest(fr({ orig_id: "R1", msg_id: 3 }), 200);
  s.getReport(6000);
  s.ingest(fr({ orig_id: "INJ", msg_id: 9 }), 7000);
  assert(s.getReport(7000).events.some((e) => e.kind === "unknown_node" && e.nodeId === "INJ"));
});

test("LEARNING: learning_complete fires once; warns if nothing was established", () => {
  let s = createSecurityMonitor({ learnWindowMs: 3000, learnMinMsgs: 2 });
  s.ingest(fr({ orig_id: "A", msg_id: 1 }), 0);
  s.ingest(fr({ orig_id: "A", msg_id: 2 }), 500);
  eq(s.getReport(1000).summary.mode, "learning");
  const r = s.getReport(5000);
  eq(r.summary.mode, "enforcing");
  eq(r.events.filter((e) => e.kind === "learning_complete").length, 1);
  s.getReport(9000);
  eq(s.getReport(9000).events.filter((e) => e.kind === "learning_complete").length, 1);

  s = createSecurityMonitor({ learnWindowMs: 1000, learnMinMsgs: 5 });
  s.ingest(fr({ orig_id: "Z", msg_id: 1 }), 0);
  const w = s.getReport(5000).events.find((e) => e.kind === "learning_complete");
  assert(w && w.severity === "medium");
});

test("replay fires after a real gap, NOT on an echo or a forwarded copy", () => {
  let s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", msg_id: 1 }), 0);
  s.ingest(fr({ orig_id: "A", msg_id: 1 }), 9000);
  assert(s.getReport(9000).events.some((e) => e.kind === "replay"), "gap");

  s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", msg_id: 2 }), 0);
  s.ingest(fr({ orig_id: "A", msg_id: 2 }), 40);
  assert(!s.getReport(40).events.some((e) => e.kind === "replay"), "echo");

  s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", fwd_id: "A", msg_id: 3, hops: 0 }), 0);
  s.ingest(fr({ orig_id: "A", fwd_id: "R", msg_id: 3, hops: 1 }), 8000);
  assert(!s.getReport(8000).events.some((e) => e.kind === "replay"), "forward");
});

test("flood: reported rate is the real magnitude, drains to 0, rate_spike fires", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], rateWindowMs: 10000, rateThresholdPerSec: 20 });
  for (let i = 0; i < 20000; i++) s.ingest(fr({ orig_id: "A", msg_id: 100000 + i }), Math.floor(i * 0.5));
  const r = s.getReport(10000);
  assert(r.events.some((e) => e.kind === "rate_spike"));
  assert(r.nodes[0].ratePerSec > 1500 && r.nodes[0].ratePerSec < 2100, `rate ${r.nodes[0].ratePerSec}`);
  eq(s.getReport(60000).nodes[0].ratePerSec, 0);
});

test("impossible payload values; rssi 0 is fine; state becomes 'suspect'", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", msg_id: 1, type: 3, d1: 99 }), 0);
  s.ingest(fr({ orig_id: "A", msg_id: 2, rssi: 0 }), 1);
  const r = s.getReport(1);
  eq(r.events.filter((e) => e.kind === "impossible_value").length, 1);
  assert(!r.events.some((e) => e.detail && e.detail.includes("rssi 0")));
  eq(r.nodes[0].state, "suspect");
});

test("staggered silence -> jamming, escalating on the 3rd node", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A", "B", "C"],
    minMsgsForSilence: 3,
    minSpanForSilence: 2000,
    silenceMs: 5000,
    jammingMinNodes: 2,
    jammingWindowMs: 20000,
  });
  for (let t = 0; t <= 3000; t += 1000) {
    for (const id of ["A", "B", "C"]) s.ingest(fr({ orig_id: id, msg_id: id.charCodeAt(0) * 1e4 + t }), t);
  }
  s.ingest(fr({ orig_id: "B", msg_id: 55555 }), 9000);
  s.ingest(fr({ orig_id: "C", msg_id: 66666 }), 9000);
  assert(s.getReport(15000).events.some((e) => e.kind === "jamming_suspected"));
  s.getReport(15100);
  const j = s.getReport(15200).events.filter((e) => e.kind === "jamming_suspected");
  assert(j[j.length - 1].detail.includes("3 nodes"), j[j.length - 1].detail);
});

test("a startup burst then a long pause is NOT silence (span guard)", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A", "B"],
    minMsgsForSilence: 5,
    minSpanForSilence: 10000,
    silenceMs: 20000,
  });
  for (let i = 0; i < 5; i++) {
    for (const id of ["A", "B"]) s.ingest(fr({ orig_id: id, msg_id: id.charCodeAt(0) * 1e4 + i }), i * 80);
  }
  const r = s.getReport(60000);
  assert(!r.events.some((e) => e.kind === "suspicious_silence"));
  assert(!r.events.some((e) => e.kind === "jamming_suspected"));
});

test("an established heartbeat, then silence, then recovery", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A"],
    minMsgsForSilence: 5,
    minSpanForSilence: 10000,
    silenceMs: 20000,
  });
  for (let t = 0; t <= 25000; t += 5000) s.ingest(fr({ orig_id: "A", msg_id: 1e4 + t }), t);
  assert(s.getReport(50000).events.some((e) => e.kind === "suspicious_silence"));
  s.ingest(fr({ orig_id: "A", msg_id: 99999 }), 51000);
  assert(s.getReport(51000).events.some((e) => e.kind === "node_recovered"));
  eq(s.getReport(51000).nodes[0].state, "ok");
});

test("clean traffic: green, all nodes ok, no medium+ events", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  for (let i = 0; i < 10; i++) s.ingest(fr({ orig_id: "A", msg_id: 500 + i }), i * 5000);
  const r = s.getReport(50000);
  eq(r.summary.threatLevel, "none");
  eq(r.nodes[0].state, "ok");
  assert(!r.events.some((e) => SEV[e.severity] >= 2));
});

test("state is independent of getReport() call frequency", () => {
  const mk = () => {
    const s = createSecurityMonitor({ knownNodes: ["A"] });
    s.ingest(fr({ orig_id: "A", msg_id: 1, type: 3, d1: 99 }), 0);
    return s;
  };
  const once = mk().getReport(30000).nodes[0].state;
  const often = mk();
  for (let t = 500; t <= 30000; t += 500) often.getReport(t);
  const many = often.getReport(30000).nodes[0].state;
  eq(once, many, "same state regardless of call rate");
  assert(once !== "suspect" && once !== "blocked", `flag expired -> ${once}`);
});

test("threatLevel reflects only recent events; the event stays in the feed", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], threatWindowMs: 10000 });
  s.ingest(fr({ orig_id: "ROGUE", msg_id: 1 }), 0);
  eq(s.getReport(1000).summary.threatLevel, "high");
  eq(s.getReport(20000).summary.threatLevel, "none");
  assert(s.getReport(20000).events.some((e) => e.kind === "unknown_node"));
});

test("a burst of one event collapses to a single row with a count", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], eventCooldownMs: 3000 });
  for (let i = 0; i < 5; i++) s.ingest(fr({ orig_id: "ROGUE", msg_id: i }), i * 100);
  const ev = s.getReport(500).events.filter((e) => e.kind === "unknown_node" && e.nodeId === "ROGUE");
  eq(ev.length, 1);
  assert(ev[0].count >= 2);
});

test("dedup stays correct when events for two ids interleave heavily", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], eventCooldownMs: 100000 });
  for (let i = 0; i < 100; i++) {
    s.ingest(fr({ orig_id: "R1", msg_id: i }), i * 10);
    s.ingest(fr({ orig_id: "R2", msg_id: 1000 + i }), i * 10 + 1);
  }
  const ev = s.getReport(2000).events.filter((e) => e.kind === "unknown_node");
  eq(ev.filter((e) => e.nodeId === "R1").length, 1);
  eq(ev.filter((e) => e.nodeId === "R2").length, 1);
});

test("id flood guard caps tracked nodes and raises id_flood", () => {
  const s = createSecurityMonitor({ maxNodes: 5 });
  for (let i = 0; i < 20; i++) s.ingest(fr({ orig_id: "N" + i, msg_id: i }), i);
  const r = s.getReport(20);
  eq(r.summary.nodes, 5);
  assert(r.events.some((e) => e.kind === "id_flood"));
});

test("getReport is idempotent at a fixed `now`", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  s.ingest(fr({ orig_id: "A", msg_id: 1, type: 3, d1: 99 }), 0);
  eq(JSON.stringify(s.getReport(1000)), JSON.stringify(s.getReport(1000)));
});

test("empty monitor returns a clean report", () => {
  const r = createSecurityMonitor().getReport(123456);
  eq(r.summary.threatLevel, "none");
  eq(r.nodes.length, 0);
  eq(r.events.length, 0);
  eq(r.summary.mode, "learning");
});

test("memory stays bounded under a 5000-message flood", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], msgIdHistoryMax: 200 });
  for (let i = 0; i < 5000; i++) s.ingest(fr({ orig_id: "A", msg_id: 1e6 + i }), i);
  s.getReport(5000);
});

test("nodes are sorted worst-state first", () => {
  const s = createSecurityMonitor({ knownNodes: ["A", "B"] });
  s.ingest(fr({ orig_id: "A", msg_id: 1 }), 0);
  s.ingest(fr({ orig_id: "Z", msg_id: 3 }), 0);
  eq(s.getReport(0).nodes[0].state, "blocked");
});

test("a silent node keeps its suspicious_silence flag past flagTtlMs", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A"],
    minMsgsForSilence: 3,
    minSpanForSilence: 2000,
    silenceMs: 5000,
    flagTtlMs: 8000,
  });
  for (let t = 0; t <= 3000; t += 1000) s.ingest(fr({ orig_id: "A", msg_id: 10 + t }), t);
  eq(s.getReport(10000).nodes[0].state, "silent");
  const r = s.getReport(30000); // 20s later — flag would have expired without the re-raise
  eq(r.nodes[0].state, "silent");
  assert(r.nodes[0].flags.includes("suspicious_silence"), JSON.stringify(r.nodes[0].flags));
});

test("jamming flag stays on the victims while the jamming condition holds", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A", "B"],
    minMsgsForSilence: 3,
    minSpanForSilence: 2000,
    silenceMs: 5000,
    jammingWindowMs: 60000,
  });
  for (let t = 0; t <= 3000; t += 1000) {
    s.ingest(fr({ orig_id: "A", msg_id: 1e4 + t }), t);
    s.ingest(fr({ orig_id: "B", msg_id: 2e4 + t }), t);
  }
  s.getReport(10000);
  const r = s.getReport(40000);
  assert(
    r.nodes.every((n) => n.flags.includes("jamming_suspected") && n.flags.includes("suspicious_silence")),
    JSON.stringify(r.nodes.map((n) => n.flags)),
  );
});

test("getReport is idempotent even mid-jamming", () => {
  const s = createSecurityMonitor({
    knownNodes: ["A", "B"],
    minMsgsForSilence: 3,
    minSpanForSilence: 2000,
    silenceMs: 5000,
    jammingWindowMs: 60000,
  });
  for (let t = 0; t <= 3000; t += 1000) {
    s.ingest(fr({ orig_id: "A", msg_id: 1e4 + t }), t);
    s.ingest(fr({ orig_id: "B", msg_id: 2e4 + t }), t);
  }
  eq(JSON.stringify(s.getReport(15000)), JSON.stringify(s.getReport(15000)));
});

test("a flood of unparseable lines with distinct bogus ids collapses to one row", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  for (let i = 0; i < 300; i++) s.ingest({ orig_id: "BOGUS_" + i }, i);
  const r = s.getReport(300);
  const ev = r.events.filter((e) => e.kind === "malformed");
  eq(ev.length, 1);
  assert(ev[0].count >= 200, `count ${ev[0].count}`);
  eq(r.summary.malformed, 300);
});

test("accidental double-ingest of the same line is not flagged as a replay", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"] });
  const line = fr({ orig_id: "A", msg_id: 777 });
  s.ingest(line, 0);
  s.ingest(line, 50);
  assert(!s.getReport(50).events.some((e) => e.kind === "replay"));
});

test("a silent node recovers to state 'ok' with no lingering flags", () => {
  const s = createSecurityMonitor({ knownNodes: ["A"], minMsgsForSilence: 3, minSpanForSilence: 2000, silenceMs: 5000 });
  for (let t = 0; t <= 3000; t += 1000) s.ingest(fr({ orig_id: "A", msg_id: 10 + t }), t);
  s.getReport(30000);
  s.ingest(fr({ orig_id: "A", msg_id: 9999 }), 31000);
  const r = s.getReport(31000);
  eq(r.nodes[0].state, "ok");
  eq(r.nodes[0].flags.length, 0);
  assert(r.events.some((e) => e.kind === "node_recovered"));
});
