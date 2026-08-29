#!/usr/bin/env node
// mesh-sim — synthetic stucatch mesh, physics included.
//
// Simulates nodes on a plane with a radio model (log-distance path loss + noise),
// one clock authority, relays, impacts, and dialable pathologies. Emits the serial
// stream of ONE board (the gateway) exactly as firmware v4 prints it: data lines
// {"v":4,...} + log lines {"type":"log",...}, NDJSON on stdout.
//
//   node mesh-sim.js [--nodes 3] [--relay] [--gateway hub|relay|<n>] [--loss 0]
//                    [--impacts 20] [--reboot 0] [--speed 1] [--duration 0]
//                    [--seed 1] [--no-dev]
//
//   --loss     extra per-link drop probability on top of the radio model (0..1)
//   --impacts  mean seconds between impact events (0 = never)
//   --reboot   mean seconds between random sensor reboots (0 = never)
//   --speed    time multiplier (60 = a minute of mesh per wall second)
//   --duration virtual seconds to run (0 = forever)
//   --gateway  whose serial you are reading (default hub)

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[key] = next; i++; } else args[key] = true;
}
const NODES = Number(args.nodes ?? 3);
const RELAY = "no-relay" in args ? false : true;
const LOSS = Number(args.loss ?? 0);
const IMPACTS = Number(args.impacts ?? 20);
const REBOOT = Number(args.reboot ?? 0);
const SPEED = Number(args.speed ?? 1);
const DURATION = Number(args.duration ?? 0);
const SEED = Number(args.seed ?? 1);
const DEV = !("no-dev" in args);

