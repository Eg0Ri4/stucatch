// security.js
// =============================================================================
// Mesh security monitor for the Pi side. Written against the v4 wire format that
// the firmware (logicv6) prints over serial.
//
// Luca, this is the piece I said I'd send. You give me the raw JSON lines
// exactly as they come off the socket, one at a time, and I keep a running
// picture of what looks wrong on the mesh. It is detection only. Our firmware
// doesn't sign or encrypt anything, so I can tell you when a frame smells like
// an injection, a replay, or jamming, but I cannot stop it. That's a limit of
// the prototype and we should say it out loud, not hide it.
//
// -----------------------------------------------------------------------------
// How you use it
// -----------------------------------------------------------------------------
//
//   import { createSecurityMonitor } from "./security.js";
//
//   const sec = createSecurityMonitor();          // defaults are fine
//
//   // wherever you already handle a line off the serial socket:
//   sec.ingest(rawLine);
//
//   // whenever you redraw the dashboard, as often or as rarely as you want:
//   const report = sec.getReport();
//
// Two things about calling it:
//
//   1. I use the time you call me, not any timestamp inside the message. The
//      firmware's `stamped` field drifts and resets on reboot, so I ignore it
//      for timing and use wall-clock arrival instead.
//
//   2. getReport() is not read-only. It re-checks which nodes have gone silent
//      and whether that looks like jamming, because those are things you only
//      know by looking at the clock. So call it on a steady tick (once a second
//      is plenty) even on frames where you don't actually repaint.
//
// Both ingest() and getReport() take an optional timestamp in milliseconds as
// the last argument. Leave it out in real use. It only exists so the tests can
// run a fake clock.
//
// -----------------------------------------------------------------------------
// Things I decided on purpose
// -----------------------------------------------------------------------------
//
//   - It never throws. A line I can't parse comes back as a "malformed" event
//     and the monitor keeps running. If ingest() ever throws in your process,
//     that's a bug on my side, tell me.
//
//   - No dependencies. No timers, no file or network access, no module-level
//     mutable state. Everything lives on the object createSecurityMonitor()
//     hands back, so reset() or a fresh instance gives you a clean slate.
//
//   - Every check is a few lines and you can read what it does. No statistics,
//     no graph analysis, no learning models. We don't have the time and the
//     prototype doesn't need them. If one check turns out noisy in the field,
//     switch it off in the config (`checks.<name> = false`) without touching
//     code.
//
//   - Memory is bounded. A flood of junk frames can't grow the tables forever:
//     the node table has a hard cap and evicts the least-recently-heard, the
//     event log is a small ring.
//
// -----------------------------------------------------------------------------
// What it looks for
// -----------------------------------------------------------------------------
//
//   unknown_node   an origin id I never saw during the learn window
//   replay         an old (origin, seq) frame turning up again, not explained
//                  by the firmware's own 3x alarm resend or a relay copy
//   rate_spike     a single node talking far faster than it should
//   id_flood       more distinct origins than a real deployment would have
//   impossible     a field outside what the hardware can physically produce
//   malformed      a line I couldn't parse, or one that doesn't match its kind
//   silent         a node that had a real heartbeat and then went quiet
//   jamming        two or more nodes going silent close together in time
//   rogue_sync     a SYNC frame from something that isn't the hub (the firmware
//                  says exactly one board mints SYNC; a second one is a rogue
//                  time authority)
//   node_reboot    a status frame whose boot count jumped or uptime fell, or a
//                  fresh boot log line (info only, and it suppresses a false
//                  replay right after)
// =============================================================================

/**
 * @typedef {Object} MonitorConfig
 * @property {number} learnWindowMs   grace period where every new origin is just learned
 * @property {number} silenceMs       quiet longer than this and a node is "silent"
 * @property {number} jammingWindowMs nodes going silent within this span count as jamming
 * @property {number} jammingMinNodes how many silent nodes it takes to call it jamming
 * @property {number} ratePerSec      messages/second from one origin above this is a spike
 * @property {number} maxNodes        hard cap on tracked origins
 * @property {number} resendWindowMs  a repeated/old seq inside this window is a resend, not a replay
 * @property {number} reorderSlack    how many seq behind still counts as harmless reordering
 * @property {number} rebootSilenceMs silence this long means the next frame may have any seq
 * @property {number} flagTtlMs       how long a raised flag stays "active" on a node
 * @property {{hops:number[],rssi:number[],mag:number[],bearing:number[]}} limits physical ranges
 * @property {Record<string, boolean>} checks per-check on/off switches
 */

