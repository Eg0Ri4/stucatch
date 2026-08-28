// UGS Mesh — root / gateway node firmware (painlessMesh)
//
// This ESP32 is wired to the Raspberry Pi over USB. It joins the same mesh,
// receives every broadcast frame, and prints it verbatim to Serial, one JSON
// object per line. app/serial_bridge.py forwards those lines to the gateway.
//
// Libraries: painlessMesh ^1.5.6, ArduinoJson ^7, TaskScheduler ^3.8
// See docs/painlessmesh-guide.md.

#include <Arduino.h>
#include "painlessMesh.h"

#define MESH_PREFIX   "ugs-mesh"
#define MESH_PASSWORD "ugs-mesh-shared-secret"   // must match the sensor nodes
#define MESH_PORT     5555
#define MESH_CHANNEL  6

painlessMesh mesh;
Scheduler    userScheduler;

// A received mesh frame is already the sensor node's JSON string. Pass it
// straight to the Pi — one line per frame.
void onRx(uint32_t from, String& msg) {
  Serial.println(msg);
}

// Optional: a mesh-health line the Pi can use later for jamming/dropout
// detection. Kept off in v0 so the bridge only ever sees NodeMessage JSON.
// void onMeshChange() {
//   Serial.printf("{\"_mesh\":\"topology\",\"nodes\":%u}\n",
//                 (unsigned)(mesh.getNodeList().size() + 1));
// }

void setup() {
  Serial.begin(115200);

  mesh.setDebugMsgTypes(ERROR | STARTUP);
  mesh.init(MESH_PREFIX, MESH_PASSWORD, &userScheduler, MESH_PORT, WIFI_AP_STA, MESH_CHANNEL);
  mesh.onReceive(&onRx);
  // mesh.onChangedConnections(&onMeshChange);
  mesh.setRoot(true);
  mesh.setContainsRoot(true);
}

void loop() {
  mesh.update();
}
