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
var reader_exports = {};
__export(reader_exports, {
  clockDeviation: () => clockDeviation,
  interpret: () => interpret,
  readPlan: () => readPlan
});
module.exports = __toCommonJS(reader_exports);
var import_protocol = require("./protocol");
const has = (answers, type) => answers.some((a) => a.type === type);
function readPlan(type, ids) {
  const frame = (q) => (0, import_protocol.encodeFrame)(q[0], q[1], q[2], ids.next());
  switch (type) {
    case "doser":
      return {
        frames: [frame(import_protocol.QUERY.status), frame(import_protocol.QUERY.doserTotal), frame(import_protocol.QUERY.doserToday)],
        isDone: (a) => has(a, import_protocol.MSG.doserTotal) && has(a, import_protocol.MSG.doserToday) && has(a, import_protocol.MSG.image)
      };
    case "light":
      return { frames: [frame(import_protocol.QUERY.status)], isDone: (a) => has(a, import_protocol.MSG.image) };
    case "doctor":
    case "fan":
      return { frames: [frame(import_protocol.QUERY.status)], isDone: (a) => has(a, import_protocol.MSG.live) };
    case "co2":
    default:
      return { frames: [frame(import_protocol.QUERY.status)], isDone: (a) => has(a, import_protocol.MSG.info) };
  }
}
function interpret(type, answers) {
  var _a, _b, _c, _d, _e;
  const last = (t) => [...answers].reverse().find((a) => a.type === t);
  const out = {};
  switch (type) {
    case "doser": {
      const total = last(import_protocol.MSG.doserTotal);
      const today = last(import_protocol.MSG.doserToday);
      out.doserTotal = (_a = total && (0, import_protocol.decodeDoserMl)(total)) != null ? _a : void 0;
      out.doserToday = (_b = today && (0, import_protocol.decodeDoserMl)(today)) != null ? _b : void 0;
      const img = last(import_protocol.MSG.image);
      const plan = img && (0, import_protocol.decodeDoserPlan)(img);
      if (plan) {
        out.doserPlan = plan;
      }
      break;
    }
    case "light": {
      const img = last(import_protocol.MSG.image);
      out.light = (_c = img && (0, import_protocol.decodeLightImage)(img)) != null ? _c : void 0;
      break;
    }
    case "doctor": {
      const live = last(import_protocol.MSG.live);
      out.live = (_d = live && (0, import_protocol.decodeDoctorLive)(live)) != null ? _d : void 0;
      break;
    }
    case "fan": {
      const live = last(import_protocol.MSG.live);
      out.live = (_e = live && (0, import_protocol.decodeFanLive)(live)) != null ? _e : void 0;
      break;
    }
    default:
      break;
  }
  return out;
}
function clockDeviation(clockMinute, now) {
  let d = clockMinute - (now.getHours() * 60 + now.getMinutes());
  if (d > 720) {
    d -= 1440;
  } else if (d < -720) {
    d += 1440;
  }
  return d;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clockDeviation,
  interpret,
  readPlan
});
//# sourceMappingURL=reader.js.map
