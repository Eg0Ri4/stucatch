// Parser + validator for what the ESP32 gateway prints on its serial line.
//
// The gateway emits ONE JSON object per line. Two shapes:
//
//   data line (a mesh reception), always:
//     {"v":4,"kind":K,"origin":"HEX","seq":N,"stamped":N,"epoch":N,"via":"HEX","hops":N
//      [,"rssi":N]  [,<kind-specific fields>] }
//     kind 0 sync   -> "authority":N
//     kind 1 ping   -> (nothing)
//     kind 2 range  -> "peer":"HEX","peerRssi":N
//     kind 3 alarm  -> "mag":F,"bearing":F
//     kind 4 status -> "fw":N,"role":N,"boots":N,"up":N,"syncAge":N,"tx":N,"rx":N,"drop":N
//
//   log line (a firmware event / trace):
//     {"type":"log","ev":"...","id":"HEX","t":N, ...}
//
// Anything else on the line (boot ROM noise, half lines, a baud glitch) is
// classified as `junk` and counted, never thrown. `invalid` means it parsed as
// JSON and looked like one of our shapes but a required field was wrong.

export const MSG_KINDS = { 0: 'sync', 1: 'ping', 2: 'range', 3: 'alarm', 4: 'status' };
export const ROLE_NAMES = { 0: 'hub', 1: 'sensor', 2: 'relay' };

const isInt = (n) => typeof n === 'number' && Number.isFinite(n) && Math.floor(n) === n;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isHexId = (s) => typeof s === 'string' && /^[0-9a-fA-F]{1,8}$/.test(s);
const normId = (s) => String(s).toUpperCase().replace(/^0X/, '');

/**
 * @param {string} raw  one line off the serial port (without the newline)
 * @param {number} now  arrival timestamp (ms). Injectable for tests.
 * @returns {object} one of:
 *   { kind:'blank',   ts, raw }
 *   { kind:'junk',    ts, raw }
 *   { kind:'invalid', ts, reason, raw }
 *   { kind:'log',     ts, ev, id, t, fields, raw }
 *   { kind:'data',    ts, v, msgKind, msgKindName, origin, seq, stamped, epoch,
 *                     via, hops, rssi, payload, raw }
 */
export function parseLine(raw, now = Date.now()) {
  const line = String(raw ?? '').trim();
  if (!line) return { kind: 'blank', ts: now, raw: String(raw ?? '') };

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: 'junk', ts: now, raw: line };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { kind: 'junk', ts: now, raw: line };
  }

  // ---------- log line ----------
  if (obj.type === 'log') {
    if (typeof obj.ev !== 'string') {
      return { kind: 'invalid', ts: now, reason: 'log line without "ev"', raw: line };
    }
    const { type, ev, id, t, ...fields } = obj;
    void type;
    return {
      kind: 'log',
      ts: now,
      ev,
      id: isHexId(id) ? normId(id) : (id ?? null),
      t: isInt(t) ? t : null,
      fields,
      raw: line,
    };
  }

  // ---------- data line (protocol v4) ----------
  const invalid = (reason) => ({ kind: 'invalid', ts: now, reason, raw: line });

  if (Number(obj.v) !== 4) return invalid(`unsupported protocol v=${JSON.stringify(obj.v)}`);

  const k = Number(obj.kind);
  if (!(k in MSG_KINDS)) return invalid(`unknown kind=${JSON.stringify(obj.kind)}`);
  if (!isHexId(obj.origin)) return invalid('missing/invalid "origin"');
  if (!isInt(obj.seq) || obj.seq < 0 || obj.seq > 0xffff) return invalid('missing/invalid "seq"');
  if (!isInt(obj.hops) || obj.hops < 0 || obj.hops > 0xff) return invalid('missing/invalid "hops"');

  const evt = {
    kind: 'data',
    ts: now,
    v: 4,
    msgKind: k,
    msgKindName: MSG_KINDS[k],
    origin: normId(obj.origin),
    seq: obj.seq,
    stamped: isInt(obj.stamped) ? obj.stamped : null,
    epoch: isInt(obj.epoch) ? obj.epoch : null,
    via: isHexId(obj.via) ? normId(obj.via) : null,
    hops: obj.hops,
    rssi: isInt(obj.rssi) ? obj.rssi : null, // absent for a node's own local print
    payload: {},
    raw: line,
  };

  switch (k) {
    case 0: // sync
      if (!isInt(obj.authority)) return invalid('sync without "authority"');
      evt.payload = { authority: obj.authority };
      break;
    case 1: // ping — no payload
      break;
    case 2: // range
      if (!isHexId(obj.peer) || !isInt(obj.peerRssi)) return invalid('bad range payload');
      evt.payload = { peer: normId(obj.peer), peerRssi: obj.peerRssi };
      break;
    case 3: // alarm
      if (!isNum(obj.mag) || !isNum(obj.bearing)) return invalid('bad alarm payload');
      evt.payload = { magnitude: obj.mag, bearing: obj.bearing };
      break;
    case 4: // status
      for (const f of ['fw', 'role', 'boots', 'up', 'syncAge', 'tx', 'rx', 'drop']) {
        if (!isInt(obj[f])) return invalid(`status payload missing "${f}"`);
      }
      evt.payload = {
        fw: obj.fw,
        role: obj.role,
        roleName: ROLE_NAMES[obj.role] ?? 'unknown',
        boots: obj.boots,
        uptimeS: obj.up,
        syncAgeS: obj.syncAge, // 0xFFFF => never synced
        tx: obj.tx,
        rx: obj.rx,
        drop: obj.drop,
      };
      break;
  }

  return evt;
}

/**
 * uint16 wraparound-aware "is `seq` newer than `ref`?" — same test the firmware
 * uses (`(int16_t)(seq - ref) > 0`).
 */
export function seqIsNewer(seq, ref) {
  const d = (seq - ref) & 0xffff;
  const signed = d > 0x7fff ? d - 0x10000 : d;
  return signed > 0;
}
