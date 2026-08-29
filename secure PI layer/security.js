// security.js — attack/anomaly detection over the relay message stream (Pi side)
//
// Plain JavaScript, Deno- and Node-compatible, ZERO dependencies.
// Drop this file into the Pi repo. Feed it every parsed relay message; read
// getReport() whenever the display refreshes — any call rate is fine.
//
//   import { createSecurityMonitor } from "./security.js";
//   const sec = createSecurityMonitor({ knownNodes: ["9B05C4C0"] });
//   sec.ingest(msg);                 // for each line off the relay, after JSON.parse()
//   const report = sec.getReport();  // on your display tick
//
// Pure logic: no serial, no HTTP, no timers. ingest(msg, now?) / getReport(now?)
// take an optional ms timestamp (tests pass it; production omits it -> Date.now()).
// `now` is assumed monotonic. Flags expire on a wall clock, so behaviour does NOT
// depend on how often you call getReport().
//
// FEED EVERY MESSAGE, including type 0 (sync) and type 1 (ping) — those are how
// the monitor knows a node is still alive.
//
// Input — the relay's JSON, exactly as firmware logic.txt prints it:
//   { msg_id, orig_id, fwd_id, type, time, hops, d1, d2, rssi }
//   type: 0=time-sync 1=ping 2=distance-map 3=ALARM(vibration)
//   type 3:  d1 = magnitude (g)   d2 = bearing (deg 0..360, sensor frame)
//
// Detection only — it flags, it does not block. Two attacks are out of reach
// without a firmware auth tag: a forged packet that copies a real node's id and
// stays in range, and a replay re-sent with a fresh msg_id.

const RAW_DEFAULTS = {
  // --- node identity ---
  // Set knownNodes to the real ids (an allow-list). Empty => LEARNING mode: an id
  // is adopted after learnMinMsgs messages inside learnWindowMs, then anything new
  // is flagged. Learning mode trusts whatever it hears first — prefer knownNodes.
  knownNodes: [],
  learnWindowMs: 20000,
  learnMinMsgs: 2,

  // --- rate / flood (exact 1-second bucket counting) ---
  rateWindowMs: 10000,
  rateThresholdPerSec: 20, // normal peak is ~5/s per node

  // --- replay ---
  replayMemoryMs: 120000,
  msgIdHistoryMax: 512, // hard per-node cap (flood safety)
  meshEchoWindowMs: 1500, // a relayed/echoed copy arrives within this — not a replay

  // --- silence / jamming (one flat threshold, no cadence learning) ---
  silenceMs: 20000, // no message this long from an established node
  minMsgsForSilence: 5, // node must have sent at least this many ...
  minSpanForSilence: 10000, // ... over at least this long (kills the startup-burst false positive)
  staleMs: 12000, // shown as "stale" — informational, not a security event
  jammingWindowMs: 8000,
  jammingMinNodes: 2,

  // --- payload plausibility (the `types` list must track the firmware) ---
  plausible: {
    types: [0, 1, 2, 3],
    magMin: 0.05,
    magMax: 16.0, // ADXL345 in +-16g mode
    bearingMin: 0,
    bearingMax: 360,
    rssiMin: -120,
    rssiMax: 10,
    hopsMin: 0,
    hopsMax: 8,
  },

  // --- housekeeping ---
  flagTtlMs: 8000, // a flag stays live this long after its last trigger
  maxNodes: 128,
  eventCooldownMs: 3000, // repeats of the same (kind,node) collapse into a counter
  maxEvents: 200,
  threatWindowMs: 20000, // summary.threatLevel reflects only events this recent
};

const SEVERITY = { info: 0, low: 1, medium: 2, high: 3 };
const LEVELS = ["none", "low", "medium", "high"];

// Which live flags drive a node's state. (id_flood is a system event, never a node
// flag, so it is not listed here.)
const BLOCKING = new Set(["unknown_node", "replay", "rate_spike"]);
const SUSPECT = new Set(["impossible_value", "malformed"]);

export const DEFAULT_CONFIG = deepFreeze(structuredCloneSafe(RAW_DEFAULTS));

