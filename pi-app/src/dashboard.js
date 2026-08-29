// The dashboard is one self-contained HTML page (no build step, no external
// assets). Served at GET /. It streams state from GET /api/stream (SSE) and
// falls back to polling GET /api/state.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>STUCATCH — mesh monitor</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2330; --line:#30363d;
    --fg:#e6edf3; --dim:#8b949e; --accent:#3fb950;
    --ok:#3fb950; --stale:#d29922; --silent:#f85149; --unknown:#6e7681;
    --alarm:#ff7b72;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:14px;
    padding:12px 18px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:15px; margin:0; letter-spacing:.5px; }
  .pill { padding:2px 9px; border-radius:999px; font-size:12px; border:1px solid var(--line); }
  .pill.up { color:var(--ok); border-color:var(--ok); }
  .pill.down { color:var(--silent); border-color:var(--silent); }
  .counters { margin-left:auto; color:var(--dim); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; }
  .counters b { color:var(--fg); }
  main { padding:18px; display:grid; gap:18px; grid-template-columns:1fr; max-width:1200px; margin:0 auto; }
  @media (min-width:900px){ main { grid-template-columns:1.3fr 1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  section > h2 { margin:0; padding:10px 14px; font-size:12px; text-transform:uppercase;
    letter-spacing:1px; color:var(--dim); border-bottom:1px solid var(--line); background:var(--panel2); }
  .nodes { display:grid; gap:10px; padding:12px; }
  @media (min-width:560px){ .nodes { grid-template-columns:1fr 1fr; } }
  .node { border:1px solid var(--line); border-radius:6px; padding:10px 12px; background:var(--panel2); }
  .node .top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .node .id { font-weight:700; }
  .node .role { color:var(--dim); font-size:12px; }
  .badge { margin-left:auto; font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid; }
  .badge.online { color:var(--ok); border-color:var(--ok); }
  .badge.stale { color:var(--stale); border-color:var(--stale); }
  .badge.silent { color:var(--silent); border-color:var(--silent); }
  .badge.unknown { color:var(--unknown); border-color:var(--unknown); }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; color:var(--dim); }
  .kv b { color:var(--fg); font-weight:600; }
  .node.silent { border-color:var(--silent); }
  .flag { color:var(--silent); }
  .alarms { padding:0; margin:0; list-style:none; max-height:520px; overflow:auto; }
  .alarms li { display:flex; align-items:center; gap:12px; padding:10px 14px; border-bottom:1px solid var(--line); }
  .alarms li:first-child { background:rgba(255,123,114,.08); }
  .mag { font-size:20px; font-weight:700; color:var(--alarm); min-width:74px; }
  .arrow { width:34px; height:34px; flex:0 0 auto; }
  .arrow svg { display:block; }
  .ameta { font-size:12px; color:var(--dim); }
  .ameta b { color:var(--fg); }
  .events { padding:0; margin:0; list-style:none; max-height:280px; overflow:auto; font-size:12px; }
  .events li { padding:5px 14px; border-bottom:1px solid var(--line); color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .events .ev { color:var(--fg); }
  .empty { padding:16px; color:var(--dim); }
  details > summary { cursor:pointer; padding:10px 14px; font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); }
  .full { grid-column:1/-1; }
</style>
</head>
<body>
<header>
  <h1>STUCATCH · mesh monitor</h1>
  <span id="serial" class="pill down">serial: …</span>
  <span id="stream" class="pill down">stream: …</span>
  <div class="counters">
    <span>lines <b id="c-lines">0</b></span>
    <span>data <b id="c-data">0</b></span>
    <span>dupes <b id="c-dupes">0</b></span>
    <span>junk <b id="c-junk">0</b></span>
    <span>invalid <b id="c-invalid">0</b></span>
    <span>uptime <b id="c-uptime">0s</b></span>
  </div>
</header>

<main>
  <section>
    <h2>Nodes (<span id="n-count">0</span> · <span id="n-online">0</span> online)</h2>
    <div id="nodes" class="nodes"></div>
  </section>

  <section>
    <h2>Alarms</h2>
    <ul id="alarms" class="alarms"><li class="empty">no alarms yet</li></ul>
  </section>

  <section class="full">
    <details open>
      <summary>Firmware events</summary>
      <ul id="events" class="events"><li class="empty">nothing yet</li></ul>
    </details>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const ago = (ms) => ms == null ? '—' : ms < 1000 ? '0s' : ms < 60000 ? Math.round(ms/1000)+'s' : Math.round(ms/60000)+'m';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function arrow(deg) {
  return '<span class="arrow"><svg viewBox="0 0 34 34" width="34" height="34">' +
    '<circle cx="17" cy="17" r="15" fill="none" stroke="#30363d"/>' +
    '<g transform="rotate(' + (deg||0) + ' 17 17)">' +
    '<path d="M17 4 L22 20 L17 16 L12 20 Z" fill="#ff7b72"/></g></svg></span>';
}

function renderNodes(nodes) {
  $('n-count').textContent = nodes.length;
  $('n-online').textContent = nodes.filter(n => n.state === 'online').length;
  if (!nodes.length) { $('nodes').innerHTML = '<div class="empty">no nodes seen</div>'; return; }
  $('nodes').innerHTML = nodes.map(n => {
    const st = n.status;
    return '<div class="node ' + n.state + '">' +
      '<div class="top"><span class="id">' + esc(n.id) + '</span>' +
      '<span class="role">' + esc(n.roleName) + '</span>' +
      '<span class="badge ' + n.state + '">' + n.state + '</span></div>' +
      '<div class="kv">' +
        '<span>last</span><b>' + ago(n.lastSeenMsAgo) + ' ago</b>' +
        '<span>seq</span><b>' + (n.lastSeq ?? '—') + '</b>' +
        '<span>rssi</span><b>' + (n.lastRssi ?? '—') + '</b>' +
        '<span>hops</span><b>' + (n.lastHops ?? '—') + '</b>' +
        '<span>msgs</span><b>' + n.msgCount + (n.dupeCount ? ' (+' + n.dupeCount + ' dup)' : '') + '</b>' +
        '<span>epoch</span><b>' + (n.syncEpoch ?? '—') + '</b>' +
        (st ? '<span>fw</span><b>' + st.fw + ' · boots ' + st.boots + '</b>' +
              '<span>up</span><b>' + st.uptimeS + 's</b>' +
              '<span>syncAge</span><b>' + (st.syncAgeS == null ? 'never' : st.syncAgeS + 's') + '</b>' +
              '<span>tx/rx/drop</span><b>' + st.tx + ' / ' + st.rx + ' / ' + st.drop + '</b>' : '') +
        (n.flags && n.flags.i2c === 'lost' ? '<span>i2c</span><b class="flag">LOST</b>' : '') +
      '</div></div>';
  }).join('');
}

function renderAlarms(alarms) {
  if (!alarms.length) { $('alarms').innerHTML = '<li class="empty">no alarms yet</li>'; return; }
  $('alarms').innerHTML = alarms.map(a => {
    const t = new Date(a.ts).toLocaleTimeString();
    return '<li>' + arrow(a.bearing) +
      '<span class="mag">' + a.magnitude.toFixed(2) + 'g</span>' +
      '<span class="ameta"><b>' + esc(a.origin) + '</b> · ' + t +
      '<br>bearing ' + a.bearing.toFixed(0) + '° · hops ' + a.hops +
      (a.rssi != null ? ' · rssi ' + a.rssi : '') + '</span></li>';
  }).join('');
}

function renderEvents(events) {
  if (!events.length) { $('events').innerHTML = '<li class="empty">nothing yet</li>'; return; }
  $('events').innerHTML = events.map(e => {
    const t = new Date(e.ts).toLocaleTimeString();
    const extra = Object.entries(e.fields || {}).slice(0, 4)
      .map(([k, v]) => k + '=' + (typeof v === 'string' ? v.slice(0, 40) : v)).join(' ');
    return '<li>' + t + '  <span class="ev">' + esc(e.ev) + '</span>' +
      (e.id ? ' <b>' + esc(e.id) + '</b>' : '') + '  ' + esc(extra) + '</li>';
  }).join('');
}

function render(s) {
  const serial = $('serial');
  const up = s.serial && ['open', 'simulated'].includes(s.serial.state);
  serial.className = 'pill ' + (up ? 'up' : 'down');
  serial.textContent = 'serial: ' + (s.serial ? s.serial.state : '?') +
    (s.serial && s.serial.path ? ' (' + s.serial.path + ')' : '');
  $('c-lines').textContent = s.counters.lines;
  $('c-data').textContent = s.counters.data;
  $('c-dupes').textContent = s.counters.dupes;
  $('c-junk').textContent = s.counters.junk;
  $('c-invalid').textContent = s.counters.invalid;
  $('c-uptime').textContent = ago(s.uptimeMs);
  renderNodes(s.nodes);
  renderAlarms(s.alarms);
  renderEvents(s.events);
}

function markStream(ok) {
  const el = $('stream');
  el.className = 'pill ' + (ok ? 'up' : 'down');
  el.textContent = 'stream: ' + (ok ? 'live' : 'polling');
}

let poll = null;
function startPolling() {
  if (poll) return;
  markStream(false);
  poll = setInterval(async () => {
    try { render(await (await fetch('/api/state')).json()); } catch {}
  }, 2000);
}
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => { markStream(true); if (poll) { clearInterval(poll); poll = null; } try { render(JSON.parse(m.data)); } catch {} };
  es.onerror = () => { es.close(); markStream(false); startPolling(); setTimeout(connectSSE, 4000); };
}
connectSSE();
fetch('/api/state').then(r => r.json()).then(render).catch(startPolling);
</script>
</body>
</html>`;
