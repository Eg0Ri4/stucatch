# AES-256 on ESP32-C3 — Feasibility, Limits, and Plan

**Question from the team:** how fast and how "real" is AES-256 encryption on an
ESP32-C3 Mini, given the data has to be secure?

**Short answer:** feasible, fast enough with large margin, and cryptographically sound
this weekend **if** we follow three rules (authenticated mode, unique nonce, per-node
key). What we cannot do this weekend is hardware-backed key storage, key rotation, and
physical tamper resistance — those are the roadmap.

---

## 1. The chip

ESP32-C3: single-core RISC-V @ 160 MHz, 400 KB SRAM.

- **Hardware AES accelerator** — AES-128/192/256, modes ECB/CBC/CTR/OFB/CFB. Enabled
  by default in ESP-IDF and Arduino-ESP32 (`CONFIG_MBEDTLS_HARDWARE_AES=y`). `mbedtls`
  uses it automatically.
- **Hardware SHA-256** — on by default. Relevant if we use CBC + HMAC-SHA256.
- **GHASH (the GCM authentication step) runs in software** on the C3 → GCM is ~10×
  slower than CBC. Still far more than fast enough for small messages.
- Hardware RNG (good entropy while the WiFi/BT radio is on).
- eFuse key blocks + flash encryption + Secure Boot v2 exist on the chip (see §4).

## 2. Performance

No published native-C benchmarks for the C3 itself. The **ESP32-C6** is the closest
proxy (same RISC-V core, same 160 MHz, same accelerator generation). wolfSSL figures,
1024-byte blocks, 160 MHz:

| Operation | Hardware | Software only |
|---|---|---|
| AES-256-CBC encrypt | ~4.3 MB/s | ~1.3 MB/s |
| AES-256-GCM (encrypt + tag) | ~0.42 MB/s | ~0.4 MB/s |
| SHA-256 | ~12 MB/s | ~1.4 MB/s |

Real C3 data point (MicroPython, heavy interpreter overhead — treat as a floor):
AES-256-CBC ~333 KB/s.

**Applied to our case** — a sensor message is a ~250-byte JSON payload:

| Scheme | Time per message | CPU load at 5 msg/s |
|---|---|---|
| AES-256-GCM | ~0.6 ms crypto + ~0.5 ms setup ≈ **1–2 ms** | **~0.5%** |
| AES-256-CBC + HMAC-SHA256 | ≈ **< 0.5 ms** | ~0.2% |

- **Added latency:** 1–2 ms per hop vs 10–150 ms for one painlessMesh hop → < 1% of
  the path. Imperceptible.
- **Energy:** the WiFi transmission of the same message costs 100–1000× more than the
  crypto. Crypto is in the noise.
- **RAM:** GCM context ~400 bytes out of 400 KB.

**Conclusion: speed is a non-issue.** The engineering effort is nonce and key
handling, not throughput.

## 3. What we CAN do this weekend

- **AES-256-GCM per message**, one 256-bit key per node.
- Gives, end to end (node → mesh → root → serial → Raspberry Pi):
  - **Confidentiality** — payload hidden from anyone sniffing the mesh RF (node
    positions, what was detected, coverage).
  - **Integrity + authenticity** — the 16-byte GCM tag; a modified or forged message
    is rejected.
  - **Replay protection** — `seq` counter feeds the nonce and is checked monotonic on
    the Pi.
- Keys pre-written to NVS at flash time, kept out of git.
- The **mesh simulator** produces the identical encrypted format, so the demo works
  with or without real nodes.
- **Effort:** ~half a day of firmware (mostly nonce persistence + testing) + a small
  decrypt module on the Pi.

## 4. What we CANNOT / should NOT do this weekend

- **eFuse key storage + flash encryption + Secure Boot** — these are **irreversible**
  once burned on real silicon and risky to enable under hackathon time pressure.
  Consequence to state honestly: right now, someone who **steals a node and dumps its
  flash can read that node's key**. Acceptable for a prototype; it is the first
  production task.
- **Key provisioning and rotation at scale** — we hand-place keys. No key exchange
  (ECDH), no re-keying.
- **Physical tamper resistance** — none.
- **The USB/serial cable from the root ESP32 to the Pi** — encrypting it protects
  against a compromised relay node, not against a physical tap inside the enclosure.