/** Default tuning. Pass a partial object to createSecurityMonitor to override. */
export const DEFAULT_CONFIG = deepFreeze({
  // While we're inside this window from the first message, every origin I see is
  // adopted quietly. After it, a brand new origin is marked not-known and stays
  // that way until reset. 40s so a relay's first 30s status heartbeat lands
  // inside it; if you want a tighter window, pass knownNodes instead.
  learnWindowMs: 40000,

  // If you actually know the real node ids, list them here (hex strings, any
  // case) and they're trusted from the start regardless of the learn window.
  // Leave it empty and I just learn whatever shows up first.
  knownNodes: [],

  // A SENSOR quiet longer than this is "silent". Sensors ping every 5s, so ~20s
  // of nothing means several missed in a row.
  silenceMs: 20000,

  // Same idea for the hub and relays, but their own origin only shows up in the
  // 30s status heartbeat (the hub does not print its own SYNC, a relay forwards
  // other nodes' frames under their origin, not its own). So they need a longer
  // fuse or they'd flap silent/recovered every cycle.
  heartbeatSilenceMs: 75000,

  // If two or more nodes fall silent within this span of each other, I stop
  // calling it bad luck and call it jamming.
  jammingWindowMs: 8000,
  jammingMinNodes: 2,

  // Messages per second from one origin above this is a spike. Normal is ~1/s;
  // an alarm burst (3x resend) multiplied by two relays can briefly approach a
  // dozen for one origin, so the threshold sits well clear of that.
  ratePerSec: 25,

  // More distinct origins than this and something is minting fake ids.
  maxNodes: 24,

  // The firmware resends an alarm 3 times across ~1s and relays rebroadcast, so
  // a repeated or slightly-behind seq inside this window is expected (resend,
  // relay copy, mild reordering). Outside it, an old seq is a replay.
  resendWindowMs: 6000,
  // How many seq behind still counts as an in-flight copy rather than a replay.
  // A node's worst realistic burst is an alarm (1 seq, 3x) + a range reply + a
  // ping inside ~1s, so a lagging relay copy is at most a few seq stale; 8 keeps
  // margin. A replay attack resurfaces something far older than that.
  reorderSlack: 8,

  // Hear nothing from a node for this long and its next frame may carry any seq
  // because it almost certainly rebooted with a fresh random one. Matches
  // SEEN_AGE_MS in the firmware.
  rebootSilenceMs: 60000,

  // After a reboot is spotted (status boots jump, or a boot log line), don't
  // apply the replay check for this long — a straggler frame from just before
  // the reboot would otherwise look like a replayed old seq.
  rebootGraceMs: 8000,

  // A raised flag stays "active" on a node for this long after it last fired,
  // then the node clears on its own.
  flagTtlMs: 8000,

  // Plausible ranges for the physical fields. Outside these is "impossible".
  // No rssi range on purpose: RSSI scaling differs between ESP cores (some report
  // it already negative in dBm, some raw), and a weird rssi isn't an attack
  // signal anyway, so range-checking it just invites false positives.
  // hops assumes the firmware's MAX_HOPS=2; mag assumes the ADXL is in +-16g
  // (max possible delta ~55g).
  limits: {
    hops: [0, 8],
    mag: [0, 60],
    bearing: [0, 360],
  },

  // Flip any of these to false if a check gets noisy. All on by default.
  checks: {
    unknown_node: true,
    replay: true,
    rate_spike: true,
    id_flood: true,
    impossible: true,
    malformed: true,
    silent: true,
    jamming: true,
    rogue_sync: true,
    node_reboot: true,
  },
});

const HEX_ID = /^[0-9a-fA-F]{1,8}$/;
const KINDS = { 0: "sync", 1: "ping", 2: "range", 3: "alarm", 4: "status" };
const ROLES = { 0: "hub", 1: "sensor", 2: "relay" };
const SEV_RANK = { info: 0, low: 1, medium: 2, high: 3 };

