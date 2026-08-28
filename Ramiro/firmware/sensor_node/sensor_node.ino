// UGS Mesh — sensor node firmware (painlessMesh)
//
// One of these per sensor ESP32. Set NODE_ID / MODALITY / SENSOR_PIN per node
// before flashing. It joins the mesh, sends a "clear" keepalive every few
// seconds, and calls sendData() on a sensor event.
//
// The JSON it broadcasts MUST match app/models.py::NodeMessage:
//   {"node_id":"N01","seq":12,"modality":"pir","detection":{"class":"person","confidence":0.7}}
//
// Libraries: painlessMesh ^1.5.6, ArduinoJson ^7, TaskScheduler ^3.8
// See docs/painlessmesh-guide.md for setup, flashing and testing.

#include <Arduino.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "painlessMesh.h"

// ---- mesh config (identical on every node) ----
#define MESH_PREFIX   "ugs-mesh"
#define MESH_PASSWORD "ugs-mesh-shared-secret"   // >= 8 chars; change before the event
#define MESH_PORT     5555
#define MESH_CHANNEL  6                          // fixed channel = less venue interference

// ---- per-node identity: EDIT THESE FOR EACH NODE ----
#define NODE_ID      "N01"                       // must exist in config/nodes.json
#define MODALITY     "pir"                       // acoustic|seismic|pir|magnetometer|rf|camera
#define SENSOR_PIN   4                           // digital sensor: HIGH == event
#define KEEPALIVE_MS 5000
#define DEBOUNCE_MS  2000

painlessMesh mesh;
Scheduler    userScheduler;
Preferences  prefs;

uint32_t g_seq = 0;        // last used sequence number
uint32_t g_seq_hw = 0;     // high-water mark stored in NVS (burst-persisted)
uint32_t lastEventMs = 0;

// Monotonic seq that survives reboot. Persist once per 1000 to spare flash.
uint32_t nextSeq() {
  uint32_t s = ++g_seq;
  if (s >= g_seq_hw) {
    g_seq_hw = s + 1000;
    prefs.putUInt("seq_hw", g_seq_hw);
  }
  return s;
}

void sendDetection(const char* cls, float confidence) {
  JsonDocument doc;                       // ArduinoJson 7; for v6 use StaticJsonDocument<160>
  doc["node_id"] = NODE_ID;
  doc["seq"] = nextSeq();
  doc["modality"] = MODALITY;
  JsonObject d = doc["detection"].to<JsonObject>();
  d["class"] = cls;
  d["confidence"] = confidence;
  String out;
  serializeJson(doc, out);
  mesh.sendBroadcast(out);                // out is an lvalue -> ok
}

// The sendData() the hardware team asked for. Class + confidence come from the
// real classifier once it exists; for now it reports a person sighting.
void sendData() {
  sendDetection("person", 0.70);
}

Task tKeepalive(KEEPALIVE_MS, TASK_FOREVER, []() { sendDetection("clear", 0.0f); });

void setup() {
  Serial.begin(115200);

  prefs.begin("ugs", false);
  g_seq_hw = prefs.getUInt("seq_hw", 0);
  g_seq = g_seq_hw;                       // resume ahead of anything used before

  mesh.setDebugMsgTypes(ERROR | STARTUP);
  mesh.init(MESH_PREFIX, MESH_PASSWORD, &userScheduler, MESH_PORT, WIFI_AP_STA, MESH_CHANNEL);
  mesh.setContainsRoot(true);             // there is a root somewhere in this mesh

  userScheduler.addTask(tKeepalive);
  tKeepalive.enable();

  pinMode(SENSOR_PIN, INPUT);
}

void loop() {
  mesh.update();

  // --- replace with the real sensor read / edge classifier ---
  if (digitalRead(SENSOR_PIN) == HIGH && millis() - lastEventMs > DEBOUNCE_MS) {
    lastEventMs = millis();
    sendData();
  }
}
