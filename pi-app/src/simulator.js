// Synthetic v4 traffic — the exact line format logicv4.txt prints, so the
// dashboard / analysis / demo work with no hardware. Models a HUB gateway that
// hears two sensors (S1, S2). Run with `npm run sim`.

export function startSimulator(emit) {
  const HUB = 'A0B0C0D0';
  const S1 = 'A1B1C1D1';
  const S2 = 'A2B2C2D2';

  const seq = { [HUB]: rand16(), [S1]: rand16(), [S2]: rand16() };
  const boot = Date.now();
  const up = () => Math.floor((Date.now() - boot) / 1000);
  const stamped = () => Date.now() % 0xffffffff;
  const r = (n) => Math.floor(Math.random() * n);

  const send = (o) => emit(JSON.stringify(o));
  const nextSeq = (id) => {
    seq[id] = (seq[id] + 1) & 0xffff;
    if (seq[id] === 0) seq[id] = 1;
    return seq[id];
  };
  const data = (kind, origin, extra = {}, { rssi, hops = 0, via = origin } = {}) => {
    const o = { v: 4, kind, origin, seq: nextSeq(origin), stamped: stamped(), epoch: 40000, via, hops };
    if (rssi !== undefined) o.rssi = rssi;
    send(Object.assign(o, extra));
  };
  const statusFields = (role) => ({
    fw: 4, role, boots: 3, up: up(),
    syncAge: role === 0 ? 0xffff : 3 + r(3),
    tx: 100 + r(80), rx: 200 + r(120), drop: r(4),
  });

  const timers = [];
  const every = (ms, fn, offset = 0) => {
    const kick = () => { fn(); timers.push(setInterval(fn, ms)); };
    if (offset) timers.push(setTimeout(kick, offset));
    else kick();
  };

  // one-time boot chatter: raw ROM noise + a couple of log lines
  timers.push(setTimeout(() => emit('rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)'), 40));
  timers.push(setTimeout(() => send({ type: 'log', ev: 'boot', id: HUB, t: 18, fw: '4.0.0-dev', protocol: 4, role: 0, boots: 3, channel: 6, dev: 1 }), 110));
  timers.push(setTimeout(() => send({ type: 'log', ev: 'espnow_ready', id: HUB, t: 55, txPower: 34 }), 150));

  // sensor pings every 5 s (S2 offset so they don't collide)
  every(5000, () => data(1, S1, {}, { rssi: -52 - r(6) }));
  every(5000, () => data(1, S2, {}, { rssi: -61 - r(8) }), 1700);

  // range reply right after each ping
  every(5000, () => setTimeout(() => data(2, S1, { peer: HUB, peerRssi: -50 - r(5) }, { rssi: -53 - r(6) }), 120));
  every(5000, () => setTimeout(() => data(2, S2, { peer: HUB, peerRssi: -58 - r(6) }, { rssi: -62 - r(7) }), 120), 1700);

  // status heartbeats every 30 s
  every(30000, () => data(4, HUB, statusFields(0)));                              // hub's own local print: no rssi
  every(30000, () => data(4, S1, statusFields(1), { rssi: -54 - r(5) }), 900);
  every(30000, () => data(4, S2, statusFields(1), { rssi: -63 - r(6) }), 2200);

  // hub dev-log heartbeat every 10 s
  every(10000, () => send({ type: 'log', ev: 'status', id: HUB, t: stamped(), up: up(), syncAge: 3, epoch: 40000, tx: 900 + r(200), rx: 4000 + r(500), drop: 12, overflow: 0, heap: 210000 + r(4000) }));

  // an alarm on a random sensor every 15-40 s, broadcast 3x like the firmware
  const armAlarm = () => {
    const s = Math.random() < 0.5 ? S1 : S2;
    const mag = +(0.25 + Math.random() * 1.7).toFixed(2);
    const bearing = +(Math.random() * 360).toFixed(1);
    const aseq = nextSeq(s);
    const rssi = -55 - r(8);
    for (let i = 0; i < 3; i++) {
      timers.push(setTimeout(() => {
        send({ v: 4, kind: 3, origin: s, seq: aseq, stamped: stamped(), epoch: 40000, via: s, hops: 0, rssi, mag, bearing });
      }, i * 250));
    }
    send({ type: 'log', ev: 'alarm', id: s, t: stamped(), mag, bearing, seq: aseq });
    timers.push(setTimeout(armAlarm, 15000 + Math.random() * 25000));
  };
  timers.push(setTimeout(armAlarm, 8000));

  return function stop() {
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
  };

  function rand16() {
    return 1 + Math.floor(Math.random() * 60000);
  }
}