const isInt = (n) => typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const isHexId = (s) => typeof s === "string" && HEX_ID.test(s);
const normId = (s) => String(s).toUpperCase();

/**
 * uint16 wraparound-aware "is `a` newer than `b`?". Same test the firmware's
 * witness() uses: (int16_t)(a - b) > 0.
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function seqIsNewer(a, b) {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/**
 * Turn one raw serial line into something I can reason about. Never throws.
 * @param {*} rawLine
 * @returns {{ok:false,reason:string} | {ok:true,type:"log",ev:string,id:string|null,t:number|null,role:number|null} | {ok:true,type:"data",kind:number,kindName:string,origin:string,seq:number,hops:number,via:string|null,rssi:number|null,stamped:number|null,epoch:number|null,payload:Object}}
 */
export function normalize(rawLine) {
  // Accept a string (the normal case) or raw bytes off a socket — a Buffer is a
  // Uint8Array too, so this covers both. Anything else stringifies and will fail
  // the JSON parse below, which is fine.
  if (rawLine instanceof Uint8Array) {
    try {
      rawLine = new TextDecoder().decode(rawLine);
    } catch {
      /* leave it; the parse will reject it */
    }
  }
  const text = String(rawLine == null ? "" : rawLine).trim();
  if (text === "") return { ok: false, reason: "empty line" };

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "not an object" };
  }

  // ---- log line: {"type":"log","ev":"...","id":"HEX","t":N, ...} ----
  if (obj.type === "log") {
    if (typeof obj.ev !== "string") return { ok: false, reason: "log line without ev" };
    return {
      ok: true,
      type: "log",
      ev: obj.ev,
      id: isHexId(obj.id) ? normId(obj.id) : null,
      t: isInt(obj.t) ? obj.t : null,
      // boot lines carry the role; nothing else in a log line matters to me
      role: isInt(obj.role) ? obj.role : null,
    };
  }

  // ---- data line: {"v":4,"kind":K,"origin":"HEX","seq":N,...} ----
  if (obj.v !== 4) return { ok: false, reason: `unexpected protocol v=${JSON.stringify(obj.v)}` };
  if (typeof obj.kind !== "number" || !(obj.kind in KINDS)) {
    return { ok: false, reason: `bad kind ${JSON.stringify(obj.kind)}` };
  }
  if (!isHexId(obj.origin)) return { ok: false, reason: "bad origin" };
  if (!isInt(obj.seq) || obj.seq < 0 || obj.seq > 0xffff) return { ok: false, reason: "bad seq" };
  if (!isInt(obj.hops) || obj.hops < 0) return { ok: false, reason: "bad hops" };

  const out = {
    ok: true,
    type: "data",
    kind: obj.kind,
    kindName: KINDS[obj.kind],
    origin: normId(obj.origin),
    seq: obj.seq,
    hops: obj.hops,
    via: isHexId(obj.via) ? normId(obj.via) : null,
    rssi: isInt(obj.rssi) ? obj.rssi : null, // absent on a node's own local print
    stamped: isInt(obj.stamped) ? obj.stamped : null,
    epoch: isInt(obj.epoch) ? obj.epoch : null,
    // Payload fields land here. I keep bad/missing ones as null rather than
    // rejecting the whole line, so the node still gets tracked (silence, rate,
    // etc. keep working) while the impossible/malformed check flags the gap.
    payload: {},
  };

  if (obj.kind === 0) {
    out.payload.authority = isInt(obj.authority) ? obj.authority : null;
  } else if (obj.kind === 2) {
    out.payload.peer = isHexId(obj.peer) ? normId(obj.peer) : null;
    out.payload.peerRssi = isInt(obj.peerRssi) ? obj.peerRssi : null;
  } else if (obj.kind === 3) {
    out.payload.mag = isNum(obj.mag) ? obj.mag : null;
    out.payload.bearing = isNum(obj.bearing) ? obj.bearing : null;
  } else if (obj.kind === 4) {
    for (const f of ["fw", "role", "boots", "up", "syncAge", "tx", "rx", "drop"]) {
      out.payload[f] = isInt(obj[f]) ? obj[f] : null;
    }
    out.payload.roleName = ROLES[obj.role] || "unknown";
  }

  return out;
}

