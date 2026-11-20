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
var care_exports = {};
__export(care_exports, {
  AQUARIUM_STATES: () => AQUARIUM_STATES,
  CURVE_DEFAULT: () => CURVE_DEFAULT,
  DEFAULT_REFILL_ML: () => DEFAULT_REFILL_ML,
  FAN_AUTO_STATES: () => FAN_AUTO_STATES,
  HAND_PAUSE_MS: () => HAND_PAUSE_MS,
  HISTORY_DAYS: () => HISTORY_DAYS,
  HISTORY_KEEP_MS: () => HISTORY_KEEP_MS,
  HISTORY_STEP_MS: () => HISTORY_STEP_MS,
  addHistory: () => addHistory,
  curveLevel: () => curveLevel,
  curveTarget: () => curveTarget,
  dailyDose: () => dailyDose,
  dayKey: () => dayKey,
  daysLeft: () => daysLeft,
  doserCareStates: () => doserCareStates,
  emptyStock: () => emptyStock,
  fanAutoAction: () => fanAutoAction,
  isLow: () => isLow,
  parseCurve: () => parseCurve,
  parseStock: () => parseStock,
  pumpCareStates: () => pumpCareStates,
  refill: () => refill,
  remaining: () => remaining,
  tempAlarm: () => tempAlarm,
  updateStock: () => updateStock,
  validateSetting: () => validateSetting
});
module.exports = __toCommonJS(care_exports);
var import_states = require("./states");
const HISTORY_DAYS = 7;
const RESET_TOLERANCE_ML = 0.05;
const round1 = (v) => Math.round(v * 10) / 10;
function emptyStock() {
  return { baseRemaining: null, baseTotal: 0, lastTotal: null, history: [], day: "", today: 0 };
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
function parseStock(raw) {
  if (typeof raw !== "string" || !raw) {
    return emptyStock();
  }
  try {
    const o = JSON.parse(raw);
    const history = Array.isArray(o.history) ? o.history.filter((h) => h && typeof h.day === "string" && isNum(h.ml)).slice(-HISTORY_DAYS) : [];
    return {
      baseRemaining: isNum(o.baseRemaining) ? o.baseRemaining : null,
      baseTotal: isNum(o.baseTotal) ? o.baseTotal : 0,
      lastTotal: isNum(o.lastTotal) ? o.lastTotal : null,
      history,
      day: typeof o.day === "string" ? o.day : "",
      today: isNum(o.today) ? o.today : 0
    };
  } catch {
    return emptyStock();
  }
}
function dayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function refill(s, total, amount) {
  var _a;
  const base = (_a = total != null ? total : s.lastTotal) != null ? _a : 0;
  return { ...s, baseRemaining: amount, baseTotal: base, lastTotal: total != null ? total : s.lastTotal };
}
function updateStock(s, total, today, day) {
  let next = { ...s, history: [...s.history] };
  let reset = false;
  if (s.lastTotal === null && s.baseRemaining !== null) {
    next.baseTotal = total;
  } else if (s.lastTotal !== null && total < s.lastTotal - RESET_TOLERANCE_ML) {
    reset = true;
    const before = remaining(s);
    next = { ...next, baseRemaining: before, baseTotal: 0 };
  }
  if (day !== s.day) {
    if (s.day) {
      next.history.push({ day: s.day, ml: s.today });
      next.history = next.history.slice(-HISTORY_DAYS);
    }
    next.day = day;
  }
  next.today = today;
  next.lastTotal = total;
  return { stock: next, reset };
}
function remaining(s) {
  var _a;
  if (s.baseRemaining === null) {
    return null;
  }
  const used = ((_a = s.lastTotal) != null ? _a : s.baseTotal) - s.baseTotal;
  return Math.max(0, round1(s.baseRemaining - used));
}
function dailyDose(s) {
  if (s.history.length === 0) {
    return round1(s.today);
  }
  return round1(s.history.reduce((a, h) => a + h.ml, 0) / s.history.length);
}
function daysLeft(rest, daily) {
  if (rest === null || daily <= 0) {
    return null;
  }
  return Math.floor(rest / daily);
}
function isLow(days, warnDays) {
  return days !== null && days <= warnDays;
}
function tempAlarm(temp, min, max) {
  if (!isNum(temp)) {
    return "";
  }
  if (temp < min) {
    return "low";
  }
  return temp > max ? "high" : "";
}
const HISTORY_STEP_MS = 5 * 6e4;
const HISTORY_KEEP_MS = 24 * 36e5;
function addHistory(raw, ts, temp) {
  let list = [];
  try {
    const v = typeof raw === "string" && raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) {
      list = v.filter(
        (p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number"
      );
    }
  } catch {
    list = [];
  }
  const last = list[list.length - 1];
  if (last && ts - last[0] < HISTORY_STEP_MS) {
    list[list.length - 1] = [last[0], temp];
  } else {
    list.push([ts, temp]);
  }
  return JSON.stringify(list.filter((p) => p[0] >= ts - HISTORY_KEEP_MS));
}
const CURVE_DEFAULT = [
  [26, 5],
  [27, 11],
  [28, 20]
];
function parseCurve(raw) {
  try {
    const v = typeof raw === "string" && raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v) || !v.length || v.length > 6) {
      return null;
    }
    const c = v.map(
      (p) => Array.isArray(p) ? [Number(p[0]), Math.round(Number(p[1]))] : [NaN, NaN]
    );
    if (c.some(([t, l]) => !Number.isFinite(t) || t < 15 || t > 35 || !(l >= 1 && l <= 20))) {
      return null;
    }
    return c.sort((a, b) => a[0] - b[0]);
  } catch {
    return null;
  }
}
function curveLevel(t, c) {
  if (t < c[0][0]) {
    return 0;
  }
  for (let i = 1; i < c.length; i++) {
    if (t < c[i][0]) {
      const [t0, l0] = c[i - 1];
      const [t1, l1] = c[i];
      return Math.round(l0 + (l1 - l0) * (t - t0) / (t1 - t0));
    }
  }
  return c[c.length - 1][1];
}
function curveTarget(temp, c, offTemp, running) {
  const off = Math.min(offTemp, c[0][0] - 0.1);
  if (!running) {
    return temp >= c[0][0] ? curveLevel(temp, c) : 0;
  }
  if (temp <= off) {
    return 0;
  }
  return Math.max(c[0][1], curveLevel(temp, c));
}
const HAND_PAUSE_MS = 3 * 36e5;
function fanAutoAction(temp, cfg, active, hold) {
  if (!cfg.enabled) {
    return active ? "off" : null;
  }
  if (!isNum(temp) || hold) {
    return null;
  }
  const off = Math.min(cfg.offTemp, cfg.onTemp - 0.1);
  if (!active && temp >= cfg.onTemp) {
    return "on";
  }
  if (active && temp <= off) {
    return "off";
  }
  return null;
}
const setting = (name, type, role, def, extra = {}) => ({ name, type, role, read: true, write: true, def, ...extra });
const value = (name, type, role, extra = {}) => ({ name, type, role, read: true, write: false, ...extra });
const DEFAULT_REFILL_ML = 450;
function pumpCareStates(p) {
  const id = (s) => `pump${p}.${s}`;
  return {
    settings: [
      { id: id("label"), common: setting(`Pump ${p}: content (free text)`, "string", "text", "") },
      {
        id: id("refillAmount"),
        common: setting(`Pump ${p}: ml in the bottle after refilling`, "number", "level", DEFAULT_REFILL_ML, {
          unit: "ml",
          min: 0,
          max: 5e3
        })
      },
      {
        id: id("refilled"),
        common: {
          name: `Pump ${p}: bottle refilled (press after refilling)`,
          type: "boolean",
          role: "button",
          read: false,
          write: true
        }
      }
    ],
    values: [
      { id: id("refilledAt"), common: value(`Pump ${p}: last refill`, "number", "date") },
      {
        id: id("remaining"),
        common: value(`Pump ${p}: remaining in the bottle (calculated)`, "number", "value", { unit: "ml" })
      },
      {
        id: id("dailyDose"),
        common: value(`Pump ${p}: daily dose (average of the last days)`, "number", "value", {
          unit: "ml"
        })
      },
      {
        id: id("daysLeft"),
        common: value(`Pump ${p}: bottle lasts for (days)`, "number", "value", { unit: "d" })
      },
      {
        id: id("low"),
        common: value(`Pump ${p}: bottle almost empty`, "boolean", "indicator.alarm", { def: false })
      },
      {
        id: id("stock"),
        common: value(`Pump ${p}: stock calculation (internal)`, "string", "json", { def: "" })
      }
    ]
  };
}
function doserCareStates() {
  const out = { settings: [], values: [] };
  for (let p = 1; p <= import_states.PUMPS; p++) {
    const s = pumpCareStates(p);
    out.settings.push(...s.settings);
    out.values.push(...s.values);
  }
  return out;
}
const AQUARIUM_STATES = {
  settings: [
    {
      id: "tempMin",
      common: setting("Water temperature: lower limit", "number", "level.temperature", 20, {
        unit: "\xB0C",
        min: 10,
        max: 35
      })
    },
    {
      id: "tempMax",
      common: setting("Water temperature: upper limit", "number", "level.temperature", 28, {
        unit: "\xB0C",
        min: 10,
        max: 35
      })
    },
    {
      id: "warnDays",
      common: setting("Fertiliser: warn when a bottle lasts at most (days)", "number", "level", 7, {
        unit: "d",
        min: 0,
        max: 60
      })
    }
  ],
  values: [
    {
      id: "waterTemp",
      common: value("Water temperature (Doctor)", "number", "value.temperature", { unit: "\xB0C" })
    },
    {
      id: "tempAlarm",
      common: value('Water temperature outside the limits: "low", "high" or empty', "string", "text", {
        def: ""
      })
    },
    {
      id: "fertiliserLow",
      common: value("Fertiliser: bottles almost empty (text, empty = ok)", "string", "text", { def: "" })
    },
    {
      id: "waterTempHistory",
      common: value("Water temperature of the last 24 h as JSON [[ts, \xB0C], ...]", "string", "json", {
        def: "[]"
      })
    }
  ]
};
const FAN_AUTO_STATES = {
  settings: [
    {
      id: "auto",
      common: setting("Automatic: fan by water temperature (Doctor)", "boolean", "switch.enable", false)
    },
    {
      id: "autoOnTemp",
      common: setting("Automatic: on from", "number", "level.temperature", 26, { unit: "\xB0C", min: 15, max: 35 })
    },
    {
      id: "autoOffTemp",
      common: setting("Automatic: off again at", "number", "level.temperature", 25.5, {
        unit: "\xB0C",
        min: 15,
        max: 35
      })
    },
    {
      id: "autoLevel",
      common: setting("Automatic: level (one-point curve, kept for older views)", "number", "level", 11, {
        min: 1,
        max: 20
      })
    },
    {
      id: "curve",
      common: setting(
        "Automatic: curve as JSON [[water \xB0C, level], ...], 1-6 points",
        "string",
        "json",
        JSON.stringify(CURVE_DEFAULT)
      )
    },
    {
      id: "installed",
      common: setting("Fan installed (summer); off = no automatic, no commands", "boolean", "switch", false)
    }
  ],
  values: [
    {
      id: "autoActive",
      common: value("Automatic switched the fan on", "boolean", "indicator", { def: false })
    },
    {
      id: "autoResumeAt",
      common: value("Automatic paused by hand until (0 = not paused)", "number", "date", { def: 0 })
    }
  ]
};
function validateSetting(def, val) {
  var _a, _b;
  const c = def.common;
  if (c.type === "number") {
    const n = typeof val === "string" ? Number(val.replace(",", ".")) : Number(val);
    if (val === null || val === "" || !Number.isFinite(n)) {
      throw new Error(`${def.id}: ${JSON.stringify(val)} is not a number`);
    }
    if (c.min !== void 0 && n < c.min || c.max !== void 0 && n > c.max) {
      throw new Error(`${def.id}: ${n} is outside ${(_a = c.min) != null ? _a : "-"}..${(_b = c.max) != null ? _b : "-"}`);
    }
    return round1(n);
  }
  if (c.type === "boolean") {
    return val === true || val === "true" || val === 1;
  }
  if (def.id === "curve") {
    const c2 = parseCurve(val);
    if (!c2) {
      throw new Error(`curve: ${JSON.stringify(val)} is not a valid curve`);
    }
    return JSON.stringify(c2);
  }
  return String(val != null ? val : "").slice(0, 100);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AQUARIUM_STATES,
  CURVE_DEFAULT,
  DEFAULT_REFILL_ML,
  FAN_AUTO_STATES,
  HAND_PAUSE_MS,
  HISTORY_DAYS,
  HISTORY_KEEP_MS,
  HISTORY_STEP_MS,
  addHistory,
  curveLevel,
  curveTarget,
  dailyDose,
  dayKey,
  daysLeft,
  doserCareStates,
  emptyStock,
  fanAutoAction,
  isLow,
  parseCurve,
  parseStock,
  pumpCareStates,
  refill,
  remaining,
  tempAlarm,
  updateStock,
  validateSetting
});
//# sourceMappingURL=care.js.map
