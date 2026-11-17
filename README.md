![Logo](admin/chihiros.png)

# ioBroker.chihiros

**Tests:** ![Test and Release](https://github.com/Sven-83/ioBroker.chihiros/workflows/Test%20and%20Release/badge.svg)

## Chihiros aquarium devices for ioBroker

Connects Chihiros aquarium devices (WRGB II light, dosing pump, CO2 controller, Doctor, fan) to ioBroker over
**Bluetooth Low Energy**, without the Chihiros cloud and without the WiFi hub. The adapter reaches the devices through an
**ESPHome Bluetooth proxy** (ESP32 with `bluetooth_proxy: active: true`) placed near the aquarium.

German description: [docs/de/README.md](docs/de/README.md)

Status: early version. **Phase 1** – proxy connection and presence of the configured devices (listen only).
Reading values and controlling the devices follow in the next versions.

### What it does (so far)

- Connects to one ESPHome Bluetooth proxy (API encryption recommended), reconnects with backoff
- Shows per configured device whether it is heard (`reachable`), when (`lastSeen`), signal strength (`rssi`) and its Bluetooth name
- Warns in the log when a device is missing; **seasonal** devices (e.g. a fan only used in summer) are reported without a warning
- Re-subscribes when the proxy stops forwarding advertisements (another API client on the same proxy takes them over since ESPHome 2026.7)

### Requirements

- js-controller >= 6.0.11, admin >= 7.6.20, Node.js >= 22
- An ESPHome Bluetooth proxy (ESPHome >= 2026.10.2 recommended) in radio range of the devices, used by this adapter only
- Devices must **not** be held by the Chihiros app or the WiFi hub: a connected device does not advertise and only accepts one connection. Unlink the device from the hub in the app.

### Configuration

| Field | Meaning |
|---|---|
| Proxy host or IP | The ESPHome proxy near the aquarium. |
| API encryption key | `api: encryption: key` of the proxy (base64). Stored encrypted. |
| Missing after (minutes) | A device counts as not reachable after this silence (default 5). |
| Devices | Name, type (light, dosing pump, CO2 controller, Doctor, fan), MAC address and "seasonal" per device. |

Find the MAC addresses with any BLE scanner; Chihiros devices advertise as `DY…` (e.g. `DYDOSE…`, `DYNFAN…`).

### States

| State | Meaning |
|---|---|
| `info.connection` | Connected to the proxy and subscribed to advertisements |
| `info.proxyVersion` | ESPHome version of the proxy |
| `devices.<name>.reachable` | Device heard within the configured time |
| `devices.<name>.lastSeen` | Time of the last advertisement (updated at most once per minute) |
| `devices.<name>.rssi` | Signal strength in dBm |
| `devices.<name>.bleName` | Bluetooth name of the device |

### Security

- Chihiros devices use Bluetooth without pairing: anybody in radio range can control them. See [SECURITY.md](SECURITY.md).
- The adapter only talks to the configured MAC addresses and never "tries out" commands.
- Use API encryption on the ESPHome proxy and do not share the proxy with other API clients.

### Credits

Protocol knowledge builds on [chihiros-led-control](https://github.com/TheMicDiet/chihiros-led-control) (MIT) and own
captures. Chihiros is a trademark of its owner; this project is not affiliated with Chihiros.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- (Sven-83) proxy connection with backoff and advertisement watchdog, presence per configured device
- (Sven-83) no crash when a closed proxy connection still reports an error (e.g. missing API key)
- (Sven-83) no "not heard" warnings while the proxy is down or right after (re)connecting

### 0.0.1 (2026-11-17)

- (Sven-83) initial release

## License

MIT License

Copyright (c) 2026 Sven-83 <276080681+Sven-83@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
