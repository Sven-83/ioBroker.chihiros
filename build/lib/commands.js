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
  MODE_CHANNEL: () => MODE_CHANNEL,
  MODE_CLOCK: () => MODE_CLOCK,
  RESULT_UNCONFIRMED: () => RESULT_UNCONFIRMED,
  clockFrame: () => clockFrame,
  clockParams: () => clockParams,
  lightCommand: () => lightCommand,
  writeStates: () => writeStates
});
module.exports = __toCommonJS(commands_exports);
var import_protocol = require("./protocol");
const MODE_CLOCK = 9;
const MODE_CHANNEL = 7;
const LIGHT_CHANNELS = ["red", "green", "blue", "white"];
const RESULT_UNCONFIRMED = "sent, not confirmed (the device does not report this value)";
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMON_COMMAND_STATES,
  CommandError,
  LIGHT_CHANNELS,
  MODE_CHANNEL,
  MODE_CLOCK,
  RESULT_UNCONFIRMED,
  clockFrame,
  clockParams,
  lightCommand,
  writeStates
});
//# sourceMappingURL=commands.js.map
