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
var protocol_exports = {};
__export(protocol_exports, {
  CMD_5A: () => CMD_5A,
  CMD_A5: () => CMD_A5,
  MSG: () => MSG,
  MessageIds: () => MessageIds,
  QUERY: () => QUERY,
  decodeAnswer: () => decodeAnswer,
  decodeDoctorLive: () => decodeDoctorLive,
  decodeDoserMl: () => decodeDoserMl,
  decodeFanLive: () => decodeFanLive,
  decodeLightImage: () => decodeLightImage,
  encodeFrame: () => encodeFrame,
  formatMinute: () => formatMinute,
  scheduleLevel: () => scheduleLevel,
  scheduleWindows: () => scheduleWindows
});
module.exports = __toCommonJS(protocol_exports);
const CMD_5A = 90;
const CMD_A5 = 165;
const QUERY = {
  /** Status / login, every device answers with a 0x0a frame */
  status: [CMD_5A, 4, [1]],
  /** Dosing pump: total dosed ml per pump (answer 0x1e) */
  doserTotal: [CMD_A5, 4, [4]],
  /** Dosing pump: dosed ml today per pump (answer 0x22) */
  doserToday: [CMD_A5, 4, [5]]
};
const MSG = {
  info: 10,
  image: 254,
  doserTotal: 30,
  doserToday: 34,
  live: 37
};
class MessageIds {
  hi = 0;
  lo = 0;
  /** Next ID as [hi, lo] */
  next() {
    if (this.lo === 255) {
      this.hi = this.hi + 1 & 255;
      this.lo = 0;
    } else {
      this.lo++;
    }
    if (this.lo === 90) {
      this.lo++;
    }
    return [this.hi, this.lo];
  }
}
function encodeFrame(cmd, mode, params, id) {
  const f = [cmd, 1, params.length + 5, id[0], id[1], mode, ...params];
  let cs = f[1];
  for (let i = 2; i < f.length; i++) {
    cs ^= f[i];
  }
  return Uint8Array.from([...f, cs & 255]);
}
function decodeAnswer(data) {
  const b = Array.from(data);
  if (b.length < 7 || b[0] !== 91) {
    return null;
  }
  return { type: b[5], payload: b.slice(6) };
}
const u16 = (p, i) => (p[i] << 8 | p[i + 1]) >>> 0;
function decodeFanLive(a) {
  if (a.type !== MSG.live || a.payload.length < 6) {
    return null;
  }
  const humidity = u16(a.payload, 0) / 100;
  const roomTemp = u16(a.payload, 2) / 100;
  const waterTemp = u16(a.payload, 4) / 10;
  const out = { waterTemp };
  if (humidity > 0 || roomTemp > 0) {
    out.humidity = humidity;
    out.roomTemp = roomTemp;
  }
  return out;
}
function decodeDoctorLive(a) {
  if (a.type !== MSG.live || a.payload.length < 6) {
    return null;
  }
  return { waterTemp: u16(a.payload, 4) / 10 };
}
function decodeDoserMl(a) {
  if (a.type !== MSG.doserTotal && a.type !== MSG.doserToday || a.payload.length < 8) {
    return null;
  }
  return [0, 2, 4, 6].map((i) => u16(a.payload, i) / 10);
}
function decodeLightImage(a) {
  const p = a.payload;
  if (a.type !== MSG.image || p.length < 20 || p[1] > 23 || p[2] > 59) {
    return null;
  }
  const points = [];
  for (let i = 19; i + 2 < p.length; i += 3) {
    const h = p[i];
    const m = p[i + 1];
    if (h > 23 || m > 59) {
      break;
    }
    if (h === 0 && m === 0 && p[i + 2] === 0 && points.length > 0) {
      break;
    }
    points.push({ minute: h * 60 + m, level: p[i + 2] });
  }
  return { clockMinute: p[1] * 60 + p[2], points };
}
function formatMinute(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function scheduleLevel(points, minute) {
  if (points.length === 0 || minute < points[0].minute) {
    return 0;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (minute >= a.minute && minute < b.minute) {
      return Math.round(a.level + (b.level - a.level) * (minute - a.minute) / (b.minute - a.minute));
    }
  }
  return points[points.length - 1].level;
}
function scheduleWindows(points) {
  const out = [];
  let start = null;
  let last = 0;
  for (const pt of points) {
    if (pt.level > 0 && start === null) {
      start = pt.minute;
    }
    if (pt.level > 0) {
      last = pt.minute;
    }
    if (pt.level === 0 && start !== null) {
      out.push(`${formatMinute(start)}-${formatMinute(last)}`);
      start = null;
    }
  }
  if (start !== null) {
    out.push(`${formatMinute(start)}-${formatMinute(last)}`);
  }
  return out.join(", ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CMD_5A,
  CMD_A5,
  MSG,
  MessageIds,
  QUERY,
  decodeAnswer,
  decodeDoctorLive,
  decodeDoserMl,
  decodeFanLive,
  decodeLightImage,
  encodeFrame,
  formatMinute,
  scheduleLevel,
  scheduleWindows
});
//# sourceMappingURL=protocol.js.map