export function createSecurityMonitor(userConfig = {}) {
  const cfg = mergeConfig(RAW_DEFAULTS, userConfig);
  const winSec = Math.max(1, Math.round(cfg.rateWindowMs / 1000));
  const configuredKnown = cfg.knownNodes.map(String);
  const learningMode = configuredKnown.length === 0;

  let known = new Set(configuredKnown);
  let nodes = new Map();
  let events = [];
  let eventIndex = new Map(); // `${kind}:${nodeId}` -> event object (for O(1) dedup)
  let firstMsgAt = null;
  let ingestCount = 0;
  let malformedCount = 0;
  let learnClosed = !learningMode;

  function ingest(raw, now = Date.now()) {
    ingestCount++;
    if (firstMsgAt === null) firstMsgAt = now;

    const m = normalize(raw);
    if (!m) {
      malformedCount++;
      // nodeId: null on purpose — an unparseable line's id (if any) is attacker
      // controlled, so keying on it would let a flood of distinct bogus ids swamp
      // the feed. All parse failures collapse into one counted row.
      pushEvent(now, {
        kind: "malformed",
        severity: "low",
        nodeId: null,
        detail: "unparseable message or missing required fields",
      });
      return;
    }

    let node = nodes.get(m.nodeId);
    if (!node) {
      if (nodes.size >= cfg.maxNodes) {
        pushEvent(now, {
          kind: "id_flood",
          severity: "high",
          nodeId: null,
          detail: `more than ${cfg.maxNodes} distinct node ids — id flooding`,
        });
        return;
      }
      node = newNode(m.nodeId, now);
      nodes.set(m.nodeId, node);
    }

    checkIdentity(node, now);
    checkClockReset(node, m, now);
    checkPlausibility(node, m, now);
    checkForwarding(node, m, now);
    checkReplay(node, m, now);
    bumpRate(node, now);
    checkRate(node, m, now);

    // node returned after we had flagged it silent
    if (node.silenceEventSent) {
      pushEvent(now, {
        kind: "node_recovered",
        severity: "info",
        nodeId: m.nodeId,
        detail: "reporting again",
      });
      node.silenceEventSent = false;
      node.flags.delete("suspicious_silence");
      node.flags.delete("jamming_suspected");
    }

    node.count++;
    node.lastSeen = now;
    node.silentSince = null;
    node.jamCounted = false;
    node.lastType = m.type;
    if (m.type === 3) {
      if (m.mag != null) node.lastMag = m.mag;
      if (m.bearing != null) node.lastBearing = m.bearing;
    }
    if (m.rssi != null) node.lastRssi = m.rssi;
    if (m.hops != null) node.lastHops = m.hops;
  }

  function getReport(now = Date.now()) {
    // --- pass 1: update each node's state + silence/jamming flags ---
    const stateOf = new Map();
    for (const node of nodes.values()) {
      const since = node.lastSeen == null ? null : now - node.lastSeen;
      const live = liveFlags(node, now);
      let state = "ok";
      if (live.some((f) => BLOCKING.has(f))) state = "blocked";
      else if (live.some((f) => SUSPECT.has(f))) state = "suspect";
      else if (since != null && isEstablished(node) && since > cfg.silenceMs) state = "silent";
      else if (since != null && since > cfg.staleMs) state = "stale";
      stateOf.set(node, state);

      if (state === "silent") {
        if (node.silentSince == null) node.silentSince = now;
        raise(node, "suspicious_silence", now); // keep the flag live while silent
        if (!node.silenceEventSent) {
          node.silenceEventSent = true;
          pushEvent(now, {
            kind: "suspicious_silence",
            severity: "medium",
            nodeId: node.id,
            detail: `no message for ${Math.round(since / 1000)}s`,
          });
        }
      }
    }

    // correlated silence within the window => jamming
    const jamCut = now - cfg.jammingWindowMs;
    const silentInWindow = [];
    for (const node of nodes.values()) {
      if (node.silentSince != null && node.silentSince >= jamCut) silentInWindow.push(node);
    }
    if (silentInWindow.length >= cfg.jammingMinNodes) {
      const escalated = silentInWindow.some((n) => !n.jamCounted);
      for (const n of silentInWindow) {
        n.jamCounted = true;
        raise(n, "jamming_suspected", now); // keep the flag live while jamming holds
      }
      if (escalated) {
        pushEvent(now, {
          kind: "jamming_suspected",
          severity: "high",
          nodeId: null,
          detail: `${silentInWindow.length} nodes silent within ${cfg.jammingWindowMs / 1000}s: ${silentInWindow
            .map((n) => n.id)
            .join(", ")}`,
        });
      }
    }

    // --- pass 2: render rows with the now-current flags ---
    const nodeReports = [];
    for (const node of nodes.values()) {
      nodeReports.push({
        id: node.id,
        known: known.has(node.id),
        state: stateOf.get(node),
        flags: liveFlags(node, now),
        msgCount: node.count,
        ratePerSec: round2(ratePerSec(node, now)),
        lastSeenMsAgo: node.lastSeen == null ? null : now - node.lastSeen,
        lastType: node.lastType,
        lastMag: node.lastMag,
        lastBearing: node.lastBearing,
        lastRssi: node.lastRssi,
        lastHops: node.lastHops,
      });
    }

    nodeReports.sort((a, b) => rank(b.state) - rank(a.state) || cmp(a.id, b.id));

    if (
      learningMode &&
      !learnClosed &&
      firstMsgAt != null &&
      now - firstMsgAt > cfg.learnWindowMs
    ) {
      learnClosed = true;
      pushEvent(now, {
        kind: "learning_complete",
        severity: known.size ? "info" : "medium",
        nodeId: null,
        detail: known.size
          ? `known set locked: ${[...known].join(", ")}`
          : "learn window closed with no established nodes — set knownNodes",
      });
    }

    const liveCut = now - cfg.threatWindowMs;
    let worst = 0;
    for (const e of events) {
      if (e.lastTs >= liveCut) worst = Math.max(worst, SEVERITY[e.severity] ?? 0);
    }

    return {
      generatedAt: now,
      summary: {
        mode: !learningMode || (learnClosed && known.size > 0) ? "enforcing" : "learning",
        uptimeMs: firstMsgAt == null ? 0 : now - firstMsgAt,
        messages: ingestCount,
        malformed: malformedCount,
        nodes: nodes.size,
        knownNodes: known.size,
        blocked: nodeReports.filter((n) => n.state === "blocked").length,
        threatLevel: LEVELS[worst],
        eventCount: events.length,
      },
      nodes: nodeReports,
      events: events.slice(-cfg.maxEvents).map((e) => ({ ...e })),
    };
  }

  function reset() {
    known = new Set(configuredKnown);
    nodes = new Map();
    events = [];
    eventIndex = new Map();
    firstMsgAt = null;
    ingestCount = 0;
    malformedCount = 0;
    learnClosed = !learningMode;
  }

  // ---------------------------------------------------------------- checks
  function checkIdentity(node, now) {
    if (learningMode) {
      if (known.has(node.id)) return;
      const windowOpen = firstMsgAt != null && now - firstMsgAt <= cfg.learnWindowMs;
      if ((windowOpen || known.size === 0) && node.count + 1 >= cfg.learnMinMsgs) {
        known.add(node.id);
        pushEvent(now, {
          kind: "node_learned",
          severity: "info",
          nodeId: node.id,
          detail: `adopted after ${node.count + 1} messages`,
        });
        return;
      }
      if (windowOpen || known.size === 0) return; // unproven candidate, don't flag yet
    }
    if (known.has(node.id)) return;
    raise(node, "unknown_node", now);
    pushEvent(now, {
      kind: "unknown_node",
      severity: "high",
      nodeId: node.id,
      detail: "id not in the known-nodes set",
    });
  }

  function checkClockReset(node, m, now) {
    if (m.time == null) return;
    const prev = node.lastTime;
    node.lastTime = m.time;
    if (prev == null) return;
    // synced `time` jumping back hard: a reboot, or a re-sync to a rebooted hub.
    // Either way our time/msg_id replay heuristics can't trust history — reset it.
    if (prev - m.time > cfg.silenceMs) {
      node.seenMsgs.clear();
      node.rate.length = 0;
      pushEvent(now, {
        kind: "clock_reset",
        severity: "info",
        nodeId: m.nodeId,
        detail: `synced time jumped back ${Math.round(prev - m.time)}ms (reboot or re-sync)`,
      });
    }
  }

  function checkPlausibility(node, m, now) {
    const bad = implausible(m, cfg.plausible);
    if (!bad) return;
    raise(node, "impossible_value", now);
    pushEvent(now, { kind: "impossible_value", severity: "medium", nodeId: m.nodeId, detail: bad });
  }

  function checkForwarding(node, m, now) {
    if (m.hops == null || m.fwdId == null) return;
    const relayed = m.hops > 0;
    const fwdDiffers = m.fwdId !== m.nodeId;
    if (relayed === fwdDiffers) return;
    raise(node, "malformed", now);
    pushEvent(now, {
      kind: "malformed",
      severity: "low",
      nodeId: m.nodeId,
      detail: `hops=${m.hops} but fwd_id ${fwdDiffers ? "differs from" : "equals"} orig_id`,
    });
  }

  function checkReplay(node, m, now) {
    if (m.msgId == null) return;
    const h = m.hops ?? 0;
    const prev = node.seenMsgs.get(m.msgId);
    if (prev) {
      const dt = now - prev.firstTs;
      const forwardCopy = h > prev.minHops;
      const meshEcho = dt >= 0 && dt <= cfg.meshEchoWindowMs;
      if (!forwardCopy && !meshEcho) {
        raise(node, "replay", now);
        pushEvent(now, {
          kind: "replay",
          severity: "high",
          nodeId: m.nodeId,
          detail: `msg_id ${m.msgId} re-seen after ${Math.round(dt / 1000)}s at hops ${h} (first at ${prev.minHops})`,
        });
      }
      prev.minHops = Math.min(prev.minHops, h);
      return;
    }
    node.seenMsgs.set(m.msgId, { firstTs: now, minHops: h });
    const cut = now - cfg.replayMemoryMs;
    for (const [k, v] of node.seenMsgs) {
      if (v.firstTs < cut) node.seenMsgs.delete(k);
      else break;
    }
    while (node.seenMsgs.size > cfg.msgIdHistoryMax) {
      node.seenMsgs.delete(node.seenMsgs.keys().next().value);
    }
  }

  function checkRate(node, m, now) {
    const rps = ratePerSec(node, now);
    if (rps <= cfg.rateThresholdPerSec) return;
    raise(node, "rate_spike", now);
    pushEvent(now, {
      kind: "rate_spike",
      severity: "high",
      nodeId: m.nodeId,
      detail: `${rps.toFixed(1)} msg/s (threshold ${cfg.rateThresholdPerSec})`,
    });
  }

  // ---------------------------------------------------------------- helpers (closure)
  function isEstablished(node) {
    return (
      node.count >= cfg.minMsgsForSilence &&
      node.lastSeen != null &&
      node.lastSeen - node.firstSeen >= cfg.minSpanForSilence
    );
  }

  function raise(node, kind, now) {
    node.flags.set(kind, now + cfg.flagTtlMs);
  }

  function liveFlags(node, now) {
    const out = [];
    for (const [k, exp] of node.flags) {
      if (exp > now) out.push(k);
      else node.flags.delete(k);
    }
    return out;
  }

  function bumpRate(node, now) {
    const sec = Math.floor(now / 1000);
    const r = node.rate;
    if (r.length && r[r.length - 1].sec === sec) r[r.length - 1].n++;
    else r.push({ sec, n: 1 });
    const floorSec = sec - winSec;
    while (r.length && r[0].sec <= floorSec) r.shift();
  }

  function ratePerSec(node, now) {
    const floorSec = Math.floor(now / 1000) - winSec;
    const r = node.rate;
    while (r.length && r[0].sec <= floorSec) r.shift();
    let n = 0;
    for (const b of r) n += b.n;
    return n / winSec;
  }

  function pushEvent(ts, ev) {
    const key = `${ev.kind}:${ev.nodeId ?? "-"}`;
    const cur = eventIndex.get(key);
    if (cur && ts - cur.lastTs < cfg.eventCooldownMs) {
      cur.count++;
      cur.lastTs = ts;
      cur.detail = ev.detail;
      if ((SEVERITY[ev.severity] ?? 0) > (SEVERITY[cur.severity] ?? 0)) cur.severity = ev.severity;
      return;
    }
    const e = { ts, lastTs: ts, count: 1, ...ev };
    events.push(e);
    eventIndex.set(key, e);
    if (events.length > cfg.maxEvents * 2) {
      events = events.slice(-cfg.maxEvents);
      eventIndex = new Map();
      for (const x of events) eventIndex.set(`${x.kind}:${x.nodeId ?? "-"}`, x);
    }
  }

  const frozenConfig = deepFreeze(structuredCloneSafe(cfg));
  return {
    ingest,
    getReport,
    reset,
    get config() {
      return frozenConfig;
    },
    get knownNodes() {
      return [...known];
    },
  };
}

