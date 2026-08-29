// Live state built from the parsed serial stream.
//
//  - one record per mesh node, keyed by `origin`
//  - dedup by (origin, seq) with uint16 wraparound + reboot age-out, mirroring
//    the firmware's witness() logic ("the Pi owns dedup")
//  - alarm history (each alarm counted once, firmware re-sends + relay copies
//    collapse)
//  - rolling log of firmware events
//  - snapshot() returns a plain object ready to JSON.stringify for the API
//
// All time is wall-clock arrival time (Date.now via parseLine), NOT the
// firmware's `stamped` field — that one is coarse and resets on reboot.

import { EventEmitter } from 'node:events';
import { parseLine, seqIsNewer } from './protocol.js';

const VERDICT = { NEW: 'new', DUPE: 'dupe' };

export class Store extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.startedAt = Date.now();
    this.nodes = new Map();
    this.alarms = []; // oldest -> newest
    this.events = []; // oldest -> newest (firmware log lines)
    this.counters = {
      lines: 0, data: 0, log: 0, junk: 0, invalid: 0, blank: 0, dupes: 0, alarms: 0,
      nodesEvicted: 0,
    };
    this.serial = { state: 'init', path: null, since: Date.now(), attempts: 0, note: null };
  }

  setSerialStatus(s) {
    this.serial = { ...this.serial, ...s, since: Date.now() };
    this.emit('change');
  }

  /** Feed one raw serial line. Returns the parsed event (handy for tests/logs). */
  ingestLine(raw, now = Date.now()) {
    this.counters.lines++;
    const evt = parseLine(raw, now);
    this._ingest(evt);
    return evt;
  }

  _ingest(evt) {
    switch (evt.kind) {
      case 'blank':
        this.counters.blank++;
        return;
      case 'junk':
        this.counters.junk++;
        return;
      case 'invalid':
        this.counters.invalid++;
        this._pushEvent({
          ts: evt.ts,
          ev: 'parse_invalid',
          id: null,
          fields: { reason: evt.reason, raw: evt.raw.slice(0, 180) },
        });
        this.emit('change');
        return;
      case 'log':
        this.counters.log++;
        this._pushEvent(evt);
        this._applyLogHints(evt);
        this.emit('change');
        return;
      case 'data':
        this.counters.data++;
        this._applyData(evt);
        return;
      default:
        return;
    }
  }

  _node(id) {
    let n = this.nodes.get(id);
    if (!n) {
      if (this.nodes.size >= this.cfg.maxNodes) {
        // at cap: evict the least-recently-heard node so a flood of frames with
        // random origins can't grow memory without bound. Real nodes update
        // lastSeen every few seconds, so a one-shot spoofed origin goes first.
        let stalestKey = null;
        let stalestAt = Infinity;
        for (const [k, v] of this.nodes) {
          if (v.lastSeen < stalestAt) {
            stalestAt = v.lastSeen;
            stalestKey = k;
          }
        }
        if (stalestKey !== null) {
          this.nodes.delete(stalestKey);
          this.counters.nodesEvicted++;
        }
      }
      n = {
        id,
        role: null,
        roleName: 'unknown',
        firstSeen: Date.now(),
        lastSeen: 0,
        lastSeq: null,
        msgCount: 0,
        dupeCount: 0,
        lastRssi: null,
        lastHops: null,
        lastVia: null,
        lastKind: null,
        lastKindName: null,
        syncEpoch: null,
        status: null, // filled from KIND_STATUS
        lastAlarm: null,
        flags: {}, // e.g. { i2c: 'lost' }
      };
      this.nodes.set(id, n);
    }
    return n;
  }

  _verdict(node, seq, now) {
    if (node.lastSeq === null) return VERDICT.NEW;
    if (now - node.lastSeen > this.cfg.rebootAgeMs) return VERDICT.NEW; // rebooted, fresh random seq
    if (seqIsNewer(seq, node.lastSeq)) return VERDICT.NEW;
    return VERDICT.DUPE;
  }

  _applyData(evt) {
    const now = evt.ts;
    const n = this._node(evt.origin);
    const verdict = this._verdict(n, evt.seq, now);

    // these always reflect the most recent frame we heard, dupe or not
    n.lastSeen = now;
    n.lastKind = evt.msgKind;
    n.lastKindName = evt.msgKindName;
    if (evt.rssi !== null) n.lastRssi = evt.rssi;
    if (evt.hops !== null) n.lastHops = evt.hops;
    if (evt.via) n.lastVia = evt.via;
    if (evt.epoch !== null) n.syncEpoch = evt.epoch;

    if (verdict === VERDICT.NEW) {
      n.msgCount++;
      n.lastSeq = evt.seq;
    } else {
      n.dupeCount++;
      this.counters.dupes++;
    }

    if (evt.msgKind === 4) {
      const p = evt.payload;
      const prev = n.status;
      n.role = p.role;
      n.roleName = p.roleName;
      n.status = {
        fw: p.fw,
        boots: p.boots,
        uptimeS: p.uptimeS,
        syncAgeS: p.syncAgeS >= 0xffff ? null : p.syncAgeS,
        tx: p.tx,
        rx: p.rx,
        drop: p.drop,
        at: now,
      };
      // definitive reboot signal from the status payload: boot count up (only
      // ever increments, safe even on an out-of-order frame), or — only when
      // this frame is actually the newest we've seen — uptime jumped backwards.
      // Rebuild the dedup baseline now instead of waiting out rebootAgeMs.
      if (prev && (p.boots > prev.boots ||
                   (verdict === VERDICT.NEW && p.uptimeS + 5 < prev.uptimeS))) {
        this._pushEvent({
          ts: now,
          ev: 'node_reboot',
          id: evt.origin,
          fields: { boots: p.boots, wasBoots: prev.boots, uptimeS: p.uptimeS },
        });
        n.lastSeq = null;
      }
    }

    if (evt.msgKind === 3 && verdict === VERDICT.NEW) {
      const rec = {
        ts: now,
        origin: evt.origin,
        seq: evt.seq,
        hops: evt.hops,
        via: evt.via,
        rssi: evt.rssi,
        magnitude: evt.payload.magnitude,
        bearing: evt.payload.bearing,
      };
      this.alarms.push(rec);
      if (this.alarms.length > this.cfg.alarmHistory) this.alarms.shift();
      this.counters.alarms++;
      n.lastAlarm = rec;
      this.emit('alarm', rec);
    }

    this.emit('change');
  }

  _applyLogHints(evt) {
    if (!evt.id) return;
    const n = this._node(evt.id);
    if (evt.ev === 'i2c_lost') n.flags.i2c = 'lost';
    else if (evt.ev === 'i2c_recovered') n.flags.i2c = 'ok';
    else if (evt.ev === 'boot' && Number.isInteger(evt.fields?.role)) {
      n.role = evt.fields.role;
      n.roleName = ({ 0: 'hub', 1: 'sensor', 2: 'relay' })[evt.fields.role] ?? 'unknown';
    }
  }

  _pushEvent(evt) {
    this.events.push({
      ts: evt.ts,
      ev: evt.ev,
      id: evt.id ?? null,
      fields: evt.fields ?? {},
    });
    if (this.events.length > this.cfg.eventHistory) this.events.shift();
  }

  _deriveState(node, now) {
    if (!node.lastSeen) return 'unknown';
    const th = this.cfg.liveness[node.roleName] || this.cfg.liveness.unknown;
    const age = now - node.lastSeen;
    if (age < th.stale) return 'online';
    if (age < th.silent) return 'stale';
    return 'silent';
  }

  snapshot(now = Date.now()) {
    const rank = { silent: 0, stale: 1, unknown: 2, online: 3 };
    const nodes = [...this.nodes.values()]
      .map((n) => {
        const state = this._deriveState(n, now);
        return {
          id: n.id,
          role: n.role,
          roleName: n.roleName,
          state,
          lastSeenMsAgo: n.lastSeen ? now - n.lastSeen : null,
          lastSeq: n.lastSeq,
          msgCount: n.msgCount,
          dupeCount: n.dupeCount,
          lastRssi: n.lastRssi,
          lastHops: n.lastHops,
          lastVia: n.lastVia,
          lastKindName: n.lastKindName,
          syncEpoch: n.syncEpoch,
          status: n.status,
          lastAlarm: n.lastAlarm,
          flags: n.flags,
        };
      })
      .sort((a, b) => rank[a.state] - rank[b.state] || a.id.localeCompare(b.id));

    return {
      generatedAt: now,
      uptimeMs: now - this.startedAt,
      serial: this.serial,
      counters: { ...this.counters },
      nodeCount: nodes.length,
      onlineCount: nodes.filter((n) => n.state === 'online').length,
      nodes,
      alarms: this.alarms.slice(-40).reverse(), // newest first
      events: this.events.slice(-50).reverse(),
    };
  }
}