// deterministic rng
let rngState = SEED >>> 0 || 1;
const rand = () => {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (sigma) => sigma * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const randInt = (n) => Math.floor(rand() * n);
const hexId = () => Array.from({ length: 8 }, () => "0123456789ABCDEF"[randInt(16)]).join("");

// ---------------- scene ----------------
const nodes = [];
const makeNode = (role, x, y) => {
  const node = {
    id: hexId(), role, x, y,
    seq: 1 + randInt(0xfffe),
    bootSkew: randInt(1 << 24),      // raw clock = t + bootSkew
    offset: 0, epoch: 0, synced: false, lastSyncAt: -1,
    mount: rand() * 360,             // mounting rotation — bearing frame is installation luck
    boots: 1 + randInt(9),
    tx: 0, rx: 0, drop: 0,
    seen: new Map(),                 // origin -> {seq, at} dedup table
    bootedAt: 0,
  };
  nodes.push(node);
  return node;
};
const hub = makeNode(0, 0, 0);
const relay = RELAY ? makeNode(2, 28, 6) : null;
for (let i = 0; i < NODES; i++) {
  const angle = (i / NODES) * 2 * Math.PI + rand();
  const r = 12 + rand() * 35;
  makeNode(1, Math.cos(angle) * r, Math.sin(angle) * r);
}
const sensors = nodes.filter((n) => n.role === 1);
const gateway =
  args.gateway === "relay" && relay ? relay
  : /^\d+$/.test(args.gateway ?? "") ? sensors[Number(args.gateway)] ?? hub
  : hub;

// ---------------- virtual time + event queue ----------------
let now = 0;
const queue = [];
const at = (t, fn) => { queue.push({ t, fn }); };
const after = (dt, fn) => at(now + dt, fn);

// ---------------- radio ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const linkRssi = (a, b) => Math.round(-40 - 22 * Math.log10(Math.max(dist(a, b), 0.5)) + gauss(2.5));
const FLOOR = -92;

const raw = (node) => now + node.bootSkew - node.bootedAt;
const stampedTime = (node) => (raw(node) - node.offset) >>> 0;
const nextSeq = (node) => { node.seq = (node.seq + 1) & 0xffff; if (node.seq === 0) node.seq = 1; return node.seq; };

// verdict per firmware witness(): NEW 0 / DUPE 1 / RESEND 2
const witness = (node, origin, seq) => {
  const entry = node.seen.get(origin);
  if (!entry || ((seq - entry.seq) & 0xffff) - ((seq - entry.seq) & 0x8000 ? 0x10000 : 0) > 0 || now - entry.at > 60000) {
    node.seen.set(origin, { seq, at: now });
    return 0;
  }
  if (seq === entry.seq && now - entry.at > 5000) { entry.at = now; return 2; }
  return 1;
};

process.stdout.on("error", (err) => { if (err.code === "EPIPE") process.exit(0); throw err; });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (ev, fields = {}) => out({ type: "log", ev, id: gateway.id, t: raw(gateway), ...fields });
const trace = (ev, fields) => { if (DEV) log(ev, fields); };

// frame = {kind, origin, seq, stamped, epoch, payload}
const broadcast = (sender, frame) => {
  sender.tx++;
  if (sender === gateway) {
    trace("tx", { kind: frame.kind, seq: frame.seq, stamped: frame.stamped });
    trace("tx_result", { ok: 1 });
  }
  for (const receiver of nodes) {
    if (receiver === sender) continue;
    const rssi = linkRssi(sender, receiver);
    if (rssi < FLOOR || rand() < LOSS) continue;
    after(1 + rand() * 3, () => receive(receiver, { ...frame, via: sender.id, hops: frame.hops ?? 0, rssi }));
  }
};

const printReception = (frame) => {
  const line = {
    v: 4, kind: frame.kind, origin: frame.origin, seq: frame.seq,
    stamped: frame.stamped, epoch: frame.epoch, via: frame.via, hops: frame.hops,
  };
  if (frame.rssi !== undefined) line.rssi = frame.rssi;
  out({ ...line, ...frame.payload });
};

function receive(node, frame) {
  if (frame.origin === node.id) return;
  node.rx++;
  const verdict = witness(node, frame.origin, frame.seq);
  if (node === gateway) {
    trace("rx", { kind: frame.kind, origin: frame.origin, seq: frame.seq, hops: frame.hops, rssi: frame.rssi, verdict });
    printReception(frame);
  }
  if (frame.kind === 0 && node.role !== 0) {
    node.offset = raw(node) - frame.payload.authority;
    node.epoch = frame.seq;
    const wasSynced = node.synced;
    node.synced = true;
    node.lastSyncAt = now;
    if (node === gateway) log("sync", { from: frame.origin, epoch: node.epoch, offset: node.offset, delta: wasSynced ? Math.round(gauss(2)) : node.offset });
  }
  if (node.role === 2 && verdict !== 1 && frame.hops < 2) {
    after(5 + rand() * 15, () => broadcast(node, { ...frame, hops: frame.hops + 1 }));
  }
  if (node.role === 1 && frame.kind === 1 && frame.hops === 0 && verdict === 0) {
    after(rand() * 20, () => {
      const reply = {
        kind: 2, origin: node.id, seq: nextSeq(node), stamped: stampedTime(node), epoch: node.epoch,
        payload: { peer: frame.origin, peerRssi: frame.rssi + Math.round(gauss(1.5)) },
      };
      broadcast(node, reply);
      if (node === gateway) log("range", { peer: frame.origin, rssi: reply.payload.peerRssi });
    });
  }
}

// ---------------- behaviors ----------------
const syncTick = () => {
  const frame = { kind: 0, origin: hub.id, seq: nextSeq(hub), stamped: raw(hub), epoch: hub.epoch, payload: { authority: raw(hub) } };
  hub.epoch = frame.seq;
  frame.epoch = hub.epoch;
  broadcast(hub, frame);
  after(10000, syncTick);
};

const pingTick = (node) => () => {
  broadcast(node, { kind: 1, origin: node.id, seq: nextSeq(node), stamped: stampedTime(node), epoch: node.epoch, payload: {} });
  after(5000 + rand() * 100, pingTick(node));
};

const statusTick = (node) => () => {
  const payload = {
    fw: 4, role: node.role, boots: node.boots,
    up: Math.floor((now - node.bootedAt) / 1000),
    syncAge: node.role === 0 ? 0xffff : node.synced ? Math.min(Math.floor((now - node.lastSyncAt) / 1000), 0xfffe) : 0xffff,
    tx: node.tx, rx: node.rx, drop: node.drop,
  };
  const frame = { kind: 4, origin: node.id, seq: nextSeq(node), stamped: stampedTime(node), epoch: node.epoch, payload };
  if (node === gateway) printReception({ ...frame, via: node.id, hops: 0 });   // self-report: no rssi
  broadcast(node, frame);
  after(30000, statusTick(node));
};

const impactTick = () => {
  const cx = (rand() - 0.5) * 90, cy = (rand() - 0.5) * 90;
  for (const sensor of sensors) {
    const d = dist(sensor, { x: cx, y: cy });
    const magnitude = 1.6 * Math.exp(-d / 18) + gauss(0.02);
    if (magnitude < 0.2) continue;
    let bearing = (Math.atan2(cy - sensor.y, cx - sensor.x) * 180 / Math.PI + sensor.mount) % 360;
    if (bearing < 0) bearing += 360;
    const frame = {
      kind: 3, origin: sensor.id, seq: nextSeq(sensor), stamped: stampedTime(sensor), epoch: sensor.epoch,
      payload: { mag: Number(magnitude.toFixed(2)), bearing: Number(bearing.toFixed(1)) },
    };
    after(d * 0.005, () => {
      broadcast(sensor, frame);
      if (sensor === gateway) log("alarm", { mag: frame.payload.mag, bearing: frame.payload.bearing, seq: frame.seq });
      after(200, () => broadcast(sensor, frame));   // blind resends, same seq + stamped
      after(1000, () => broadcast(sensor, frame));
    });
  }
  after((IMPACTS * 1000) * (0.5 + rand()), impactTick);
};

const rebootTick = () => {
  const victim = sensors[randInt(sensors.length)];
  if (victim === gateway) log("boot", { fw: "4.0.0-dev", protocol: 4, role: victim.role, boots: victim.boots + 1, channel: 6, dev: DEV ? 1 : 0 });
  victim.boots++; victim.seq = 1 + randInt(0xfffe);
  victim.bootedAt = now; victim.bootSkew = randInt(1 << 24);
  victim.synced = false; victim.offset = 0; victim.epoch = 0;
  victim.tx = 0; victim.rx = 0; victim.drop = 0;
  after((REBOOT * 1000) * (0.5 + rand()), rebootTick);
};

// ---------------- run ----------------
log("boot", { fw: "4.0.0-dev", protocol: 4, role: gateway.role, boots: gateway.boots, channel: 6, dev: DEV ? 1 : 0 });
log("espnow_ready", { txPower: 34 });
if (gateway.role === 1) log("calibrated", { good: 100, of: 100, x: Number(gauss(0.2).toFixed(3)), y: Number(gauss(0.2).toFixed(3)), z: Number((1 + gauss(0.02)).toFixed(3)) });
log("ready", {});

at(500, syncTick);
for (const sensor of sensors) at(1000 + rand() * 5000, pingTick(sensor));
for (const node of nodes) at(2000 + rand() * 30000, statusTick(node));
if (IMPACTS > 0) at(IMPACTS * 1000 * rand(), impactTick);
if (REBOOT > 0) at(REBOOT * 1000 * (0.5 + rand()), rebootTick);
if (DEV) {
  const devStatus = () => {
    log("status", {
      up: Math.floor(now / 1000),
      syncAge: gateway.role === 0 ? -1 : gateway.synced ? Math.floor((now - gateway.lastSyncAt) / 1000) : -1,
      epoch: gateway.epoch, tx: gateway.tx, rx: gateway.rx, drop: gateway.drop, overflow: 0,
      heap: 260000 - randInt(2000),
    });
    after(10000, devStatus);
  };
  at(10000, devStatus);
}

const step = () => {
  queue.sort((a, b) => a.t - b.t);
  const next = queue.shift();
  if (!next || (DURATION && next.t > DURATION * 1000)) return;
  const wait = (next.t - now) / SPEED;
  now = next.t;
  if (wait > 2) setTimeout(() => { next.fn(); step(); }, wait);
  else { next.fn(); step(); }
};
step();
