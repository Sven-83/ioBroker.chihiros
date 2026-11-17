![Logo](admin/chihiros.png)

# ioBroker.chihiros

**Tests:** ![Test and Release](https://github.com/Sven-83/ioBroker.chihiros/workflows/Test%20and%20Release/badge.svg)

## Chihiros aquarium devices for ioBroker

Connects Chihiros aquarium devices (WRGB II light, dosing pump, CO2 controller, Doctor, fan) to ioBroker over
**Bluetooth Low Energy**, without the Chihiros cloud and without the WiFi hub. The adapter reaches the devices through an
**ESPHome Bluetooth proxy** (ESP32 with `bluetooth_proxy: active: true`) placed near the aquarium.

German description: [docs/de/README.md](docs/de/README.md)

Status: early version. Reading all devices; controlling the light, manual doses of the dosing pump and the fan level. More commands follow in the next versions.

### What it does (so far)

- Connects to one ESPHome Bluetooth proxy (API encryption recommended), reconnects with backoff
- Shows per configured device whether it is heard (`reachable`), when (`lastSeen`), signal strength (`rssi`) and its Bluetooth name
- Warns in the log when a device is missing; **seasonal** devices (e.g. a fan only used in summer) are reported without a warning
- Re-subscribes when the proxy stops forwarding advertisements (another API client on the same proxy takes them over since ESPHome 2026.7)
- **Reads** all reachable devices one after the other in short Bluetooth connections (default every 5 minutes, about 1–2 s per device). Reading sends query commands only (plus the clock when needed, see below).
  - Dosing pump: dosed ml per pump in total and today
  - Light: device clock, schedule (on times as in the app, sunrise/sunset duration, points) and the red level the schedule gives now. The light does not report its green, blue and white values; the app keeps them itself.
  - Doctor: water temperature
  - Fan: water and room temperature, humidity
  - CO2 controller: reachable only (it reports no valve state)
- **Controls** the light: red, green, blue, white (0-255) and on/off. Commands wait for a running read and are sent in their own short connection (login, clock, command). The light does not report these values back: the states show what this adapter set last (`commandResult` says "sent, not confirmed"). Changes made in the app are not seen.
- **Manual dose** of the dosing pump: write ml (0.1-5 per command, safety limit) to `pumpN.doseNow`. About 15 s plus 6 s per ml later the adapter reads the total counter: `commandResult` says "confirmed: pump N total a -> b ml" or "not confirmed".
- **Fan level** 0-20 (0 = off) in `level`. The fan does not report its level: the state shows what this adapter set last. The temperature control of the app is not supported yet.
- **Power measurement** (optional, fan and CO2 controller): with a power state per device (e.g. a Shelly plug, only read, never switched) the adapter shows `running` (fan, from 0.5 W) or `valveOpen` (CO2, from 1 W). After every fan level command it checks the power 10 s later; if the fan did not start, it kicks it like in the app: levels 20, 11, 4, 20, 11, each in its own connection with a power check, then the wanted level (about 1 minute at most). Like the app, every fan command first sends the two queries a5/04 [06] and [08]. `commandResult` says "confirmed: running", "confirmed after kick" or "not running after 5 kick steps" (warning).
- **Sets the device clocks** (can be switched off): the light when its clock differs by 2 minutes or more, the other devices after the adapter start, when they are heard again (e.g. after a power cut) and once a day. Every command also sets the clock, like the app.

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
| Set device clocks | Set the clocks automatically (see above), default on. |
| Read interval (minutes) | All reachable devices are read every this many minutes (default 5). While the app is open, a device cannot be read. |
| Devices | Name, type (light, dosing pump, CO2 controller, Doctor, fan), MAC address, "seasonal" and an optional power state (W) per device. |

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
| `devices.<name>.lastRead` | Time of the last successful read |
| `devices.<name>.readError` | Error of the last read, empty when it worked ("held by the app/hub?" when the connection was refused) |
| `devices.<pump>.pumpN.total` / `.today` | Dosing pump: dosed ml of pump N in total / today (today counts scheduled doses only) |
| `devices.<light>.clock` / `.clockDeviation` | Light: device clock and its difference to local time in minutes (large after a power cut) |
| `devices.<light>.schedule` | Light: on times including sunrise and sunset, e.g. `11:00-12:00, 14:00-20:00` |
| `devices.<light>.sunrise` / `.sunset` | Light: sunrise / sunset duration in minutes (first window) |
| `devices.<light>.schedulePoints` / `.scheduledLevel` | Light: schedule points (JSON) and the red level by schedule now (green, blue, white are not reported) |
| `devices.<light>.red` / `.green` / `.blue` / `.white` | Light: channel values 0-255, **writable** (last value set by this adapter) |
| `devices.<light>.on` | Light: **writable**; false = all channels 0, true = all channels to the values above |
| `devices.<pump>.pumpN.doseNow` | Dosing pump: **writable**, dose this many ml now (0.1-5) |
| `devices.<fan>.level` | Fan: **writable**, level 0-20 (0 = off), last value set by this adapter |
| `devices.<fan>.running` / `devices.<co2>.valveOpen` | From the configured power state (only with a power state) |
| `devices.<name>.lastCommand` / `.commandResult` | Last command and its result (`sent, not confirmed` or `error: ...`) |
| `devices.<doctor>.waterTemp` | Doctor: water temperature in °C |
| `devices.<fan>.waterTemp` / `.roomTemp` / `.humidity` | Fan: water and room temperature in °C, humidity in % |

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
- (Sven-83) read values of dosing pump, light, Doctor and fan in short GATT sessions (read only)
- (Sven-83) light: on times including sunrise/sunset as in the app, new states `sunrise`/`sunset`; `scheduledLevel` is the red channel only
- (Sven-83) control the light (red, green, blue, white, on/off) through a command queue; set the device clocks
- (Sven-83) manual dose of the dosing pump (max. 5 ml), confirmed by the total counter
- (Sven-83) fan level 0-20
- (Sven-83) a missing write acknowledgement of a command is reported as "not confirmed" instead of an error
- (Sven-83) optional power state per device: fan running / CO2 valve open; fan commands checked by the power, kick when the fan does not start

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