/**
 * Make a monitor. Feed it lines with ingest(), read it with getReport().
 * @param {Partial<MonitorConfig>} [userConfig]
 */
export function createSecurityMonitor(userConfig = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, userConfig || {});
  const knownSet = new Set((Array.isArray(config.knownNodes) ? config.knownNodes : []).map(normId));

  const state = {
    startedAt: null, // ms, set on the first ingest
    nodes: new Map(), // originHex -> node record
    rate: new Map(), // originHex -> { sec, count } for the current 1s bucket
    hubId: null, // the origin that mints SYNC / reports role 0
    events: [], // newest first, small ring
    floodedAt: null, // last time id_flood fired
    jammedAt: null, // last time jamming fired
    originsEverSeen: 0, // distinct origins ever created, incl. ones later evicted
    counters: {
      lines: 0, data: 0, log: 0, malformed: 0, impossible: 0,
      replay: 0, rateSpike: 0, evicted: 0,
    },
  };

  const clock = (now) => (typeof now === "number" ? now : Date.now());

  // ---- node table with a hard cap -----------------------------------------
  function node(id, now) {
    let n = state.nodes.get(id);
    if (n) return n;

    if (state.nodes.size >= config.maxNodes) {
      // full: evict the least-recently-heard, but prefer an untrusted node so a
      // spoof-id flood can't push a real (learned or listed) node out of the
      // table — a flood is all untrusted, so a trusted node is only sacrificed
      // if literally everything in the table is trusted.
      let looseId = null, looseAt = Infinity;
      let trustedId = null, trustedAt = Infinity;
      for (const [k, v] of state.nodes) {
        if (v.known === true) {
          if (v.lastSeen < trustedAt) { trustedAt = v.lastSeen; trustedId = k; }
        } else if (v.lastSeen < looseAt) {
          looseAt = v.lastSeen;
          looseId = k;
        }
      }
      const victimId = looseId !== null ? looseId : trustedId;
      if (victimId !== null) {
        state.nodes.delete(victimId);
        state.rate.delete(victimId);
        state.counters.evicted++;
      }
    }

    state.originsEverSeen++;
    n = {
      id,
      firstSeen: now,
      lastSeen: now,
      msgCount: 0,
      known: knownSet.has(id) ? true : null, // true = trusted, false = flagged, null = undecided
      role: null,
      roleName: "unknown",
      lastKind: null,
      lastRssi: null,
      lastHops: null,
      lastEpoch: null,
      lastStatus: null, // { boots, up, syncAge, tx, rx, drop, at }
      steady: false, // has it shown a real heartbeat yet
      maxSeq: null, // highest seq accepted (wraparound-aware)
      maxSeqAt: now,
      rebootGraceUntil: 0,
      silentSince: null, // set by getReport when it first notices silence
      flags: new Map(), // flagName -> last raised ts
    };
    state.nodes.set(id, n);
    return n;
  }

  // ---- event log with per-(kind,node) folding ---------------------------
  function raise(kind, severity, nodeId, detail, now) {
    const hit = state.events.find((e) => e.kind === kind && e.node === nodeId);
    if (hit) {
      hit.count++;
      hit.lastTs = now;
      if (detail) hit.detail = detail;
    } else {
      state.events.unshift({
        kind,
        severity,
        node: nodeId || null,
        detail: detail || "",
        ts: now,
        lastTs: now,
        count: 1,
      });
      if (state.events.length > 50) state.events.pop();
    }
    if (nodeId) {
      const n = state.nodes.get(nodeId);
      if (n) n.flags.set(kind, now);
    }
  }

  // ---- seq bookkeeping + replay decision -------------------------------
  function advanceSeq(n, seq, now) {
    if (n.maxSeq === null || seqIsNewer(seq, n.maxSeq)) {
      n.maxSeq = seq;
      n.maxSeqAt = now;
    }
  }

  // returns "ok" | "replay" | "reboot". Also updates the seq bookkeeping.
  function replayVerdict(n, seq, hops, now) {
    if (n.maxSeq === null) {
      n.maxSeq = seq;
      n.maxSeqAt = now;
      return "ok";
    }
    // right after a reboot, or after a long silence, a low/odd seq is expected
    if (now < n.rebootGraceUntil) {
      advanceSeq(n, seq, now);
      return "ok";
    }
    if (now - n.lastSeen > config.rebootSilenceMs) {
      n.maxSeq = seq;
      n.maxSeqAt = now;
      n.rebootGraceUntil = now + config.rebootGraceMs;
      return "reboot";
    }
    if (seqIsNewer(seq, n.maxSeq)) {
      n.maxSeq = seq;
      n.maxSeqAt = now;
      return "ok";
    }
    if (seq === n.maxSeq) return "ok"; // the 3x resend, or a relay copy of the current frame

    // seq is genuinely behind the max. hops is the tell:
    //  - a real relayed copy has hops 1..2 (MAX_HOPS), took a longer path, and
    //    can lag a few seq; forgive that inside the resend window. hops beyond
    //    that isn't a real relay copy — an attacker can't hide a replay by
    //    stamping a big hop count on it.
    //  - a direct frame (hops 0) that's behind has no honest reason to be. The
    //    direct path doesn't drop ordering by more than about one, so anything
    //    further back is a captured frame being re-injected.
    const behind = (n.maxSeq - seq) & 0xffff;
    const inWindow = now - n.maxSeqAt <= config.resendWindowMs;
    if (inWindow && hops >= 1 && hops <= 3 && behind <= config.reorderSlack) return "ok";
    if (inWindow && hops === 0 && behind <= 1) return "ok";
    return "replay";
  }

  // ---- physical range check -----------------------------------------------
  function checkRanges(msg) {
    const L = config.limits;
    if (msg.hops < L.hops[0] || msg.hops > L.hops[1]) return `hops ${msg.hops}`;
    if (msg.epoch !== null && (msg.epoch < 0 || msg.epoch > 0xffff)) return `epoch ${msg.epoch}`;

    if (msg.kind === 0 && msg.payload.authority === null) return "sync payload missing";
    if (msg.kind === 2 && (msg.payload.peer === null || msg.payload.peerRssi === null)) {
      return "range payload missing";
    }
    if (msg.kind === 3) {
      if (msg.payload.mag === null || msg.payload.bearing === null) return "alarm payload missing";
      if (msg.payload.mag < L.mag[0] || msg.payload.mag > L.mag[1]) return `mag ${msg.payload.mag}`;
      if (msg.payload.bearing < L.bearing[0] || msg.payload.bearing > L.bearing[1]) {
        return `bearing ${msg.payload.bearing}`;
      }
    }
    if (msg.kind === 4) {
      for (const f of ["fw", "role", "boots", "up", "syncAge", "tx", "rx", "drop"]) {
        if (msg.payload[f] === null) return `status missing ${f}`;
      }
      if (msg.payload.role < 0 || msg.payload.role > 2) return `role ${msg.payload.role}`;
    }
    return null;
  }

  // ---- ingest ---------------------------------------------------------------
  function ingest(rawLine, now) {
    const t = clock(now);
    if (state.startedAt === null) state.startedAt = t;
    state.counters.lines++;

    let msg;
    try {
      msg = normalize(rawLine);
    } catch {
      // normalize is not supposed to throw. If it ever does I still refuse to
      // take Luca's process down over one bad line.
      state.counters.malformed++;
      if (config.checks.malformed) raise("malformed", "low", null, "parser crashed", t);
      return { ok: false, reason: "parser crashed" };
    }

    if (!msg.ok) {
      state.counters.malformed++;
      if (config.checks.malformed) raise("malformed", "low", null, msg.reason, t);
      return { ok: false, reason: msg.reason };
    }

    if (msg.type === "log") {
      state.counters.log++;
      handleLog(msg, t);
      return { ok: true, type: "log" };
    }

    state.counters.data++;
    handleData(msg, t);
    return { ok: true, type: "data" };
  }

  function handleLog(msg, t) {
    if (!msg.id) return;
    const n = node(msg.id, t);
    n.lastSeen = t; // a log line still proves the board is powered and talking
    // a board printing our own log format on our own serial is ours; adopt it
    // if it turns up during the learn window
    if (n.known === null && t - state.startedAt < config.learnWindowMs) n.known = true;

    if (msg.ev === "boot") {
      if (isInt(msg.role)) {
        n.role = msg.role;
        n.roleName = ROLES[msg.role] || "unknown";
        if (msg.role === 0 && state.hubId === null) state.hubId = msg.id;
      }
      if (config.checks.node_reboot) {
        // a fresh boot: don't let a pre-reboot seq look like a replay for a bit
        n.rebootGraceUntil = t + config.rebootGraceMs;
        n.maxSeq = null;
        raise("node_reboot", "info", msg.id, "boot line", t);
      }
    }
  }

  function handleData(msg, t) {
    const n = node(msg.origin, t);
    const learning = t - state.startedAt < config.learnWindowMs;
    const firstTime = n.msgCount === 0;
    // over the node cap => fold per-origin unknowns into one row (ring hygiene),
    // whether or not the id_flood check itself is enabled
    const overCap = state.originsEverSeen > config.maxNodes;
    const rangeBad = checkRanges(msg); // computed once, used by impossible + status-adopt

    // The board wired to our serial prints its own status with no rssi field
    // (RSSI_SELF in the firmware). An RF-injected frame always carries a real
    // rssi, so a rssi-less status can only be our own gateway — trust it, even
    // if it first showed up after the learn window closed.
    if (msg.kind === 4 && msg.rssi === null && n.known === null) n.known = true;

    // A complete, role-valid status frame is a much stronger "I'm a real node"
    // signal than a ping. Adopt on it for a while past the ping learn window: a
    // dedicated relay only heartbeats every 30s, so if the monitor started a bit
    // before the mesh its first status can land just after the window. Not while
    // a flood is in progress.
    if (
      firstTime && n.known === null && !overCap && msg.kind === 4 && rangeBad === null &&
      t - state.startedAt < config.learnWindowMs * 2
    ) {
      n.known = true;
    }

    // ---- reboot signal from a STATUS frame ----
    // This runs BEFORE replay on purpose: a rebooted node comes back with a
    // fresh random seq, and if we checked replay first that low seq would look
    // like an old frame resurfacing. Seeing boots go up / uptime fall first lets
    // us clear the seq history and set a short grace window.
    if (config.checks.node_reboot && msg.kind === 4 && n.lastStatus) {
      const p = msg.payload;
      const rebooted =
        (isInt(p.boots) && isInt(n.lastStatus.boots) && p.boots > n.lastStatus.boots) ||
        (isInt(p.up) && isInt(n.lastStatus.up) && p.up + 5 < n.lastStatus.up);
      if (rebooted) {
        n.rebootGraceUntil = t + config.rebootGraceMs;
        n.maxSeq = null;
        raise("node_reboot", "info", msg.origin, `boots ${n.lastStatus.boots} -> ${p.boots}`, t);
      }
    }

    // ---- unknown node ----
    // Decide "known or not" once, on the first frame, and make it stick: an
    // unknown node that keeps transmitting stays flagged, it doesn't quietly
    // recover after the flag TTL. During an id flood I fold the per-origin
    // unknowns into one row so hundreds of them don't blow the event ring.
    if (firstTime && n.known === null) {
      if (learning) {
        n.known = true;
      } else {
        n.known = false;
        if (config.checks.unknown_node) {
          if (overCap) raise("unknown_node", "high", null, "new ids arriving during a flood", t);
          else raise("unknown_node", "high", msg.origin, "id not seen during learn window", t);
        }
      }
    }

    // ---- rate spike ----
    if (config.checks.rate_spike) {
      const sec = Math.floor(t / 1000);
      let b = state.rate.get(msg.origin);
      if (!b || b.sec !== sec) {
        b = { sec, count: 0 };
        state.rate.set(msg.origin, b);
      }
      b.count++;
      if (b.count === config.ratePerSec + 1) {
        // fire exactly once as we cross, this second
        state.counters.rateSpike++;
        raise("rate_spike", "high", msg.origin, `${b.count}+ msg/s`, t);
      }
    }

    // ---- id flood ----
    // The node table is capped, so nodes.size can't grow past maxNodes and can't
    // tell a full real fleet from a spoof storm. originsEverSeen counts every
    // distinct origin we ever made a record for, evicted ones included, so a
    // churn of fake ids pushes it well past a real fleet size.
    if (config.checks.id_flood && overCap && (state.floodedAt === null || t - state.floodedAt > 10000)) {
      state.floodedAt = t;
      raise("id_flood", "high", null, `${state.originsEverSeen} distinct origins seen`, t);
    }

    // ---- impossible / malformed payload ----
    if (config.checks.impossible && rangeBad) {
      state.counters.impossible++;
      raise("impossible", "medium", msg.origin, rangeBad, t);
    }

    // ---- replay ----
    if (config.checks.replay) {
      const v = replayVerdict(n, msg.seq, msg.hops, t);
      if (v === "replay") {
        state.counters.replay++;
        raise("replay", "high", msg.origin, `old seq ${msg.seq}`, t);
      } else if (v === "reboot") {
        raise("node_reboot", "info", msg.origin, "seq restarted after silence", t);
      }
    } else {
      advanceSeq(n, msg.seq, t); // keep bookkeeping current so it works if toggled back on
    }

    // ---- rogue sync ----
    if (msg.kind === 0) {
      if (state.hubId === null) {
        state.hubId = msg.origin; // the first SYNC we ever see defines the hub
        if (n.known === null) n.known = true; // whatever mints SYNC is infrastructure
      } else if (msg.origin !== state.hubId && config.checks.rogue_sync) {
        raise("rogue_sync", "high", msg.origin, `SYNC from non-hub (hub is ${state.hubId})`, t);
      }
    }

    // ---- status: role + store the payload (reboot handled above) ----
    if (msg.kind === 4) {
      const p = msg.payload;
      if (p.role === 0 && state.hubId === null) {
        state.hubId = msg.origin;
        if (n.known === null) n.known = true;
      }
      if (isInt(p.role)) {
        n.role = p.role;
        n.roleName = p.roleName;
      }
      n.lastStatus = {
        boots: p.boots, up: p.up, syncAge: p.syncAge,
        tx: p.tx, rx: p.rx, drop: p.drop, at: t,
      };
    }

    // ---- bookkeeping ----
    if (msg.epoch !== null) n.lastEpoch = msg.epoch;
    n.msgCount++;
    n.lastSeen = t;
    n.lastKind = msg.kindName;
    if (msg.rssi !== null) n.lastRssi = msg.rssi;
    if (msg.hops !== null) n.lastHops = msg.hops;
    if (!n.steady && n.msgCount >= 3 && t - n.firstSeen > 8000) n.steady = true;
  }

  // ---- getReport ---------------------------------------------------------
  function getReport(now) {
    const t = clock(now);
    const learning = state.startedAt !== null && t - state.startedAt < config.learnWindowMs;

    // Re-derive silence from lastSeen every call so the answer doesn't depend
    // on how often you ask. Hub and relay get the longer fuse because their own
    // origin only appears in the 30s status heartbeat.
    for (const n of state.nodes.values()) {
      const quiet = t - n.lastSeen;
      const limit =
        n.roleName === "hub" || n.roleName === "relay"
          ? config.heartbeatSilenceMs
          : config.silenceMs;
      const nowSilent = n.steady && quiet > limit;
      if (nowSilent && n.silentSince === null) {
        n.silentSince = t;
        if (config.checks.silent) {
          raise("silent", "medium", n.id, `${Math.round(quiet / 1000)}s quiet`, t);
        }
      } else if (!nowSilent && n.silentSince !== null) {
        n.silentSince = null;
        raise("recovered", "info", n.id, "talking again", t);
      }
    }

    // Jamming: several nodes silent, and they dropped off close together.
    if (config.checks.jamming) {
      const silent = [...state.nodes.values()].filter((n) => n.silentSince !== null);
      let jammed = false;
      if (silent.length >= config.jammingMinNodes) {
        const times = silent.map((n) => n.silentSince);
        const span = Math.max(...times) - Math.min(...times);
        jammed = span <= config.jammingWindowMs;
      }
      if (jammed && (state.jammedAt === null || t - state.jammedAt > 5000)) {
        state.jammedAt = t;
        raise("jamming", "high", null, `${silent.length} nodes silent together`, t);
      }
      if (!jammed) state.jammedAt = null;
    }

    // Node view, worst first.
    const rankOf = { suspect: 0, silent: 1, warn: 2, ok: 3 };
    const nodes = [...state.nodes.values()]
      .map((n) => {
        // live flags = ones raised within flagTtlMs, plus the two sticky
        // conditions synthesised so `flags` and `state` never disagree
        const flags = [];
        for (const [name, ts] of n.flags) {
          if (name !== "silent" && t - ts < config.flagTtlMs) flags.push(name);
        }
        if (n.known === false && !flags.includes("unknown_node")) flags.unshift("unknown_node");
        if (n.silentSince !== null) flags.push("silent");

        let stateName = "ok";
        if (n.known === false || flags.some((f) => ["replay", "rate_spike", "rogue_sync"].includes(f))) {
          stateName = "suspect";
        } else if (n.silentSince !== null) {
          stateName = "silent";
        } else if (flags.some((f) => ["impossible", "malformed"].includes(f))) {
          stateName = "warn";
        }
        return {
          id: n.id,
          role: n.roleName,
          known: n.known === true, // false covers both "flagged" and "still undecided"
          state: stateName,
          flags,
          msgCount: n.msgCount,
          lastSeenMsAgo: t - n.lastSeen,
          lastSeq: n.maxSeq,
          lastKind: n.lastKind,
          lastRssi: n.lastRssi,
          lastHops: n.lastHops,
          epoch: n.lastEpoch,
          status: n.lastStatus,
        };
      })
      .sort((a, b) => rankOf[a.state] - rankOf[b.state] || a.id.localeCompare(b.id));

    // Threat level from what's happened in the last 20s.
    const recent = state.events.filter((e) => t - e.lastTs < 20000);
    const worst = recent.reduce((acc, e) => Math.max(acc, SEV_RANK[e.severity] || 0), 0);
    const threatLevel = ["none", "low", "medium", "high"][Math.min(worst, 3)];

    return {
      generatedAt: t,
      mode: learning ? "learning" : "watching",
      hub: state.hubId,
      summary: {
        nodes: nodes.length,
        suspect: nodes.filter((n) => n.state === "suspect").length,
        silent: nodes.filter((n) => n.state === "silent").length,
        threatLevel,
        messages: state.counters.data,
        malformed: state.counters.malformed,
        recentEvents: recent.length,
      },
      counters: { ...state.counters }, // lines, data, log, malformed, impossible, replay, rateSpike, evicted
      nodes,
      events: state.events.slice(0, 50).map((e) => ({ ...e })),
    };
  }

  function reset() {
    state.startedAt = null;
    state.nodes.clear();
    state.rate.clear();
    state.hubId = null;
    state.events.length = 0;
    state.floodedAt = null;
    state.jammedAt = null;
    state.originsEverSeen = 0;
    for (const k of Object.keys(state.counters)) state.counters[k] = 0;
  }

  return {
    ingest,
    getReport,
    reset,
    get config() {
      return config;
    },
    get hub() {
      return state.hubId;
    },
  };
}

// ---- small internals --------------------------------------------------------

/**
 * Merge a partial override onto the defaults. Copies top-level arrays and the
 * one-level-nested limits/checks so a caller can't mutate our defaults, and
 * drops any key whose override value is `undefined` so `{ learnWindowMs: x }`
 * with an undefined `x` falls back to the default instead of breaking a check.
 */
function mergeConfig(base, over) {
  const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const defined = (o) => {
    const r = {};
    for (const k of Object.keys(o)) if (o[k] !== undefined) r[k] = o[k];
    return r;
  };
  const oTop = defined(over);
  const oLimits = defined(asObj(over.limits));
  const oChecks = defined(asObj(over.checks));

  const out = {};
  for (const k of Object.keys(base)) {
    if (k === "limits" || k === "checks") continue;
    const v = k in oTop ? oTop[k] : base[k];
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  out.limits = {};
  for (const k of Object.keys(base.limits)) {
    const v = k in oLimits ? oLimits[k] : base.limits[k];
    out.limits[k] = Array.isArray(v) ? v.slice() : v;
  }
  out.checks = { ...base.checks, ...oChecks };
  return out;
}

/** Freeze an object and everything under it, so DEFAULT_CONFIG can't be mutated. */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}
