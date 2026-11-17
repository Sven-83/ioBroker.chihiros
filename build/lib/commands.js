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
  COMMON_COMMAND_STATES: () => COMMON_COMMAND_STATES,
  CommandError: () => CommandError,
  LIGHT_CHANNELS: () => LIGHT_CHANNELS,
  MAX_DOSE_ML: () => MAX_DOSE_ML,
  MAX_FAN_LEVEL: () => MAX_FAN_LEVEL,
  MODE_CHANNEL: () => MODE_CHANNEL,
  MODE_CLOCK: () => MODE_CLOCK,
  MODE_DOSE: () => MODE_DOSE,
  RESULT_UNACKED: () => RESULT_UNACKED,
  RESULT_UNCONFIRMED: () => RESULT_UNCONFIRMED,
  clockFrame: () => clockFrame,
  clockParams: () => clockParams,
  doserCommand: () => doserCommand,
  fanCommand: () => fanCommand,
  lightCommand: () => lightCommand,
  writeStates: () => writeStates
});
module.exports = __toCommonJS(commands_exports);
var import_protocol = require("./protocol");
var import_states = require("./states");
const MODE_CLOCK = 9;
const MODE_CHANNEL = 7;
const MODE_DOSE = 27;
const MAX_DOSE_ML = 5;
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
      return Array.from({ length: import_states.PUMPS }, (_, i) => ({
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
      }));
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
    frames: [[import_protocol.CMD_5A, MODE_CHANNEL, [255, v]]],
    states: { level: v }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMON_COMMAND_STATES,
  CommandError,
  LIGHT_CHANNELS,
  MAX_DOSE_ML,
  MAX_FAN_LEVEL,
  MODE_CHANNEL,
  MODE_CLOCK,
  MODE_DOSE,
  RESULT_UNACKED,
  RESULT_UNCONFIRMED,
  clockFrame,
  clockParams,
  doserCommand,
  fanCommand,
  lightCommand,
  writeStates
});
//# sourceMappingURL=commands.js.map
