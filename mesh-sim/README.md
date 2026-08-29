# mesh-sim

Synthetic stucatch mesh with physics. Emits the serial stream of one board (the
gateway) byte-compatible with firmware v4 — data lines `{"v":4,...}` and log lines
`{"type":"log",...}`, NDJSON on stdout. Zero dependencies.

Where Luca's `pi-app/src/simulator.js` generates plausible lines, mesh-sim simulates
the mesh that produces them: nodes on a plane, log-distance path loss + gaussian
noise on every link, one clock authority, relay forwarding, impact events reaching
each sensor by distance, and the failure modes ingest has to survive.

```bash
node mesh-sim.js                          # 3 sensors + relay + hub, forever, real time
node mesh-sim.js --duration 90 --speed 60 # 90 mesh-seconds in 1.5 wall seconds
node mesh-sim.js | node ../pi-app/src/index.js   # feed the app (stdin mode permitting)
```

| flag | default | meaning |
|---|---|---|
| `--nodes N` | 3 | sensor count |
| `--no-relay` | relay on | drop the relay (no `hops:1` duplicates) |
| `--gateway hub\|relay\|<n>` | hub | whose serial you're reading — sensor gateways log `sync`/`range`/`alarm`, print self-STATUS without `rssi` |
| `--loss P` | 0 | extra per-link drop probability → seq gaps |
| `--impacts S` | 20 | mean seconds between impacts (0 = never) |
| `--reboot S` | 0 | mean seconds between sensor reboots (fresh random seq, boots+1, epoch 0 until next sync) |
| `--speed X` | 1 | time multiplier |
| `--duration S` | 0 | virtual seconds, 0 = forever |
| `--seed N` | 1 | deterministic runs |
| `--no-dev` | dev on | strip per-packet `tx`/`rx` traces, like `DEV 0` firmware |

What it reproduces faithfully:

- **identity + resends** — alarms re-broadcast twice (+200 ms/+1 s) with the same
  `(origin, seq)` and original `stamped`
- **relayed duplicates** — same utterance, second line with `via` = relay, `hops:1`,
  its own `rssi`
- **clock model** — per-node boot skew, offset adopted from SYNC, `epoch` = sync seq,
  reboot resets to epoch 0
- **rssi physics** — `-40 − 22·log10(d)` + noise, floor at −92; `peerRssi` in RANGE
  replies measures the sensor↔sensor edge
- **bearing frames** — each sensor has a random mounting rotation, like real installs

Validation: a 90-second run (743 lines) parses 100% clean through
`pi-app/src/protocol.js` `parseLine` — zero `invalid`, zero `junk`.
