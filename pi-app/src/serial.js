// Robust serial link to the ESP32 gateway.
//
//  - auto-detects the port (or uses config.path)
//  - frames the byte stream into lines (handles \r\n, partial chunks, huge lines)
//  - auto-reconnects forever if the board is unplugged / reset
//
// Emits:
//   'line'   (string)   one complete line, newline stripped
//   'status' ({state,path,attempts})  state: connecting|open|closed|reconnecting
//   'error'  (Error)

import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';

// USB vendor IDs worth trying, best first: Espressif (C3 native USB), then the
// common USB-UART bridges (CP210x, CH340, FTDI).
const PREFERRED_VIDS = ['303a', '10c4', '1a86', '0403'];

const NL = 0x0a;

// remove C0 control bytes (0x00-0x1F) except tab; \r and \n are handled by the framer
function stripControls(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c >= 0x20) out += s[i];
  }
  return out;
}

export class SerialLink extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.port = null;
    this.buf = Buffer.alloc(0);
    this.attempts = 0;
    this.stopped = false;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.port && this.port.isOpen) {
      try {
        this.port.close();
      } catch {
        /* ignore */
      }
    }
  }

  async _resolvePath() {
    if (this.cfg.path) return this.cfg.path;
    let list = [];
    try {
      list = await SerialPort.list();
    } catch {
      list = [];
    }
    for (const vid of PREFERRED_VIDS) {
      const hit = list.find((p) => (p.vendorId || '').toLowerCase() === vid);
      if (hit) return hit.path;
    }
    const acm = list.find((p) => /ttyACM|usbmodem|^COM\d/i.test(p.path || ''));
    if (acm) return acm.path;
    const usb = list.find((p) => /ttyUSB|usbserial/i.test(p.path || ''));
    if (usb) return usb.path;
    return '/dev/ttyACM0';
  }

  async _connect() {
    if (this.stopped) return;
    this.attempts++;

    let path;
    try {
      path = await this._resolvePath();
    } catch (err) {
      this.emit('error', err);
      return this._scheduleReconnect();
    }

    this.emit('status', { state: 'connecting', path, attempts: this.attempts });

    const port = new SerialPort({ path, baudRate: this.cfg.baudRate, autoOpen: false });
    this.port = port;

    port.on('open', () => {
      this.attempts = 0;
      this.buf = Buffer.alloc(0);
      this.emit('status', { state: 'open', path, attempts: 0 });
    });

    port.on('data', (chunk) => this._onData(chunk));

    port.on('error', (err) => this.emit('error', err));

    port.on('close', () => {
      this.emit('status', { state: 'closed', path, attempts: this.attempts });
      if (!this.stopped) this._scheduleReconnect();
    });

    port.open((err) => {
      if (err) {
        this.emit('error', err);
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const sched = this.cfg.reconnectMs;
    const wait = sched[Math.min(this.attempts, sched.length - 1)] ?? 5000;
    this.emit('status', { state: 'reconnecting', path: this.cfg.path, attempts: this.attempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, wait);
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);

    // guard: a stream with no newline at all (garbage / wrong device)
    if (this.buf.length > this.cfg.maxLineBytes) {
      this.buf = Buffer.alloc(0);
      this.emit('status', {
        state: 'open',
        path: this.port && this.port.path,
        attempts: 0,
        note: 'oversized line dropped',
      });
      return;
    }

    let idx;
    while ((idx = this.buf.indexOf(NL)) !== -1) {
      let line = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = stripControls(line).trim();
      if (line.length) this.emit('line', line);
    }
  }
}
