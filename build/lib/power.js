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
var power_exports = {};
__export(power_exports, {
  FAN_KICK_LEVELS: () => FAN_KICK_LEVELS,
  POWER_MAX_AGE_MS: () => POWER_MAX_AGE_MS,
  POWER_OFF_W: () => POWER_OFF_W,
  POWER_ON_W: () => POWER_ON_W,
  isOn: () => isOn,
  parsePowerState: () => parsePowerState,
  powerIndicator: () => powerIndicator
});
module.exports = __toCommonJS(power_exports);
const POWER_ON_W = { fan: 0.5, co2: 1 };
const POWER_OFF_W = 0.2;
const POWER_MAX_AGE_MS = 6e4;
const FAN_KICK_LEVELS = [11, 4];
function powerIndicator(type) {
  switch (type) {
    case "fan":
      return {
        id: "running",
        common: {
          name: "Running (from the power measurement)",
          type: "boolean",
          role: "indicator.working",
          read: true,
          write: false
        }
      };
    case "co2":
      return {
        id: "valveOpen",
        common: {
          name: "Valve open (from the power measurement)",
          type: "boolean",
          role: "indicator.working",
          read: true,
          write: false
        }
      };
    default:
      return null;
  }
}
function isOn(type, watts) {
  const limit = POWER_ON_W[type];
  if (limit === void 0 || typeof watts !== "number" || !Number.isFinite(watts)) {
    return null;
  }
  return watts >= limit;
}
function parsePowerState(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const id = raw.trim();
  return /^[A-Za-z0-9_\-#]+(\.[A-Za-z0-9_\-#]+)+$/.test(id) ? id : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FAN_KICK_LEVELS,
  POWER_MAX_AGE_MS,
  POWER_OFF_W,
  POWER_ON_W,
  isOn,
  parsePowerState,
  powerIndicator
});
//# sourceMappingURL=power.js.map