// -------------------------------------------------------------------- module helpers

const STATE_RANK = { ok: 0, stale: 1, silent: 2, suspect: 3, blocked: 4 };
const rank = (s) => STATE_RANK[s] ?? 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function newNode(id, now) {
  return {
    id,
    firstSeen: now,
    lastSeen: null,
    lastTime: null,
    count: 0,
    rate: [], // [{ sec, n }]
    seenMsgs: new Map(), // msg_id -> { firstTs, minHops }
    flags: new Map(), // kind -> expiry ts
    lastType: null,
    lastMag: null,
    lastBearing: null,
    lastRssi: null,
    lastHops: null,
    silentSince: null,
    silenceEventSent: false,
    jamCounted: false,
  };
}

/** Map the relay JSON (or a reshaped variant) to the monitor's internal shape. */
export function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const nodeId = strOrNull(raw.orig_id ?? raw.nodeId ?? raw.node_id);
  const msgId = numOrNull(raw.msg_id ?? raw.msgId);
  if (nodeId == null || msgId == null) return null;
  return {
    nodeId,
    msgId,
    fwdId: strOrNull(raw.fwd_id ?? raw.fwdId ?? raw.forwarder_id),
    type: numOrNull(raw.type ?? raw.datatype),
    time: numOrNull(raw.time ?? raw.timestamp),
    hops: numOrNull(raw.hops ?? raw.hop_count),
    mag: numOrNull(raw.d1 ?? raw.mag ?? raw.magnitude),
    bearing: numOrNull(raw.d2 ?? raw.bearing ?? raw.angle),
    rssi: numOrNull(raw.rssi),
  };
}

