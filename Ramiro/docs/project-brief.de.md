# UGS Mesh — Projekt-Briefing

**European Defense Tech Hackathon, Hamburg — 28.–30. Aug. 2026**
**Team:** „A low-cost, AI-powered unattended ground sensors" (4 Personen)
**Challenge:** 04 — Protecting a Critical Site From Small Drones (*Own challenge*:
Verallgemeinerung auf eine mesh-basierte, dauerhafte Perimeterverteidigung).

> Arbeitsdokument, für das Team. Siehe auch das englische Briefing (`docs/project-brief.md`)
> für weitere Details.

---

## 1. Zusammenfassung

Ein kostengünstiges Mesh aus unbeaufsichtigten Bodensensoren (UGS), das einen festen
Standort oder Perimeter überwacht und die Beobachtungen aller Knoten zu **einem
kohärenten Lagebild in Beweisqualität** fusioniert: was erkannt wurde (Infanterie,
Drohne, Fahrzeug), wo, mit welcher Konfidenz und mit einer Rohdaten-Beweisspur —
ausreichend, um eine Patrouille oder eine Boarding-Entscheidung zu steuern. Die
Absicherung gegen Angriffe auf die Sensorebene selbst ist ein Kernmerkmal, kein
Nachgedanke.

## 2. Problem & Nutzer

- **Nutzer:** ein Operator, der einen festen Standort oder eine Zufahrt verteidigt
  (Hafen, Basis, Energieknoten, Grenzabschnitt).
- **Schmerzpunkt:** kleine, signaturarme Eindringlinge (abgesessene Infanterie bei
  Nacht, ein Quadcopter mit Sprengladung) bleiben unentdeckt. Wo Sensoren existieren,
  alarmieren sie unabhängig voneinander — der Operator sieht eine Wand aus Alarmen und
  kann einen von fünf Sensoren erfassten Eindringling nicht von fünf getrennten
  Bedrohungen unterscheiden. Die Reaktion stockt.
- **Die Challenge verlangt:** ein bezahlbares, mehrschichtiges System aus
  Erkennen–Klassifizieren–Alarmieren, das seine Sensoren zu **einem kohärenten Bild**
  fusioniert, plus eine explizite Antwort darauf, *wie der Gegner die Lösung angreift
  oder stört*.

## 3. Systemüberblick

1. **Knoten.** Günstige Batterieeinheiten (ESP32 + ein Sensor: Mikrofon,
   PIR-Bewegung, Geophon/Vibration). Unbeaufsichtigt im Gelände verteilt.
2. **Edge-Inferenz.** Jeder Knoten führt lokal ein vortrainiertes Modell aus und sendet
   eine kurze Nachricht — *„N03: Drohne, 10:15:03, Konf. 0,82"* — nicht die Roh-Audio-
   oder -Videodaten.
3. **Mesh.** Die Knoten leiten die Nachrichten der Nachbarn Sprung für Sprung zu einem
   Wurzelknoten weiter; fällt einer aus, findet die Nachricht einen anderen Weg.
4. **Fusion-Kern (unsere Software).** Auf einem Laptop: ordnet Erkennungen zu Tracks
   pro Objekt, fusioniert Konfidenz über Modalitäten, klassifiziert die Bedrohung,
   entscheidet über Alarme, speichert Beweise, bewertet die Vertrauenswürdigkeit jedes
   Knotens.
5. **Operator-Ansicht.** Eine Karte mit Knoten und bewegten Tracks sowie ein
   priorisierter Alarm-Feed mit Beweisen per Klick.

## 4. Architektur

```
  UGS-KNOTEN (xN)             MESH                 FUSION-KERN (Laptop)          OPERATOR
 ┌───────────────┐        ┌───────────┐        ┌───────────────────────┐     ┌──────────┐
 │ Mik / PIR /   │        │           │        │  Gateway: Sig prüfen  │     │ Karte +  │
 │ Geophon /     │─Erk.──▶│ Mesh-Relay│─JSON──▶│  + validieren + spei. │────▶│ Alarm-   │
 │ Kamera / RF   │ (Edge- │ (ESP-NOW /│ signiert│  Fusion → Tracks     │     │ Feed +   │
 │  + ESP32      │ Modell)│  LoRa /   │ pro Kn. │  Alarme + Beweise    │     │ Beweise  │
 │               │        │  MQTT)    │        │  Knoten-Vertrauen     │     │          │
 └───────────────┘        └───────────┘        │  API (FastAPI, DuckDB)│     └──────────┘
        │                                      └───────────────────────┘
        └── MESH-SIMULATOR: synthetische Knoten senden dasselbe signierte JSON ──┘
```

