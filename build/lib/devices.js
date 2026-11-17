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
var devices_exports = {};
__export(devices_exports, {
  DEVICE_TYPES: () => DEVICE_TYPES,
  decideReachable: () => decideReachable,
  isReachable: () => isReachable,
  macToNumber: () => macToNumber,
  normalizeMac: () => normalizeMac,
  numberToMac: () => numberToMac,
  parseDevices: () => parseDevices,
  presenceLogLevel: () => presenceLogLevel,
  toObjectId: () => toObjectId
});
module.exports = __toCommonJS(devices_exports);
var import_power = require("./power");
const DEVICE_TYPES = ["light", "doser", "co2", "doctor", "fan"];
function normalizeMac(input) {
  if (typeof input !== "string") {
    return null;
  }
  const hex = input.trim().replace(/[:-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) {
    return null;
  }
  return hex.match(/../g).join(":");
}
function macToNumber(mac) {
  return parseInt(mac.replace(/:/g, ""), 16);
}
function numberToMac(n) {
  return n.toString(16).toUpperCase().padStart(12, "0").match(/../g).join(":");
}
function toObjectId(name, fallback) {
  const id = name.trim().toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return id || fallback;
}
function parseDevices(raw) {
  const devices = [];
  const errors = [];
  if (!Array.isArray(raw)) {
    return { devices, errors };
  }
  const macs = /* @__PURE__ */ new Set();
  const ids = /* @__PURE__ */ new Set();
  raw.forEach((row, index) => {
    const r = row && typeof row === "object" ? row : {};
    const line = `device row ${index + 1}`;
    const mac = normalizeMac(r.mac);
    if (!mac) {
      errors.push(`${line}: invalid MAC address "${typeof r.mac === "string" ? r.mac : ""}"`);
      return;
    }
    const type = typeof r.type === "string" ? r.type : void 0;
    if (!type || !DEVICE_TYPES.includes(type)) {
      errors.push(`${line}: unknown device type "${typeof r.type === "string" ? r.type : ""}"`);
      return;
    }
    if (macs.has(mac)) {
      errors.push(`${line}: MAC ${mac} is configured twice`);
      return;
    }
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : type;
    let id = toObjectId(name, type);
    for (let n = 2; ids.has(id); n++) {
      id = `${toObjectId(name, type)}_${n}`;
    }
    macs.add(mac);
    ids.add(id);
    const device = { id, name, type, mac, macNum: macToNumber(mac), seasonal: r.seasonal === true };
    const rawPower = typeof r.powerState === "string" ? r.powerState.trim() : "";
    if (rawPower) {
      const power = (0, import_power.parsePowerState)(rawPower);
      if (power) {
        device.powerState = power;
      } else {
        errors.push(`${line}: invalid power state ID "${rawPower}" - ignored`);
      }
    }
    devices.push(device);
  });
  return { devices, errors };
}
function isReachable(lastSeen, now, timeoutMs) {
  return lastSeen !== void 0 && now - lastSeen <= timeoutMs;
}
function decideReachable(lastSeen, now, timeoutMs, listeningSince, previous) {
  if (listeningSince === void 0) {
    return previous;
  }
  const reachable = isReachable(lastSeen, now, timeoutMs);
  if (!reachable && now - listeningSince < timeoutMs) {
    return previous;
  }
  return reachable;
}
function presenceLogLevel(device, reachable) {
  return reachable || device.seasonal ? "info" : "warn";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEVICE_TYPES,
  decideReachable,
  isReachable,
  macToNumber,
  normalizeMac,
  numberToMac,
  parseDevices,
  presenceLogLevel,
  toObjectId
});
//# sourceMappingURL=devices.js.map