- **Custom cipher modes or a hand-rolled MAC** — never. Use GCM.

## 5. The three rules (break any of these and it is not secure)

1. **Authenticated mode only.** AES-256-GCM, or AES-256-CBC + HMAC-SHA256
   (encrypt-then-MAC). **Never ECB. Never bare CBC/CTR** (silently modifiable).
2. **The nonce must never repeat under one key.** `nonce = node_id (4 B) || seq
   (8 B)`. `seq` must **survive reboot and deep-sleep** — persisted in NVS. Nonce
   reuse in GCM allows plaintext recovery *and* message forgery. This is the single
   most important detail.
3. **Per-node 256-bit key, in NVS, never in source control.**
4. (Corollary) `seq` strictly increasing per node; the Pi drops anything
   out-of-order or repeated.

## 6. Message format

Cleartext envelope carrying an encrypted payload:

```json
{
  "node_id": "N03",
  "seq": 1421,
  "nonce": "base64(12 bytes)",
  "ct":    "base64(ciphertext)",
  "tag":   "base64(16 bytes)"
}
```

Payload (plaintext, before encryption):

```json
{ "ts": "2026-08-30T10:15:03.412Z",
  "pos": { "lat": 53.54051, "lon": 9.98931 },
  "modality": "acoustic",
  "detection": { "class": "drone", "confidence": 0.82 },
  "raw_ref": "N03/clip_20260830_101503.wav" }
```

- **AAD** (authenticated, not encrypted) = `node_id:seq`. Binds the ciphertext to that
  identity and counter — it cannot be moved to another node slot or replayed under a
  different `seq` without the tag failing.
- **Overhead:** +28 bytes/message (12 nonce + 16 tag), ×1.33 for base64 over a text
  mesh. Keep the payload compact.

## 7. Code — ESP32 sender (Arduino / ESP-IDF, mbedTLS)

```cpp
#include <Preferences.h>
#include "mbedtls/gcm.h"
#include "mbedtls/base64.h"

static uint8_t  NODE_KEY[32];          // 256-bit key, provisioned once into NVS
static const uint32_t NODE_ID = 0x4E303300;   // "N0 3" packed — example
static Preferences prefs;

static uint64_t g_seq = 0;             // last used counter
static uint64_t g_seq_hw = 0;          // high-water mark stored in NVS

void crypto_begin() {
  prefs.begin("ugs", false);
  if (prefs.getBytes("key", NODE_KEY, sizeof(NODE_KEY)) != 32) {
    // provisioning error — stop and signal on an LED, do not send plaintext
    while (true) { delay(1000); }
  }
  // Resume AHEAD of anything used before the reboot -> no nonce can ever repeat.
  g_seq_hw = prefs.getULong64("seq_hw", 0);
  g_seq    = g_seq_hw;
}

// Persist in bursts of 1000 to spare NVS flash endurance (~100k writes/entry).
static uint64_t next_seq() {
  uint64_t s = ++g_seq;
  if (s >= g_seq_hw) {
    g_seq_hw = s + 1000;
    prefs.putULong64("seq_hw", g_seq_hw);
  }
  return s;
}

static void build_nonce(uint8_t n[12], uint32_t id, uint64_t seq) {
  n[0]=id>>24; n[1]=id>>16; n[2]=id>>8; n[3]=id;
  for (int i = 0; i < 8; i++) n[4+i] = (seq >> (8 * (7 - i))) & 0xFF;
}

// Encrypt `payload_json` into a ready-to-send JSON envelope. Returns length or -1.
int encrypt_event(const char *payload_json, char *out, size_t out_cap) {
  uint64_t seq = next_seq();
  size_t   pl  = strlen(payload_json);

  uint8_t nonce[12]; build_nonce(nonce, NODE_ID, seq);
  uint8_t tag[16];
  uint8_t *ct = (uint8_t *) malloc(pl);
  if (!ct) return -1;

  char aad[28];
  int aad_len = snprintf(aad, sizeof(aad), "N03:%llu", (unsigned long long) seq);

  mbedtls_gcm_context gcm; mbedtls_gcm_init(&gcm);
  mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, NODE_KEY, 256);   // -> HW AES
  int rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT,
             pl, nonce, 12, (const uint8_t *) aad, aad_len,
             (const uint8_t *) payload_json, ct, 16, tag);
  mbedtls_gcm_free(&gcm);
  if (rc != 0) { free(ct); return -1; }

  char b_nonce[20], b_tag[28];
  size_t n, ct_cap = ((pl + 2) / 3) * 4 + 4;
  char *b_ct = (char *) malloc(ct_cap);
  mbedtls_base64_encode((unsigned char *) b_nonce, sizeof b_nonce, &n, nonce, 12);
  mbedtls_base64_encode((unsigned char *) b_tag,   sizeof b_tag,   &n, tag, 16);
  mbedtls_base64_encode((unsigned char *) b_ct,    ct_cap,         &n, ct, pl);
  free(ct);

  int len = snprintf(out, out_cap,
    "{\"node_id\":\"N03\",\"seq\":%llu,\"nonce\":\"%s\",\"ct\":\"%s\",\"tag\":\"%s\"}",
    (unsigned long long) seq, b_nonce, b_ct, b_tag);
  free(b_ct);
  return (len > 0 && (size_t) len < out_cap) ? len : -1;
}

// In the mesh code:
//   char env[512];
//   if (encrypt_event(payload_json, env, sizeof env) > 0)
//       mesh.sendBroadcast(String(env));
```

