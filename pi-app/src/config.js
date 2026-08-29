// Central configuration. Everything can be overridden with environment variables
// so the same code runs on a laptop (dev) and on the Pi (demo) unchanged.

const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  serial: {
    // null => auto-detect the ESP32 gateway. Set SERIAL_PATH to force it,
    // e.g. SERIAL_PATH=/dev/ttyACM0
    path: process.env.SERIAL_PATH || null,
    baudRate: num(process.env.SERIAL_BAUD, 115200),
    // reconnect backoff schedule in ms (last value repeats)
    reconnectMs: [500, 1000, 2000, 3000, 5000],
    // a line longer than this without a newline is treated as garbage and dropped
    maxLineBytes: num(process.env.SERIAL_MAX_LINE, 16384),
  },

  http: {
    // 0.0.0.0 so a laptop on the same Wi-Fi can open the dashboard.
    // Set HTTP_HOST=127.0.0.1 to keep it local-only (see OPSEC note in README).
    host: process.env.HTTP_HOST || '0.0.0.0',
    port: num(process.env.HTTP_PORT, 3000),
    sseIntervalMs: num(process.env.SSE_INTERVAL_MS, 1000),
  },

  store: {
    alarmHistory: num(process.env.ALARM_HISTORY, 100),
    eventHistory: num(process.env.EVENT_HISTORY, 80),
    // hard cap on tracked nodes — bounds memory if someone floods the channel
    // with frames carrying random origins. A real deployment is a handful.
    maxNodes: num(process.env.MAX_NODES, 64),
    // per-role liveness thresholds, ms since the last frame from that node
    liveness: {
      hub: { stale: 25000, silent: 60000 },
      sensor: { stale: 13000, silent: 40000 },
      relay: { stale: 25000, silent: 60000 },
      unknown: { stale: 20000, silent: 50000 },
    },
    // after this much silence from a node, accept ANY seq from it (it rebooted
    // with a fresh random seq). Mirrors the firmware's SEEN_AGE_MS.
    rebootAgeMs: num(process.env.REBOOT_AGE_MS, 60000),
  },

  simulate: process.argv.includes('--simulate') || process.env.SIMULATE === '1',
};
