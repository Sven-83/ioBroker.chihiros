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
var states_exports = {};
__export(states_exports, {
  COMMON_READ_STATES: () => COMMON_READ_STATES,
  PUMPS: () => PUMPS,
  readChannels: () => readChannels,
  readStates: () => readStates,
  resultToStates: () => resultToStates
});
module.exports = __toCommonJS(states_exports);
var import_protocol = require("./protocol");
var import_reader = require("./reader");
const num = (name, role, unit) => ({
  name,
  type: "number",
  role,
  read: true,
  write: false,
  ...unit ? { unit } : {}
});
const str = (name, role) => ({
  name,
  type: "string",
  role,
  read: true,
  write: false,
  def: ""
});
const PUMPS = 4;
const COMMON_READ_STATES = [
  { id: "lastRead", common: { ...num("Last successful read", "date"), def: 0 } },
  { id: "readError", common: str("Error of the last read (empty = ok)", "text") }
];
function readStates(type) {
  switch (type) {
    case "doser": {
      const out = [];
      for (let p = 1; p <= PUMPS; p++) {
        out.push({ id: `pump${p}.total`, common: num(`Pump ${p}: dosed in total`, "value", "ml") });
        out.push({ id: `pump${p}.today`, common: num(`Pump ${p}: dosed today (scheduled)`, "value", "ml") });
        out.push({
          id: `pump${p}.planOn`,
          common: {
            name: `Pump ${p}: daily dose programmed (read from the pump)`,
            type: "boolean",
            role: "indicator",
            read: true,
            write: false,
            def: false
          }
        });
        out.push({
          id: `pump${p}.planTime`,
          common: {
            name: `Pump ${p}: time of the daily dose (read from the pump)`,
            type: "string",
            role: "text",
            read: true,
            write: false,
            def: ""
          }
        });
      }
      return out;
    }
    case "light":
      return [
        { id: "clock", common: str("Device clock", "text") },
        { id: "clockDeviation", common: num("Device clock minus local time", "value", "min") },
        { id: "schedule", common: str("Scheduled on times incl. sunrise and sunset", "text") },
        { id: "sunrise", common: num("Sunrise duration (first window)", "value", "min") },
        { id: "sunset", common: num("Sunset duration (first window)", "value", "min") },
        { id: "schedulePoints", common: str("Schedule points (JSON)", "json") },
        {
          id: "scheduledLevel",
          common: num("Red by schedule now (0-255; green, blue, white are not reported)", "value")
        }
      ];
    case "doctor":
      return [{ id: "waterTemp", common: num("Water temperature", "value.temperature", "\xB0C") }];
    case "fan":
      return [
        { id: "waterTemp", common: num("Water temperature", "value.temperature", "\xB0C") },
        { id: "roomTemp", common: num("Room temperature", "value.temperature", "\xB0C") },
        { id: "humidity", common: num("Humidity (not confirmed by the app)", "value.humidity", "%") }
      ];
    default:
      return [];
  }
}
function readChannels(type) {
  if (type !== "doser") {
    return [];
  }
  return Array.from({ length: PUMPS }, (_, i) => ({ id: `pump${i + 1}`, name: `Pump ${i + 1}` }));
}
function resultToStates(result, now) {
  const out = {};
  if (result.doserTotal) {
    result.doserTotal.forEach((v, i) => out[`pump${i + 1}.total`] = v);
  }
  if (result.doserToday) {
    result.doserToday.forEach((v, i) => out[`pump${i + 1}.today`] = v);
  }
  if (result.doserPlan) {
    result.doserPlan.forEach((p, i) => {
      out[`pump${i + 1}.planOn`] = p.on;
      out[`pump${i + 1}.planTime`] = p.on ? (0, import_protocol.formatMinute)(p.minute) : "";
    });
  }
  if (result.live) {
    for (const k of ["waterTemp", "roomTemp", "humidity"]) {
      const v = result.live[k];
      if (v !== void 0) {
        out[k] = v;
      }
    }
  }
  if (result.light) {
    const { clockMinute, points } = result.light;
    out.clock = (0, import_protocol.formatMinute)(clockMinute);
    out.clockDeviation = (0, import_reader.clockDeviation)(clockMinute, now);
    out.schedule = (0, import_protocol.scheduleWindows)(points);
    const first = (0, import_protocol.scheduleWindowList)(points)[0];
    if (first) {
      out.sunrise = first.sunrise;
      out.sunset = first.sunset;
    }
    out.schedulePoints = JSON.stringify(points.map((p) => ({ time: (0, import_protocol.formatMinute)(p.minute), level: p.level })));
    out.scheduledLevel = (0, import_protocol.scheduleLevel)(points, now.getHours() * 60 + now.getMinutes());
  }
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMON_READ_STATES,
  PUMPS,
  readChannels,
  readStates,
  resultToStates
});
//# sourceMappingURL=states.js.map
