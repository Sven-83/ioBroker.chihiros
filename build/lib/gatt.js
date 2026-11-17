"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var gatt_exports = {};
__export(gatt_exports, {
  SessionError: () => SessionError,
  findUart: () => findUart,
  runSession: () => runSession,
  uuidString: () => uuidString
});
module.exports = __toCommonJS(gatt_exports);
var import_protocol = require("./protocol");
class SessionError extends Error {
  /**
   * @param message Reason
   * @param busy True when the device was probably held by another connection
   */
  constructor(message, busy) {
    super(message);
    this.busy = busy;
  }
}
const NUS_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const CCCD = 10498;
function uuidString(o) {
  if (typeof o.uuid === "string" && o.uuid.length > 8) {
    return o.uuid.toLowerCase();
  }
  const list = Array.isArray(o.uuidList) ? o.uuidList : Array.isArray(o.uuid) ? o.uuid : null;
  if (list && list.length === 2) {
    try {
      const h = BigInt.asUintN(64, BigInt(String(list[0]))).toString(16).padStart(16, "0") + BigInt.asUintN(64, BigInt(String(list[1]))).toString(16).padStart(16, "0");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } catch {
      return "";
    }
  }
  if (typeof o.shortUuid === "number" && o.shortUuid > 0) {
    return `0000${o.shortUuid.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  return "";
}
function findUart(services) {
  var _a;
  for (const s of services) {
    const w = s.characteristicsList.find((c) => uuidString(c) === NUS_WRITE);
    const n = s.characteristicsList.find((c) => uuidString(c) === NUS_NOTIFY);
    if (w && n) {
      const d = ((_a = n.descriptorsList) != null ? _a : []).find((x) => uuidString(x).startsWith(`0000${CCCD.toString(16)}`));
      return { write: w.handle, notify: n.handle, cccd: d ? d.handle : null };
    }
  }
  return null;
}
async function runSession(api, opt, scheduler) {
  var _a;
  const sleep = (ms) => new Promise((r) => scheduler.setTimeout(r, ms));
  const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
    const t = scheduler.setTimeout(() => reject(new SessionError(`${what} timed out`, false)), ms);
    p.then(
      (v) => {
        scheduler.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        scheduler.clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
  let connected = false;
  let lastError = "";
  for (let i = 1; i <= opt.attempts && !connected; i++) {
    try {
      const res = await withTimeout(
        api.connectBluetoothDeviceService(opt.address, opt.addressType, false),
        15e3,
        "connect"
      );
      connected = !!(res == null ? void 0 : res.connected);
      if (!connected) {
        lastError = `error ${(_a = res == null ? void 0 : res.error) != null ? _a : "?"}`;
      }
    } catch (e) {
      lastError = e.message;
    }
    if (!connected && i < opt.attempts) {
      await sleep(1e3);
    }
  }
  if (!connected) {
    throw new SessionError(`no connection (${lastError})`, true);
  }
  const answers = [];
  let notifyHandle = -1;
  let wake = null;
  const listener = (m) => {
    if (Number(m == null ? void 0 : m.address) !== opt.address || (m == null ? void 0 : m.handle) !== notifyHandle) {
      return;
    }
    const raw = m.data;
    const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : Buffer.from(raw != null ? raw : []);
    const a = (0, import_protocol.decodeAnswer)(bytes);
    if (a) {
      answers.push(a);
      wake == null ? void 0 : wake();
    }
  };
  api.on("message.BluetoothGATTNotifyDataResponse", listener);
  try {
    const { servicesList } = await withTimeout(
      api.listBluetoothGATTServicesService(opt.address),
      15e3,
      "service list"
    );
    const uart = findUart(servicesList != null ? servicesList : []);
    if (!uart) {
      throw new SessionError("Nordic UART service not found", false);
    }
    notifyHandle = uart.notify;
    await withTimeout(api.notifyBluetoothGATTCharacteristicService(opt.address, uart.notify), 5e3, "notify");
    if (uart.cccd !== null) {
      await withTimeout(
        api.writeBluetoothGATTDescriptorService(opt.address, uart.cccd, new Uint8Array([1, 0])),
        5e3,
        "descriptor"
      );
    }
    const deadline = scheduler.now() + opt.timeoutMs;
    for (const f of opt.frames) {
      await withTimeout(
        api.writeBluetoothGATTCharacteristicService(opt.address, uart.write, f, true),
        5e3,
        "write"
      );
      await sleep(opt.gapMs);
    }
    while (!opt.isDone(answers) && scheduler.now() < deadline) {
      await new Promise((r) => {
        const t = scheduler.setTimeout(r, Math.min(500, Math.max(1, deadline - scheduler.now())));
        wake = () => {
          scheduler.clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
    if (!opt.isDone(answers)) {
      throw new SessionError(`incomplete answer (${answers.length} frames)`, false);
    }
    return answers;
  } finally {
    api.removeListener("message.BluetoothGATTNotifyDataResponse", listener);
    try {
      await withTimeout(api.disconnectBluetoothDeviceService(opt.address), 5e3, "disconnect");
    } catch {
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SessionError,
  findUart,
  runSession,
  uuidString
});
//# sourceMappingURL=gatt.js.map