### Nachrichtenvertrag (Knoten → Kern)

```json
{
  "node_id": "N03",
  "seq": 1421,
  "ts": "2026-08-30T10:15:03.412Z",
  "pos": { "lat": 53.54051, "lon": 9.98931 },
  "modality": "acoustic",
  "detection": { "class": "drone", "confidence": 0.82 },
  "raw_ref": "N03/clip_20260830_101503.wav",
  "sig": "HMAC-SHA256 über das kanonische JSON aller Felder außer sig"
}
```

- `modality`: `acoustic | seismic | pir | magnetometer | rf | camera`
- `detection.class`: `drone | person | vehicle | unknown | clear`
- `seq`: pro Knoten monoton steigend → Replay-Schutz.
- **Keepalive:** dieselbe Nachricht mit `class:"clear"` alle N Sekunden → damit der
  Kern weiß, dass ein Knoten lebt (nötig für die Jamming-/Ausfallerkennung).
- `sig`: HMAC-SHA256 mit einem symmetrischen Schlüssel pro Knoten, bei der Ausbringung
  hinterlegt.

**Diesen Vertrag am Freitag einzufrieren hat oberste Priorität** — dann können Hardware
und Software parallel arbeiten, ohne sich zu blockieren.

## 5. Aufgabenteilung

| Bereich | Verantwortlich |
|---|---|
| Physische Knoten: Board, Sensor, Verkabelung, Löten, Flashen | Hardware-Team (Yurii) |
| Mesh-Firmware auf dem Board (ESP-NOW / painlessMesh) | Yurii (Software unterstützt beim Code) |
| HMAC-Signierung pro Nachricht in der Firmware (~5 Zeilen, mbedTLS) | Yurii, laut Vertrag |
| Kamera + vortrainierte Erkennung (optionaler Bonus) | Pruthviraj |
| **Gateway, Fusion-Kern, Alarmierung, Beweise, Dashboard** | **Ramiro** |
| **Mesh-Simulator** | **Ramiro** |
| **Sicherheitsebene (Auth, Knoten-Vertrauen, Jamming-Erkennung)** | **Ramiro** |
| Repo-Infrastruktur: git, Feature-Branches, docker compose | Ramiro |

**Grenze:** sobald die Daten den Wurzelknoten verlassen, ist es Software.

## 6. Software-Kern (Ramiro)

- **Gateway** — `POST /ingest`: Signatur prüfen, Schema validieren, Knoten-Lebendigkeit
  verfolgen, in DuckDB speichern. Außerdem `/nodes`, `/tracks`, `/alerts`, `/health`.
- **Fusion** — eine neue Erkennung wird einem Track zugeordnet, wenn sie innerhalb von
  `Δt` (~8 s) und `Δd` (~150 m, pro Modalität einstellbar) der letzten Aktualisierung
  liegt; sonst neuer Track. Track-Konfidenz kombiniert die Einzelkonfidenzen, wird
  erhöht, wenn ≥2 verschiedene Modalitäten übereinstimmen, und klingt mit der Zeit ab.
  Klasse = vertrauensgewichtete Mehrheitsentscheidung. Lebenszyklus:
  `tentative → confirmed → stale → closed`.
- **Alarmierung** — Priorität = f(Klasse, Abstand zum Schutzobjekt, Konfidenz,
  Anflugvektor). Ein Alarm pro Track, wird an Ort und Stelle aktualisiert. Beweise =
  jede beitragende Erkennung + `raw_ref` + Knoten-Vertrauen zum Zeitpunkt. Alarmtypen:
  `intrusion`, `node_untrusted`, `mesh_degraded`.
- **Dashboard (Streamlit)** — Knotenkarte + Live-Tracks + priorisierter Alarm-Feed mit
  Detailansicht der Beweise.
- **Mesh-Simulator** — synthetische Knoten, die dasselbe signierte JSON senden, mit
  realistischem Rauschen (Fehlalarme durch Wind/Vögel, ein ausfallender Knoten). Das
  ist der **primäre Demo-Pfad**, kein Ersatz. Enthält Angriffsmodi (siehe §7).

## 7. Sicherheitsebene (Ramiro)

Drei vorführbare Funktionen, jede einem realen Angriff zugeordnet:

