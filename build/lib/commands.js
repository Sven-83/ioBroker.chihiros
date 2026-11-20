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
var commands_exports = {};
__export(commands_exports, {
  ALL_DAYS: () => ALL_DAYS,
  COMMON_COMMAND_STATES: () => COMMON_COMMAND_STATES,
  CommandError: () => CommandError,
  DOCTOR_MODES: () => DOCTOR_MODES,
  DOSE_GAP_MIN: () => DOSE_GAP_MIN,
  DOSE_SECONDS_PER_ML: () => DOSE_SECONDS_PER_ML,
  LIGHT_CHANNELS: () => LIGHT_CHANNELS,
  MAX_CO2_WINDOWS: () => MAX_CO2_WINDOWS,
  MAX_DOSE_ML: () => MAX_DOSE_ML,
  MAX_FAN_LEVEL: () => MAX_FAN_LEVEL,
  MAX_PLAN_ML: () => MAX_PLAN_ML,
  MODE_CHANNEL: () => MODE_CHANNEL,
  MODE_CLOCK: () => MODE_CLOCK,
  MODE_CO2_SCHEDULE: () => MODE_CO2_SCHEDULE,
  MODE_DOCTOR_RUN: () => MODE_DOCTOR_RUN,
  MODE_DOSE: () => MODE_DOSE,
  MODE_PLAN_ACTIVE: () => MODE_PLAN_ACTIVE,
  MODE_PLAN_DOSE: () => MODE_PLAN_DOSE,
  MODE_PLAN_TIME: () => MODE_PLAN_TIME,
  MODE_QUERY: () => MODE_QUERY,
  MODE_SETTING: () => MODE_SETTING,
  RESULT_UNACKED: () => RESULT_UNACKED,
  RESULT_UNCONFIRMED: () => RESULT_UNCONFIRMED,
  clockFrame: () => clockFrame,
  clockParams: () => clockParams,
  co2Command: () => co2Command,
  co2ScheduleCommand: () => co2ScheduleCommand,
  co2ShouldBeOpen: () => co2ShouldBeOpen,
  doctorCommand: () => doctorCommand,
  doseMinutes: () => doseMinutes,
  doserCommand: () => doserCommand,
  fanCommand: () => fanCommand,
  lightCommand: () => lightCommand,
  parseCo2Windows: () => parseCo2Windows,
  planCommand: () => planCommand,
  planConflict: () => planConflict,
  writeStates: () => writeStates
});
module.exports = __toCommonJS(commands_exports);
var import_protocol = require("./protocol");
var import_states = require("./states");
const MODE_CLOCK = 9;
const MODE_QUERY = 4;
const MODE_CHANNEL = 7;
const MODE_DOSE = 27;
const MAX_DOSE_ML = 5;
const MODE_PLAN_ACTIVE = 32;
const MODE_PLAN_DOSE = 27;
const MODE_PLAN_TIME = 21;
const ALL_DAYS = 127;
const MAX_PLAN_ML = 30;
const MODE_SETTING = 5;
const MODE_CO2_SCHEDULE = 22;
const MODE_DOCTOR_RUN = 1;
const DOCTOR_MODES = {
  fish: { setting: 53, run: [1, 114] },
  shrimp: { setting: 54, run: [1, 8] }
};
const MAX_FAN_LEVEL = 20;
const LIGHT_CHANNELS = ["red", "green", "blue", "white"];
const RESULT_UNCONFIRMED = "sent, not confirmed (the device does not report this value)";
const RESULT_UNACKED = "sent, but the device did not acknowledge it - not confirmed";
class CommandError extends Error {
}
const COMMON_COMMAND_STATES = [
  {
    id: "lastCommand",
    common: { name: "Last command", type: "string", role: "text", read: true, write: false, def: "" }
  },
  {
    id: "commandResult",
    common: {
      name: "Result of the last command",
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: ""
    }
  }
];
const COLOR_ROLE = {
  red: "level.color.red",
  green: "level.color.green",
  blue: "level.color.blue",
  white: "level.color.white"
};
function writeStates(type) {
  switch (type) {
    case "light":
      return [
        ...LIGHT_CHANNELS.map((ch) => ({
          id: ch,
          common: {
            name: `${ch[0].toUpperCase()}${ch.slice(1)} (0-255, set by this adapter, not reported by the light)`,
            type: "number",
            role: COLOR_ROLE[ch],
            min: 0,
            max: 255,
            read: true,
            write: true,
            def: 0
          }
        })),
        {
          id: "on",
          common: {
            name: "On (all channels to the set values) / off (all channels 0)",
            type: "boolean",
            role: "switch.light",
            read: true,
            write: true,
            def: false
          }
        }
      ];
    case "doser":
      return Array.from({ length: import_states.PUMPS }, (_, i) => [
        {
          id: `pump${i + 1}.plan`,
          common: {
            name: `Pump ${i + 1}: daily dose plan as JSON {"on":true,"time":"14:00","ml":5,"days":127} (days: Mon 64 ... Sun 1; amount and days are not reported by the pump)`,
            type: "string",
            role: "json",
            read: true,
            write: true,
            def: ""
          }
        }
      ]).flat().concat(
        Array.from({ length: import_states.PUMPS }, (_, i) => ({
          id: `pump${i + 1}.doseNow`,
          common: {
            name: `Pump ${i + 1}: dose now (ml, 0.1-${MAX_DOSE_ML})`,
            type: "number",
            role: "level",
            unit: "ml",
            min: 0,
            max: MAX_DOSE_ML,
            step: 0.1,
            read: true,
            write: true,
            def: 0
          }
        }))
      );
    case "co2":
      return [
        {
          id: "schedule",
          common: {
            name: 'CO2 time windows "HH:MM-HH:MM, ..." (empty or 00:00-23:59 = always); overwrites the schedule of the app',
            type: "string",
            role: "text",
            read: true,
            write: true,
            def: ""
          }
        },
        {
          id: "on",
          common: {
            name: "CO2 on (schedule 00:00-23:59) / off (schedule empty); overwrites the schedule of the app",
            type: "boolean",
            role: "switch",
            read: true,
            write: true,
            def: false
          }
        }
      ];
    case "doctor":
      return [
        {
          id: "mode",
          common: {
            name: "Mode (set by this adapter, not reported by the Doctor)",
            type: "string",
            role: "level.mode",
            states: { fish: "Fish", shrimp: "Shrimp" },
            read: true,
            write: true,
            def: ""
          }
        }
      ];
    case "fan":
      return [
        {
          id: "level",
          common: {
            name: `Level (0 = off, 1-${MAX_FAN_LEVEL}; set by this adapter, not reported by the fan)`,
            type: "number",
            role: "level",
            min: 0,
            max: MAX_FAN_LEVEL,
            step: 1,
            read: true,
            write: true,
            def: 0
          }
        }
      ];
    default:
      return [];
  }
}
function clockParams(now) {
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  return [now.getFullYear() - 2e3, now.getMonth() + 1, weekday, now.getHours(), now.getMinutes(), now.getSeconds()];
}
function clockFrame(now) {
  return [import_protocol.CMD_5A, MODE_CLOCK, clockParams(now)];
}
function channelValue(value) {
  const v = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 255) {
    throw new CommandError(`invalid value ${JSON.stringify(value)} (0-255)`);
  }
  return Math.round(v);
}
function lightCommand(id, value, current) {
  const frame = (ch, v) => [import_protocol.CMD_5A, MODE_CHANNEL, [ch, v]];
  const idx = LIGHT_CHANNELS.indexOf(id);
  if (idx >= 0) {
    const v = channelValue(value);
    const next = { ...current, [id]: v };
    const anyOn = LIGHT_CHANNELS.some((ch) => next[ch] > 0);
    const frames = current.on ? [frame(idx, v)] : LIGHT_CHANNELS.map((ch, i) => frame(i, next[ch]));
    return { label: `${id} ${v}`, frames, states: { [id]: v, on: anyOn } };
  }
  if (id === "on") {
    const on = value === true || value === 1 || value === "true";
    if (!on) {
      return { label: "off", frames: LIGHT_CHANNELS.map((_, i) => frame(i, 0)), states: { on: false } };
    }
    if (!LIGHT_CHANNELS.some((ch) => current[ch] > 0)) {
      throw new CommandError("all channels are 0 - set a colour first");
    }
    return {
      label: `on (${LIGHT_CHANNELS.map((ch) => current[ch]).join("/")})`,
      frames: LIGHT_CHANNELS.map((ch, i) => frame(i, current[ch])),
      states: { on: true }
    };
  }
  throw new CommandError(`${id} is not writable`);
}
function doserCommand(id, value) {
  const plan = /^pump([1-4])\.plan$/.exec(id);
  if (plan) {
    return planCommand(Number(plan[1]), id, value);
  }
  const m = /^pump([1-4])\.doseNow$/.exec(id);
  if (!m) {
    throw new CommandError(`${id} is not writable`);
  }
  const pump = Number(m[1]);
  const v = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CommandError(`invalid value ${JSON.stringify(value)} (0.1-${MAX_DOSE_ML} ml)`);
  }
  const tenths = Math.round(v * 10);
  if (tenths < 1 || tenths > MAX_DOSE_ML * 10) {
    throw new CommandError(`invalid amount ${v} ml (0.1-${MAX_DOSE_ML} ml)`);
  }
  const ml = tenths / 10;
  return {
    label: `pump ${pump}: dose ${ml} ml`,
    frames: [[import_protocol.CMD_A5, MODE_DOSE, [pump - 1, 0, 0, 0, tenths]]],
    states: { [id]: ml },
    confirm: { pump, ml }
  };
}
const DOSE_SECONDS_PER_ML = 6;
const DOSE_GAP_MIN = 1;
function doseMinutes(ml) {
  return Math.max(1, Math.ceil(ml * DOSE_SECONDS_PER_ML / 60)) + DOSE_GAP_MIN;
}
function planConflict(slot, others) {
  const day = 1440;
  for (const o of others) {
    if (o.pump === slot.pump) {
      continue;
    }
    const a0 = slot.minute;
    const a1 = a0 + doseMinutes(slot.ml);
    for (const shift of [-day, 0, day]) {
      const b0 = o.minute + shift;
      const b1 = b0 + doseMinutes(o.ml);
      if (a0 < b1 && b0 < a1) {
        return o;
      }
    }
  }
  return null;
}
function planCommand(pump, id, value) {
  let p;
  try {
    p = typeof value === "string" ? JSON.parse(value) : {};
  } catch {
    throw new CommandError(`invalid plan ${JSON.stringify(value)} (JSON expected)`);
  }
  if (!p || typeof p !== "object" || typeof p.on !== "boolean") {
    throw new CommandError(`invalid plan ${JSON.stringify(value)} ("on" missing)`);
  }
  const ch = pump - 1;
  if (!p.on) {
    return {
      label: `pump ${pump}: daily dose off`,
      frames: [[import_protocol.CMD_A5, MODE_PLAN_ACTIVE, [ch, 0, 0]]],
      states: { [id]: JSON.stringify({ on: false }) },
      confirmPlan: { pump, on: false, time: "" }
    };
  }
  const t = typeof p.time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(p.time) : null;
  const hour = t ? Number(t[1]) : NaN;
  const minute = t ? Number(t[2]) : NaN;
  if (!t || hour > 23 || minute > 59) {
    throw new CommandError(`invalid time ${JSON.stringify(p.time)} (HH:MM)`);
  }
  const ml = typeof p.ml === "number" ? p.ml : NaN;
  const tenths = Math.round(ml * 10);
  if (!Number.isFinite(ml) || tenths < 1 || tenths > MAX_PLAN_ML * 10) {
    throw new CommandError(`invalid amount ${JSON.stringify(p.ml)} (0.1-${MAX_PLAN_ML} ml)`);
  }
  const days = p.days === void 0 ? ALL_DAYS : Number(p.days);
  if (!Number.isInteger(days) || days < 1 || days > ALL_DAYS) {
    throw new CommandError(`invalid days ${JSON.stringify(p.days)} (1-127)`);
  }
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    label: `pump ${pump}: daily ${tenths / 10} ml at ${time} (days ${days})`,
    frames: [
      [import_protocol.CMD_A5, MODE_PLAN_ACTIVE, [ch, 0, 1]],
      [import_protocol.CMD_A5, MODE_PLAN_DOSE, [ch, days, 1, 1, tenths >> 8, tenths & 255]],
      [import_protocol.CMD_A5, MODE_PLAN_TIME, [ch, 0, hour, minute, 0, 0]]
    ],
    states: { [id]: JSON.stringify({ on: true, time, ml: tenths / 10, days }) },
    confirmPlan: { pump, on: true, time }
  };
}
function fanCommand(id, value) {
  if (id !== "level") {
    throw new CommandError(`${id} is not writable`);
  }
  const v = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_FAN_LEVEL) {
    throw new CommandError(`invalid level ${JSON.stringify(value)} (0-${MAX_FAN_LEVEL})`);
  }
  return {
    label: v === 0 ? "off" : `level ${v}`,
    // like the app: the two queries (settings, temperature history) before the level
    frames: [
      [import_protocol.CMD_A5, MODE_QUERY, [6]],
      [import_protocol.CMD_A5, MODE_QUERY, [8]],
      [import_protocol.CMD_5A, MODE_CHANNEL, [255, v]]
    ],
    states: { level: v }
  };
}
function co2Command(id, value) {
  if (id === "schedule") {
    return co2ScheduleCommand(value);
  }
  if (id !== "on") {
    throw new CommandError(`${id} is not writable`);
  }
  let on;
  if (value === true || value === 1 || value === "true") {
    on = true;
  } else if (value === false || value === 0 || value === "false") {
    on = false;
  } else {
    throw new CommandError(`invalid value ${JSON.stringify(value)} (true/false)`);
  }
  return {
    label: on ? "CO2 on (schedule 00:00-23:59)" : "CO2 off (schedule empty)",
    frames: [
      [import_protocol.CMD_5A, MODE_SETTING, [7, 255, 255]],
      [import_protocol.CMD_5A, MODE_CO2_SCHEDULE, on ? [0, 0, 100] : [0, 0, 111]],
      [import_protocol.CMD_5A, MODE_CO2_SCHEDULE, on ? [23, 59, 0] : [23, 59, 111]]
    ],
    states: on ? { on, schedule: "" } : { on }
  };
}
const MAX_CO2_WINDOWS = 4;
function parseCo2Windows(text) {
  const out = [];
  for (const part of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part);
    const a = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    const e = m ? Number(m[3]) * 60 + Number(m[4]) : NaN;
    if (!m || Number(m[2]) > 59 || Number(m[4]) > 59 || !(a >= 0 && a < e && e <= 1439)) {
      throw new CommandError(
        `invalid window ${JSON.stringify(part)} (HH:MM-HH:MM, end after start, at most 23:59)`
      );
    }
    out.push([a, e]);
  }
  out.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < out.length; i++) {
    if (out[i][0] <= out[i - 1][1]) {
      throw new CommandError("windows overlap");
    }
  }
  if (out.length > MAX_CO2_WINDOWS) {
    throw new CommandError(`at most ${MAX_CO2_WINDOWS} windows`);
  }
  return out;
}
function co2ScheduleCommand(value) {
  const text = typeof value === "string" ? value : "";
  const win = parseCo2Windows(text);
  const all = !win.length || win.length === 1 && win[0][0] === 0 && win[0][1] === 1439;
  const list = all ? [[0, 1439]] : win;
  const hm = (m) => [Math.floor(m / 60), m % 60];
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const norm = all ? "" : list.map(([a, e]) => `${fmt(a)}-${fmt(e)}`).join(", ");
  return {
    label: `CO2 schedule ${all ? "00:00-23:59 (always)" : norm}`,
    frames: [
      [import_protocol.CMD_5A, MODE_SETTING, [7, 255, 255]],
      ...list.flatMap(([a, e]) => [
        [import_protocol.CMD_5A, MODE_CO2_SCHEDULE, [...hm(a), 100]],
        [import_protocol.CMD_5A, MODE_CO2_SCHEDULE, [...hm(e), 0]]
      ])
    ],
    states: { schedule: norm, on: true }
  };
}
function co2ShouldBeOpen(schedule, now) {
  const win = schedule ? parseCo2Windows(schedule) : [];
  const m = now.getHours() * 60 + now.getMinutes();
  return !win.length || win.some(([a, e]) => m >= a && m < e);
}
function doctorCommand(id, value) {
  if (id !== "mode") {
    throw new CommandError(`${id} is not writable`);
  }
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mode !== "fish" && mode !== "shrimp") {
    throw new CommandError(`invalid mode ${JSON.stringify(value)} (fish/shrimp)`);
  }
  const m = DOCTOR_MODES[mode];
  return {
    label: `mode ${mode}`,
    frames: [
      [import_protocol.CMD_5A, MODE_SETTING, [m.setting, 255, 255]],
      [import_protocol.CMD_A5, MODE_DOCTOR_RUN, [...m.run]]
    ],
    states: { mode }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ALL_DAYS,
  COMMON_COMMAND_STATES,
  CommandError,
  DOCTOR_MODES,
  DOSE_GAP_MIN,
  DOSE_SECONDS_PER_ML,
  LIGHT_CHANNELS,
  MAX_CO2_WINDOWS,
  MAX_DOSE_ML,
  MAX_FAN_LEVEL,
  MAX_PLAN_ML,
  MODE_CHANNEL,
  MODE_CLOCK,
  MODE_CO2_SCHEDULE,
  MODE_DOCTOR_RUN,
  MODE_DOSE,
  MODE_PLAN_ACTIVE,
  MODE_PLAN_DOSE,
  MODE_PLAN_TIME,
  MODE_QUERY,
  MODE_SETTING,
  RESULT_UNACKED,
  RESULT_UNCONFIRMED,
  clockFrame,
  clockParams,
  co2Command,
  co2ScheduleCommand,
  co2ShouldBeOpen,
  doctorCommand,
  doseMinutes,
  doserCommand,
  fanCommand,
  lightCommand,
  parseCo2Windows,
  planCommand,
  planConflict,
  writeStates
});
//# sourceMappingURL=commands.js.map