**One-time provisioning** (separate tiny sketch, run once per node before deployment):

```cpp
// prefs.begin("ugs", false);
// uint8_t key[32] = { /* 32 random bytes, unique per node, also stored on the Pi */ };
// prefs.putBytes("key", key, 32);
// prefs.putULong64("seq_hw", 0);
```

## 8. Code — Raspberry Pi receiver (Python, `cryptography`)

```python
import json, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Per-node 256-bit keys. Load from a file that is NOT in git (e.g. keys.local.json).
KEYS = { "N03": bytes.fromhex("<64 hex chars>"),
         "N04": bytes.fromhex("<64 hex chars>") }

_last_seq: dict[str, int] = {}

def decrypt_envelope(line: str) -> dict | None:
    """Return the verified payload dict, or None if the message must be dropped."""
    env  = json.loads(line)
    node = env["node_id"]
    key  = KEYS.get(node)
    if key is None:
        return None                                   # unknown node

    seq = int(env["seq"])
    if seq <= _last_seq.get(node, -1):
        return None                                   # replay / out of order

    nonce = base64.b64decode(env["nonce"])
    ct    = base64.b64decode(env["ct"])
    tag   = base64.b64decode(env["tag"])
    aad   = f"{node}:{seq}".encode()

    try:
        pt = AESGCM(key).decrypt(nonce, ct + tag, aad)   # raises on bad tag
    except Exception:
        return None                                   # forged / corrupted

    _last_seq[node] = seq
    msg = json.loads(pt)
    msg |= {"node_id": node, "seq": seq, "verified": True}
    return msg
```

## 9. Recommended sequencing

1. **Mesh working first, unencrypted.** Gateway accepts plaintext (`lenient` mode).
2. **Add GCM as a separate, isolated step** behind a flag. Sender and receiver
   switched together.
3. **If time runs out:** a working mesh + the simulator sending encrypted messages is
   enough for the demo. **Crypto must never block mesh bring-up.**

## 10. Pitch line

> "Messages are end-to-end encrypted and authenticated with AES-256-GCM and per-node
> keys — confidentiality, integrity, and replay protection from the node to the base.
> Hardware-backed key storage in eFuse and key rotation are the next step."

A defence jury respects a stated limit more than an overclaim.

---

## Sources

- [ESP-IDF Mbed TLS — ESP32-C3 (Espressif)](https://docs.espressif.com/projects/esp-idf/en/latest/esp32c3/api-reference/protocols/mbedtls.html)
- [Espressif RISC-V hardware-accelerated crypto, up to 1000% faster than software (wolfSSL)](https://www.wolfssl.com/espressif-risc-v-hardware-accelerated-cryptographic-functions-up-to-1000-faster-than-software/)
- [AES performance on ESP32-C3 vs ESP32-S3 (MicroPython discussion #9401)](https://github.com/orgs/micropython/discussions/9401)
- [HWCrypto vs mbedTLS timing (ESP32 Forum)](https://www.esp32.com/viewtopic.php?t=3080)
