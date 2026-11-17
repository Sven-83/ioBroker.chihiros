"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_esphome_native_api = require("@2colors/esphome-native-api");
var import_devices = require("./lib/devices");
var import_gatt = require("./lib/gatt");
var import_commands = require("./lib/commands");
var import_power = require("./lib/power");
var import_protocol = require("./lib/protocol");
var import_proxy = require("./lib/proxy");
var import_reader = require("./lib/reader");
var import_states = require("./lib/states");
const EVALUATE_MS = 15e3;
const RSSI_WRITE_MS = 6e4;
const FIRST_READ_DELAY_MS = 2e4;
const SESSION_TIMEOUT_MS = 12e3;
const CLOCK_MAX_DEVIATION_MIN = 2;
const CLOCK_REFRESH_MS = 24 * 36e5;
const DOSE_CONFIRM_DELAY_MS = 15e3;
const DOSE_MS_PER_ML = 6e3;
const DOSE_CONFIRM_RETRY_MS = 3e4;
const CO2_CHECK_DELAY_MS = 1e4;
const FAN_CHECK_DELAY_MS = 1e4;
const FAN_KICK_STEP_MS = 4e3;
const TYPE_NAMES = {
  light: "Light",
  doser: "Dosing pump",
  co2: "CO2 controller",
  doctor: "Doctor",
  fan: "Fan"
};
class Chihiros extends utils.Adapter {
  proxy = null;
  runtime = /* @__PURE__ */ new Map();
  evaluateTimer = void 0;
  seenMs = 5 * 6e4;
  /** Since when the proxy forwards advertisements, undefined while it is down */
  listeningSince = void 0;
  pollMs = 5 * 6e4;
  pollTimer = void 0;
  polling = false;
  stopping = false;
  ids = new import_protocol.MessageIds();
  clockSync = true;
  /** Serialises all GATT sessions (the proxy and the devices handle one connection at a time) */
  gattChain = Promise.resolve();
  /** Power state ID -> device */
  powerStates = /* @__PURE__ */ new Map();
  scheduler = {
    setTimeout: (cb, ms) => this.setTimeout(cb, ms),
    clearTimeout: (h) => this.clearTimeout(h),
    now: () => Date.now()
  };
  constructor(options = {}) {
    super({ ...options, name: "chihiros" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a, _b;
    await this.setState("info.connection", false, true);
    const host = ((_a = this.config.proxyHost) != null ? _a : "").trim();
    const key = ((_b = this.config.proxyKey) != null ? _b : "").trim();
    const minutes = Number(this.config.seenMinutes);
    this.seenMs = (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 5) * 6e4;
    const poll = Number(this.config.pollMinutes);
    this.pollMs = (Number.isFinite(poll) && poll >= 1 && poll <= 60 ? poll : 5) * 6e4;
    this.clockSync = this.config.clockSync !== false;
    const { devices, errors } = (0, import_devices.parseDevices)(this.config.devices);
    for (const e of errors) {
      this.log.error(`configuration: ${e}`);
    }
    await this.syncDeviceObjects(devices);
    await this.subscribeStatesAsync("devices.*");
    for (const rt of this.runtime.values()) {
      const id = rt.device.powerState;
      if (id && (0, import_power.powerIndicator)(rt.device.type)) {
        this.powerStates.set(id, rt);
        await this.subscribeForeignStatesAsync(id);
        await this.onPower(rt, await this.getForeignStateAsync(id));
      }
    }
    if (!host) {
      this.log.error("configuration: no ESPHome Bluetooth proxy is configured");
      return;
    }
    if (!key) {
      this.log.warn("configuration: the proxy API has no encryption key - please enable API encryption");
    }
    if (devices.length === 0) {
      this.log.warn("configuration: no devices configured, only the proxy connection is checked");
    }
    const cfg = { host, port: 6053, encryptionKey: key };
    this.proxy = new import_proxy.ProxyClient(
      cfg,
      (c) => {
        var _a2;
        return new import_esphome_native_api.Connection({
          host: c.host,
          port: c.port,
          encryptionKey: c.encryptionKey,
          reconnect: false,
          clientInfo: `ioBroker.chihiros ${(_a2 = this.version) != null ? _a2 : ""}`.trim()
        });
      },
      this.scheduler,
      this.log
    );
    this.proxy.on("up", (info) => {
      this.listeningSince = Date.now();
      void this.setState("info.connection", true, true);
      void this.setState("info.proxyVersion", info.version, true);
      this.schedulePoll(FIRST_READ_DELAY_MS);
    });
    this.proxy.on("down", () => {
      this.listeningSince = void 0;
      void this.setState("info.connection", false, true);
    });
    this.proxy.on("advertisement", (adv) => this.onAdvertisement(adv));
    this.proxy.start();
    this.evaluateTimer = this.setInterval(() => void this.evaluate(), EVALUATE_MS);
  }
  /**
   * Creates the objects of the configured devices and removes those of devices no longer configured
   * (only below this instance).
   *
   * @param devices Validated devices
   */
  async syncDeviceObjects(devices) {
    var _a, _b;
    await this.setObjectNotExistsAsync("info.proxyVersion", {
      type: "state",
      common: {
        name: "ESPHome version of the proxy",
        type: "string",
        role: "info.firmware",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("devices", {
      type: "folder",
      common: { name: "Devices" },
      native: {}
    });
    const wanted = new Set(devices.map((d) => d.id));
    for (const d of devices) {
      await this.extendObject(`devices.${d.id}`, {
        type: "device",
        common: { name: `${d.name} (${TYPE_NAMES[d.type]})` },
        native: { type: d.type, mac: d.mac, seasonal: d.seasonal }
      });
      await this.extendObject(`devices.${d.id}.reachable`, {
        type: "state",
        common: {
          name: "Heard by the proxy",
          type: "boolean",
          role: "indicator.reachable",
          read: true,
          write: false,
          def: false
        },
        native: {}
      });
      await this.extendObject(`devices.${d.id}.lastSeen`, {
        type: "state",
        common: {
          name: "Last heard",
          type: "number",
          role: "date",
          read: true,
          write: false,
          def: 0
        },
        native: {}
      });
      await this.extendObject(`devices.${d.id}.rssi`, {
        type: "state",
        common: {
          name: "Signal strength",
          type: "number",
          role: "value",
          unit: "dBm",
          read: true,
          write: false,
          def: 0
        },
        native: {}
      });
      await this.extendObject(`devices.${d.id}.bleName`, {
        type: "state",
        common: {
          name: "Bluetooth name",
          type: "string",
          role: "info.name",
          read: true,
          write: false,
          def: ""
        },
        native: {}
      });
      for (const ch of (0, import_states.readChannels)(d.type)) {
        await this.extendObject(`devices.${d.id}.${ch.id}`, {
          type: "channel",
          common: { name: ch.name },
          native: {}
        });
      }
      for (const st of [...import_states.COMMON_READ_STATES, ...(0, import_states.readStates)(d.type)]) {
        await this.extendObject(`devices.${d.id}.${st.id}`, { type: "state", common: st.common, native: {} });
      }
      const writable = (0, import_commands.writeStates)(d.type);
      const values = {};
      for (const st of writable.length > 0 ? [...import_commands.COMMON_COMMAND_STATES, ...writable] : []) {
        await this.extendObject(`devices.${d.id}.${st.id}`, { type: "state", common: st.common, native: {} });
      }
      for (const st of writable) {
        const cur = await this.getStateAsync(`devices.${d.id}.${st.id}`);
        values[st.id] = (_b = (_a = cur == null ? void 0 : cur.val) != null ? _a : st.common.def) != null ? _b : null;
      }
      const lastSeen = await this.getStateAsync(`devices.${d.id}.lastSeen`);
      this.runtime.set(d.macNum, {
        device: d,
        lastSeen: typeof (lastSeen == null ? void 0 : lastSeen.val) === "number" && lastSeen.val > 0 ? lastSeen.val : void 0,
        rssiWritten: 0,
        bleName: "",
        addressType: 0,
        readFailures: 0,
        // the light reports its clock (checked by deviation), the others get it after the start
        clockDue: d.type !== "light",
        clockSetAt: 0,
        clockReason: "",
        values,
        commandSeq: 0
      });
      const indicator = (0, import_power.powerIndicator)(d.type);
      if (indicator && d.powerState) {
        await this.extendObject(`devices.${d.id}.${indicator.id}`, {
          type: "state",
          common: indicator.common,
          native: {}
        });
      } else if (indicator && await this.getObjectAsync(`devices.${d.id}.${indicator.id}`)) {
        await this.delObjectAsync(`devices.${d.id}.${indicator.id}`);
      }
      this.log.debug(`device ${d.id}: ${d.type} ${d.mac}${d.seasonal ? " (seasonal)" : ""}`);
    }
    const existing = await this.getObjectViewAsync("system", "device", {
      startkey: `${this.namespace}.devices.`,
      endkey: `${this.namespace}.devices.\u9999`
    });
    for (const row of existing.rows) {
      const id = row.id.slice(`${this.namespace}.devices.`.length);
      if (!id.includes(".") && !wanted.has(id)) {
        this.log.info(`device ${id} is no longer configured - removing its objects`);
        await this.delObjectAsync(`devices.${id}`, { recursive: true });
      }
    }
  }
  onAdvertisement(adv) {
    const rt = this.runtime.get(adv.address);
    if (!rt) {
      return;
    }
    const now = Date.now();
    rt.lastSeen = now;
    rt.rssi = adv.rssi;
    rt.addressType = adv.addressType;
    if (adv.name && adv.name !== rt.bleName) {
      rt.bleName = adv.name;
      void this.setState(`devices.${rt.device.id}.bleName`, adv.name, true);
    }
    if (rt.reachable !== true) {
      void this.evaluate();
    }
  }
  /** Updates reachable/lastSeen/rssi of all devices; logs changes */
  async evaluate() {
    const now = Date.now();
    try {
      for (const rt of this.runtime.values()) {
        const d = rt.device;
        const reachable = (0, import_devices.decideReachable)(rt.lastSeen, now, this.seenMs, this.listeningSince, rt.reachable);
        if (reachable !== void 0 && reachable !== rt.reachable) {
          const first = rt.reachable === void 0;
          rt.reachable = reachable;
          if (reachable && !first && d.type !== "light") {
            rt.clockDue = true;
            rt.clockReason = "heard again";
          }
          await this.setState(`devices.${d.id}.reachable`, reachable, true);
          if (!first || !reachable) {
            const msg = reachable ? `${d.name} (${d.mac}) is heard again` : `${d.name} (${d.mac}) not heard for ${Math.round(this.seenMs / 6e4)} min${d.seasonal ? " (seasonal device, no warning)" : ""} - no power, out of range or held by the app/hub?`;
            this.log[(0, import_devices.presenceLogLevel)(d, reachable)](msg);
          }
        }
        if (rt.lastSeen !== void 0 && rt.rssi !== void 0 && now - rt.rssiWritten >= RSSI_WRITE_MS) {
          rt.rssiWritten = now;
          await this.setState(`devices.${d.id}.lastSeen`, rt.lastSeen, true);
          await this.setState(`devices.${d.id}.rssi`, rt.rssi, true);
        }
      }
    } catch (e) {
      this.log.warn(`evaluate failed: ${e.message}`);
    }
  }
  schedulePoll(ms) {
    if (this.stopping) {
      return;
    }
    if (this.pollTimer) {
      this.clearTimeout(this.pollTimer);
    }
    this.pollTimer = this.setTimeout(() => {
      this.pollTimer = void 0;
      void this.pollRound();
    }, ms);
  }
  /** Reads all reachable devices one after the other (one GATT connection at a time) */
  async pollRound() {
    var _a, _b;
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const rt of this.runtime.values()) {
        if (this.stopping || !((_a = this.proxy) == null ? void 0 : _a.connection)) {
          break;
        }
        if (rt.reachable !== true) {
          continue;
        }
        await this.withGatt(() => this.readDevice(rt));
      }
    } catch (e) {
      this.log.warn(`read round failed: ${e.message}`);
    } finally {
      this.polling = false;
      if ((_b = this.proxy) == null ? void 0 : _b.connection) {
        this.schedulePoll(this.pollMs);
      }
    }
  }
  /**
   * One read session with a device; writes the values or the error.
   *
   * @param rt Runtime data of the device
   */
  async readDevice(rt) {
    var _a;
    const d = rt.device;
    const conn = (_a = this.proxy) == null ? void 0 : _a.connection;
    if (!conn) {
      return null;
    }
    const plan = (0, import_reader.readPlan)(d.type, this.ids);
    if (d.type !== "light" && Date.now() - rt.clockSetAt > CLOCK_REFRESH_MS) {
      rt.clockDue = true;
    }
    const setClock = this.clockSync && rt.clockDue;
    if (setClock) {
      plan.frames.splice(1, 0, this.encode((0, import_commands.clockFrame)(/* @__PURE__ */ new Date())));
    }
    try {
      const answers = await (0, import_gatt.runSession)(
        conn,
        {
          address: d.macNum,
          addressType: rt.addressType,
          frames: plan.frames,
          isDone: plan.isDone,
          timeoutMs: SESSION_TIMEOUT_MS,
          gapMs: 400,
          attempts: 2
        },
        this.scheduler
      );
      if (this.stopping) {
        return null;
      }
      const now = /* @__PURE__ */ new Date();
      if (setClock) {
        this.clockWasSet(rt, now);
      }
      const result = (0, import_reader.interpret)(d.type, answers);
      if (result.light && Math.abs((0, import_reader.clockDeviation)(result.light.clockMinute, now)) >= CLOCK_MAX_DEVIATION_MIN) {
        rt.clockDue = true;
        rt.clockReason = "deviation";
        this.log.info(
          `${d.name}: device clock deviates by ${(0, import_reader.clockDeviation)(result.light.clockMinute, now)} min${this.clockSync ? " - setting it in the next round" : ""}`
        );
      }
      const values = (0, import_states.resultToStates)(result, now);
      for (const [id, val] of Object.entries(values)) {
        await this.setState(`devices.${d.id}.${id}`, val, true);
      }
      await this.setState(`devices.${d.id}.lastRead`, now.getTime(), true);
      await this.setState(`devices.${d.id}.readError`, "", true);
      if (rt.readFailures > 0) {
        this.log.info(`${d.name}: read again after ${rt.readFailures} failed attempt(s)`);
      }
      rt.readFailures = 0;
      this.log.debug(`${d.name}: ${JSON.stringify(values)}`);
      return values;
    } catch (e) {
      if (this.stopping) {
        return null;
      }
      rt.readFailures++;
      const busy = e instanceof import_gatt.SessionError && e.busy;
      const msg = `${e.message}${busy ? " - held by the app/hub?" : ""}`;
      await this.setState(`devices.${d.id}.readError`, msg, true);
      const level = rt.readFailures === 1 || rt.readFailures % 12 === 0 ? "warn" : "debug";
      this.log[level](`${d.name} (${d.mac}): read failed (${rt.readFailures}x): ${msg}`);
      return null;
    }
  }
  /**
   * Runs GATT work after all work queued before (one session at a time).
   *
   * @param fn Work
   */
  withGatt(fn) {
    const run = this.gattChain.then(fn, fn);
    this.gattChain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  /**
   * Encodes a raw frame with the next message ID.
   *
   * @param f Raw frame
   */
  encode(f) {
    return (0, import_protocol.encodeFrame)(f[0], f[1], f[2], this.ids.next());
  }
  /**
   * Notes a set clock.
   *
   * @param rt Runtime data of the device
   * @param now Time that was set
   */
  clockWasSet(rt, now) {
    const reason = rt.clockReason;
    rt.clockDue = false;
    rt.clockReason = "";
    rt.clockSetAt = now.getTime();
    this.log[reason ? "info" : "debug"](
      `${rt.device.name}: clock set to ${now.toLocaleTimeString()}${reason ? ` (${reason})` : ""}`
    );
  }
  /**
   * Handles writes to the command states (ack=false).
   *
   * @param id Full state ID
   * @param state New state
   */
  onStateChange(id, state) {
    const powerOf = this.powerStates.get(id);
    if (powerOf) {
      void this.onPower(powerOf, state);
      return;
    }
    if (!state || state.ack || this.stopping) {
      return;
    }
    const prefix = `${this.namespace}.devices.`;
    if (!id.startsWith(prefix)) {
      return;
    }
    const [devId, ...rest] = id.slice(prefix.length).split(".");
    const stateId = rest.join(".");
    const rt = [...this.runtime.values()].find((r) => r.device.id === devId);
    if (!rt || !(0, import_commands.writeStates)(rt.device.type).some((s) => s.id === stateId)) {
      return;
    }
    void this.runCommand(rt, stateId, state.val);
  }
  /**
   * Builds the command plan of a write.
   *
   * @param rt Runtime data of the device
   * @param stateId Relative state ID
   * @param value Written value
   */
  buildPlan(rt, stateId, value) {
    switch (rt.device.type) {
      case "light": {
        const num = (k) => {
          const v = rt.values[k];
          return typeof v === "number" ? v : 0;
        };
        const cur = {
          red: num("red"),
          green: num("green"),
          blue: num("blue"),
          white: num("white"),
          on: rt.values.on === true
        };
        return (0, import_commands.lightCommand)(stateId, value, cur);
      }
      case "doser":
        return (0, import_commands.doserCommand)(stateId, value);
      case "fan":
        return (0, import_commands.fanCommand)(stateId, value);
      case "co2":
        return (0, import_commands.co2Command)(stateId, value);
      case "doctor":
        return (0, import_commands.doctorCommand)(stateId, value);
      default:
        throw new import_commands.CommandError(`${stateId} is not writable`);
    }
  }
  /**
   * Validates and sends one command, then confirms the states with ack (or restores them on failure).
   *
   * @param rt Runtime data of the device
   * @param stateId Relative state ID
   * @param value Written value
   */
  async runCommand(rt, stateId, value) {
    var _a, _b, _c;
    const d = rt.device;
    const base = `devices.${d.id}`;
    const seq = ++rt.commandSeq;
    let plan;
    try {
      plan = this.buildPlan(rt, stateId, value);
      await this.setState(`${base}.lastCommand`, plan.label, true);
      if (!((_a = this.proxy) == null ? void 0 : _a.connection)) {
        throw new import_commands.CommandError("proxy not connected");
      }
      if (rt.reachable !== true) {
        throw new import_commands.CommandError("device not reachable (no power, or held by the app/hub?)");
      }
      const confirm = plan.confirm;
      let before;
      if (confirm) {
        const st = await this.getStateAsync(`${base}.pump${confirm.pump}.total`);
        before = typeof (st == null ? void 0 : st.val) === "number" ? st.val : void 0;
      }
      const frames = plan.frames;
      const acked = await this.withGatt(() => this.sendCommand(rt, frames));
      for (const [k, v] of Object.entries(plan.states)) {
        rt.values[k] = v;
        await this.setState(`${base}.${k}`, v, true);
      }
      this.log.info(`${d.name}: ${plan.label} sent${acked ? "" : " (no write acknowledgement)"}`);
      if (confirm) {
        await this.setState(`${base}.commandResult`, "sent, waiting for the pump counter", true);
        void this.confirmDose(rt, confirm, before);
      } else if (d.type === "co2" && d.powerState && typeof plan.states.on === "boolean") {
        await this.setState(`${base}.commandResult`, "sent, checking the power", true);
        void this.confirmCo2(rt, plan.states.on, seq);
      } else if (d.type === "fan" && d.powerState && typeof plan.states.level === "number") {
        await this.setState(`${base}.commandResult`, "sent, checking the power", true);
        void this.confirmFan(rt, plan.states.level, seq);
      } else {
        await this.setState(`${base}.commandResult`, acked ? import_commands.RESULT_UNCONFIRMED : import_commands.RESULT_UNACKED, true);
      }
    } catch (e) {
      if (this.stopping) {
        return;
      }
      const busy = e instanceof import_gatt.SessionError && e.busy;
      const msg = `${e.message}${busy ? " - held by the app/hub?" : ""}`;
      if (!plan) {
        await this.setState(`${base}.lastCommand`, `${stateId} ${JSON.stringify(value)}`, true);
      }
      await this.setState(`${base}.commandResult`, `error: ${msg}`, true);
      await this.setState(`${base}.${stateId}`, (_b = rt.values[stateId]) != null ? _b : null, true);
      this.log.warn(`${d.name}: ${(_c = plan == null ? void 0 : plan.label) != null ? _c : stateId} failed: ${msg}`);
    }
  }
  /**
   * Confirms a manual dose by the total counter of the pump (read after the pump had time to run).
   *
   * @param rt Runtime data of the dosing pump
   * @param c Pump and amount
   * @param c.pump Pump 1-4
   * @param c.ml Dosed ml
   * @param before Total counter before the dose
   */
  async confirmDose(rt, c, before) {
    const base = `devices.${rt.device.id}`;
    const key = `pump${c.pump}.total`;
    let after;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const wait = attempt === 1 ? DOSE_CONFIRM_DELAY_MS + c.ml * DOSE_MS_PER_ML : DOSE_CONFIRM_RETRY_MS;
      await new Promise((r) => this.scheduler.setTimeout(r, wait));
      if (this.stopping) {
        return;
      }
      const values = await this.withGatt(() => this.readDevice(rt));
      after = values == null ? void 0 : values[key];
      if (typeof after === "number" && typeof before === "number" && after - before >= c.ml - 0.05) {
        const msg2 = `confirmed: pump ${c.pump} total ${before} -> ${after} ml`;
        await this.setState(`${base}.commandResult`, msg2, true);
        this.log.info(`${rt.device.name}: dose ${msg2}`);
        return;
      }
    }
    const msg = `not confirmed: pump ${c.pump} total ${before != null ? before : "?"} -> ${after != null ? after : "?"} ml - please check the pump`;
    await this.setState(`${base}.commandResult`, msg, true);
    this.log.warn(`${rt.device.name}: dose ${c.ml} ml ${msg}`);
  }
  /**
   * Updates the on state of a device from its power state.
   *
   * @param rt Runtime data of the device
   * @param state Power state
   */
  async onPower(rt, state) {
    const indicator = (0, import_power.powerIndicator)(rt.device.type);
    const on = indicator ? (0, import_power.isOn)(rt.device.type, state == null ? void 0 : state.val) : null;
    if (!indicator || on === null || on === rt.powerOn || this.stopping) {
      return;
    }
    rt.powerOn = on;
    try {
      await this.setState(`devices.${rt.device.id}.${indicator.id}`, on, true);
    } catch (e) {
      this.log.debug(`${rt.device.name}: power state not written: ${e.message}`);
    }
  }
  /**
   * Last reported power of a device, null when unknown. Its age is not checked: plugs like the Shelly report
   * a value only when it changes, so 0 W can be hours old and still valid.
   *
   * @param rt Runtime data of the device
   */
  async currentPower(rt) {
    if (!rt.device.powerState) {
      return null;
    }
    const st = await this.getForeignStateAsync(rt.device.powerState);
    if (!st || typeof st.val !== "number") {
      return null;
    }
    return st.val;
  }
  /**
   * CO2: checks by the power of the controller whether the valve followed the command.
   *
   * @param rt Runtime data of the CO2 controller
   * @param on Wanted state
   * @param seq Command number; stops when a newer command came
   */
  async confirmCo2(rt, on, seq) {
    const base = `devices.${rt.device.id}`;
    await new Promise((r) => this.scheduler.setTimeout(r, CO2_CHECK_DELAY_MS));
    if (this.stopping || seq !== rt.commandSeq) {
      return;
    }
    try {
      const w = await this.currentPower(rt);
      let text;
      let level = "debug";
      if (w === null) {
        text = "sent, not confirmed (no current power value)";
      } else if (on ? (0, import_power.isOn)("co2", w) : w <= import_power.POWER_OFF_W) {
        text = `confirmed: valve ${on ? "open" : "closed"} (${w} W)`;
      } else {
        text = `not confirmed: valve still ${on ? "closed" : "open"} (${w} W) - please check the CO2 controller`;
        level = "warn";
      }
      await this.setState(`${base}.commandResult`, text, true);
      this.log[level](`${rt.device.name}: ${text}`);
    } catch (e) {
      this.log.warn(`${rt.device.name}: power check failed: ${e.message}`);
    }
  }
  /**
   * Fan: checks by the power whether a level command worked; if the fan does not start, kicks it
   * (up, down, wanted level - like in the app) and checks again.
   *
   * @param rt Runtime data of the fan
   * @param level Level that was sent
   * @param seq Command number; stops when a newer command came
   */
  async confirmFan(rt, level, seq) {
    const base = `devices.${rt.device.id}`;
    const name = rt.device.name;
    const stale = () => this.stopping || seq !== rt.commandSeq;
    const result = async (text, level2 = "debug") => {
      await this.setState(`${base}.commandResult`, text, true);
      this.log[level2](`${name}: ${text}`);
    };
    const measure = async () => {
      await new Promise((r) => this.scheduler.setTimeout(r, FAN_CHECK_DELAY_MS));
      return stale() ? null : this.currentPower(rt);
    };
    try {
      let w = await measure();
      if (stale()) {
        return;
      }
      if (w === null) {
        await result("sent, not confirmed (no current power value)");
        return;
      }
      if (level === 0) {
        if (w <= import_power.POWER_OFF_W) {
          await result(`confirmed: off (${w} W)`);
        } else {
          await result(`not confirmed: still ${w} W after "off" - please check the fan`, "warn");
        }
        return;
      }
      if ((0, import_power.isOn)("fan", w)) {
        await result(`confirmed: running (${w} W)`);
        return;
      }
      await result(`not running after level ${level} (${w} W) - kicking ${import_power.FAN_KICK_LEVELS.join(" / ")}`, "info");
      const send = (l) => this.withGatt(() => this.sendCommand(rt, (0, import_commands.fanCommand)("level", l).frames));
      const pause = () => new Promise((r) => this.scheduler.setTimeout(r, FAN_KICK_STEP_MS));
      for (const [i, kickLevel] of import_power.FAN_KICK_LEVELS.entries()) {
        await send(kickLevel);
        await pause();
        if (stale()) {
          return;
        }
        w = await this.currentPower(rt);
        if (w !== null && (0, import_power.isOn)("fan", w)) {
          if (kickLevel !== level) {
            await send(level);
          }
          await result(
            `confirmed after kick (step ${i + 1}, level ${kickLevel}): running (${w} W), level ${level} set`,
            "info"
          );
          return;
        }
      }
      await send(level);
      await result(
        `not running after ${import_power.FAN_KICK_LEVELS.length} kick steps (${w != null ? w : "?"} W) - please check the fan`,
        "warn"
      );
    } catch (e) {
      if (!stale()) {
        await result(`error while checking: ${e.message}`, "warn");
      }
    }
  }
  /**
   * One command session: login, clock (like the app), command frames, disconnect.
   *
   * @param rt Runtime data of the device
   * @param frames Command frames
   * @param gapMs Pause between the frames
   * @returns false when the device did not acknowledge a command frame
   */
  async sendCommand(rt, frames, gapMs = 400) {
    var _a;
    const conn = (_a = this.proxy) == null ? void 0 : _a.connection;
    if (!conn || this.stopping) {
      throw new import_commands.CommandError("proxy not connected");
    }
    const now = /* @__PURE__ */ new Date();
    let acked = true;
    await (0, import_gatt.runSession)(
      conn,
      {
        address: rt.device.macNum,
        addressType: rt.addressType,
        frames: [this.encode(import_protocol.QUERY.status), this.encode((0, import_commands.clockFrame)(now)), ...frames.map((f) => this.encode(f))],
        isDone: (a) => a.some((x) => x.type === import_protocol.MSG.info),
        timeoutMs: SESSION_TIMEOUT_MS + frames.length * gapMs,
        gapMs,
        attempts: 2,
        // login and clock must be acknowledged, the command frames themselves not always
        tolerateFrom: 2,
        onUnacked: () => acked = false
      },
      this.scheduler
    );
    this.clockWasSet(rt, now);
    return acked;
  }
  onUnload(callback) {
    var _a;
    try {
      this.stopping = true;
      if (this.pollTimer) {
        this.clearTimeout(this.pollTimer);
      }
      if (this.evaluateTimer) {
        this.clearInterval(this.evaluateTimer);
      }
      (_a = this.proxy) == null ? void 0 : _a.stop();
      this.proxy = null;
      void this.setState("info.connection", false, true);
    } catch {
    } finally {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Chihiros(options);
} else {
  (() => new Chihiros())();
}
//# sourceMappingURL=main.js.map