| # | Funktion | Abgewehrter Angriff |
|---|---|---|
| 1 | **Nachrichtenauthentifizierung** — HMAC-SHA256, Schlüssel pro Knoten. Das Gateway prüft `sig`. Modi: `lenient` (annehmen + als `verified:false` markieren) während der Integration, `strict` (ablehnen) für die Demo. Replay-Schutz durch Ablehnen von `seq ≤ last_seen` pro Knoten. | Gefälschte Nachrichten / eingeschleuster Fremdknoten / Manipulation im Transit (**Außentäter**). |
| 2 | **Verhaltensbasierter Knoten-Vertrauenswert** — unabhängig von Krypto. Wert pro Knoten in [0,1] aus: Nachbar-Übereinstimmung, Anomalie der Nachrichtenrate gegenüber dem Normalwert, anhaltend unmögliche Meldungen (Erkennungen, während alle Nachbarn `clear` melden), Regelmäßigkeit der Keepalives. Niedriger Wert → Erkennungen werden in der Fusion abgewertet, dann isoliert; löst `node_untrusted` mit Beweisen aus. | Ein physisch **übernommener** Knoten mit gültigen Schlüsseln, der lügt (**Innentäter**). |
| 3 | **Erkennung von Mesh-Degradation** — korreliertes Schweigen (viele Knoten eines Sektors stellen die Keepalives innerhalb kurzer Zeit ein → wahrscheinlich Jamming) von unabhängigem Einzelausfall unterscheiden. Löst `mesh_degraded` für den betroffenen Sektor aus; das System arbeitet mit den erreichbaren Knoten weiter (graceful degradation). | HF-**Jamming / DoS** des Mesh. |

**Roadmap (genannt, nicht gebaut):** AES-Verschlüsselung der Nutzlast (verbirgt
Knotenpositionen und Abdeckung vor Lauschern), Schlüsselrotation, Secure Boot auf den
Knoten, hash-verkettetes, manipulationssicheres Beweisprotokoll, Ratenbegrenzung pro
Knoten, Backend an `127.0.0.1` gebunden.

## 8. KI-Ansatz

Die Edge-Inferenz nutzt **ausschließlich vortrainierte Modelle** — kein Training oder
Fine-Tuning innerhalb von 48 h. Audio: YAMNet (AudioSet-Klassen inkl. Flugzeug).
Kamera: YOLO (COCO: Person, Auto, LKW). Für die Demo liefert der Simulator die
Erkennungslabels direkt, sodass die gesamte Pipeline **ohne laufendes Modell**
vorführbar ist. Eine Live-Erkennung mit Kamera + YOLO ist ein optionaler Bonus, wenn
ein Teammitglied sie übernimmt.

## 9. Umfang

**MVP (muss live laufen):** 4–6 Knoten (real oder simuliert), die die signierte
Nachricht senden · Gateway prüfen + validieren + speichern · Fusion → Tracks auf einer
Karte · priorisierte, deduplizierte Alarme mit Beweisen · Dashboard (Karte + Feed) ·
ein skriptiertes Szenario (Eindringling überquert, Track entsteht, ein Alarm) ·
Sicherheits-Demo (Fremdknoten abgelehnt + übernommener Knoten durch Vertrauenswert
erkannt + Jamming als `mesh_degraded`).

**Nice-to-have:** ein realer ESP-Knoten end-to-end integriert · Live-Kamera + YOLO ·
Beweis-Wiedergabe im Dashboard · Abdeckungs-/Blindfleck-Overlay.

**Außerhalb des Umfangs:** mehrere reale Modalitäten gleichzeitig · jegliches
Modelltraining · produktives LoRa-Multi-Hop · ruggedisierte Hardware · Multi-Standort.

## 10. Zeitplan

| Wann | Ziel |
|---|---|
| **Fr Abend** | Umfang, Rollen, Stack, Repo, **Nachrichtenvertrag (inkl. Signierung)** festlegen. Ramiro stellt das Grundgerüst auf: Repo, docker compose, `/health`, Datenmodelle. |
| **Sa vormittags** | Gateway + Simulator + einfache Fusion end-to-end (Nachricht → Track). |
| **Sa nachmittags** | Alarmierung + Dashboard-Karte. (Ramiro Fokus-Sprint von zu Hause, Team informiert.) |
| **Sa Abend** | Skriptiertes Szenario end-to-end; realen Knoten integrieren, falls verfügbar; Sicherheitsfunktionen. |
| **So 09:00** | Funktionen einfrieren. Backup-Demo-Video aufnehmen. |
| **So 10:00–12:00** | Testen, kleine Korrekturen, Pitch-Probe. 12:00 harter Freeze. |
| **So 13:00** | Demo Day (3–5 Min. Pitch + Q&A). |