function implausible(m, p) {
  if (m.type != null && !p.types.includes(m.type)) return `unknown type ${m.type}`;
  if (m.rssi != null && (m.rssi < p.rssiMin || m.rssi > p.rssiMax)) {
    return `rssi ${m.rssi} out of [${p.rssiMin},${p.rssiMax}]`;
  }
  if (m.hops != null && (m.hops < p.hopsMin || m.hops > p.hopsMax)) {
    return `hops ${m.hops} out of [${p.hopsMin},${p.hopsMax}]`;
  }
  if (m.type === 3) {
    if (m.mag != null && (m.mag < p.magMin || m.mag > p.magMax)) {
      return `magnitude ${m.mag}g out of [${p.magMin},${p.magMax}]`;
    }
    if (m.bearing != null && (m.bearing < p.bearingMin || m.bearing > p.bearingMax)) {
      return `bearing ${m.bearing} out of [${p.bearingMin},${p.bearingMax}]`;
    }
  }
  return null;
}

function mergeConfig(base, over) {
  const out = structuredCloneSafe(base);
  for (const k of Object.keys(over)) {
    if (k === "plausible" && over.plausible && typeof over.plausible === "object") {
      out.plausible = { ...out.plausible, ...over.plausible };
      if (over.plausible.types) out.plausible.types = [...over.plausible.types];
    } else if (k === "knownNodes") {
      out.knownNodes = [...(over.knownNodes ?? [])];
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function structuredCloneSafe(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === "object") deepFreeze(obj[k]);
  }
  return Object.freeze(obj);
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const strOrNull = (v) => (v == null ? null : String(v));
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