## 11. Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Hardware am Samstag nicht bereit | Simulator ist der primäre Demo-Pfad; Hardware kommt additiv dazu. |
| Späte Integration / Abweichung im Nachrichtenformat | Vertrag am Freitag eingefroren; git + Docker ab der ersten Stunde. |
| Live-Demo schlägt fehl | Backup-Video am Sonntag um 09:00 aufgenommen. |
| Signierung blockiert die Integration | Gateway im Modus `lenient` während der Integration, `strict` für die Demo. |
| Scope Creep | Feste Liste „außerhalb des Umfangs"; das MVP ist geschützt. |
| Dashboard im Venue-WLAN exponiert | Streamlit in der Entwicklung an `127.0.0.1` binden. |

## 12. Gegnermodell (für den Pitch)

Wir gehen davon aus, dass der Gegner die Sensorebene selbst angreift. Drei Angriffe,
drei Antworten: gefälschte / eingeschleuste Knoten → **signierte Nachrichten** (Krypto
stoppt den Außentäter); ein physisch übernommener Knoten mit gültigen Schlüsseln →
**verhaltensbasierter Vertrauenswert** (Abgleich mit den Nachbarn, stoppt den
Innentäter); HF-Jamming → **Erkennung korrelierter Ausfälle** macht aus dem Angriff
einen `mesh_degraded`-Alarm, und das System läuft mit den noch erreichbaren Knoten
weiter.

## 13. Demo-Ablauf

1. Karte: 5 Knoten decken einen Perimeter ab, alle grün.
2. Eindringling (Drohne) tritt im NO ein. Knoten N03 (akustisch) erkennt.
3. N04 (seismisch) stimmt Sekunden später zu → Fusion führt zu einem Track zusammen,
   Konfidenz steigt auf ~0,86.
4. Ein priorisierter Alarm: *„Drohne, Sektor NO, 0,86, Knoten N03+N04, Beweise
   angehängt"*.
5. Operator klickt → Beweisspur (Roh-Referenzen pro Knoten, Knoten-Vertrauen zum
   Zeitpunkt).
6. **Wendung 1:** ein Fremdknoten ohne gültige Signatur wird eingeschleust → am Gateway
   abgelehnt, in einem Seitenpanel angezeigt, der Feed bleibt sauber.
7. **Wendung 2:** ein gültiger Knoten meldet ständig „Fahrzeug" ohne Nachbar-
   Übereinstimmung → Vertrauenswert sinkt, `node_untrusted`-Alarm, seine Erkennungen
   verschmutzen das Bild nicht mehr.
8. **Wendung 3:** eine Gruppe von Knoten wird stummgeschaltet → `mesh_degraded`-Alarm
   für diesen Sektor, der Rest der Karte bleibt aktiv.
9. Abschluss: *„ein kohärentes Lagebild in Beweisqualität — und widerstandsfähig gegen
   Angriffe auf die Sensoren selbst."*

## 14. Stack & Konventionen

- Python. Backend: FastAPI + uvicorn. Speicher: DuckDB. Dashboard: Streamlit + Karte
  (folium / pydeck).
- Transport vom Wurzelknoten: MQTT (`paho-mqtt`) oder USB-Seriell (`pyserial`) — mit
  der Hardware abgestimmt.
- Integration: git, Feature-Branches, `docker compose`.
- Umgebung: Kali-VM, Python über `uv`, ein venv pro Projekt. `ruff` fürs Linting.
  Geheimnisse in `.env` (in `.gitignore`).
- `Makefile`: `run`, `dash`, `test`, `lint`.

## 15. Offene Fragen ans Team

1. Reale Sensor-Hardware für Samstag oder simulierter Feed?
2. Rollenaufteilung — Knoten / Mesh auf dem Board / Edge-Modelle / Kamera: wer
   übernimmt was? (Ramiro übernimmt alles ab dem Wurzelknoten.)
3. Transport vom Wurzelknoten: MQTT, USB-Seriell oder WLAN-HTTP?
4. Kann die Knoten-Firmware pro Nachricht eine HMAC-SHA256-Signierung hinzufügen?
5. Referenzstandort für die Demo-Karte (ein konkreter Hafen / eine Basis bei Hamburg)?
6. Das Nachrichten-JSON-Schema bestätigen.
