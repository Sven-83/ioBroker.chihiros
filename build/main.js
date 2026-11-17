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
var import_proxy = require("./lib/proxy");
const EVALUATE_MS = 15e3;
const RSSI_WRITE_MS = 6e4;
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
  constructor(options = {}) {
    super({ ...options, name: "chihiros" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a, _b;
    await this.setState("info.connection", false, true);
    const host = ((_a = this.config.proxyHost) != null ? _a : "").trim();
    const key = ((_b = this.config.proxyKey) != null ? _b : "").trim();
    const minutes = Number(this.config.seenMinutes);
    this.seenMs = (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 5) * 6e4;
    const { devices, errors } = (0, import_devices.parseDevices)(this.config.devices);
    for (const e of errors) {
      this.log.error(`configuration: ${e}`);
    }
    await this.syncDeviceObjects(devices);
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
      {
        setTimeout: (cb, ms) => this.setTimeout(cb, ms),
        clearTimeout: (h) => this.clearTimeout(h),
        now: () => Date.now()
      },
      this.log
    );
    this.proxy.on("up", (info) => {
      this.listeningSince = Date.now();
      void this.setState("info.connection", true, true);
      void this.setState("info.proxyVersion", info.version, true);
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
      const lastSeen = await this.getStateAsync(`devices.${d.id}.lastSeen`);
      this.runtime.set(d.macNum, {
        device: d,
        lastSeen: typeof (lastSeen == null ? void 0 : lastSeen.val) === "number" && lastSeen.val > 0 ? lastSeen.val : void 0,
        rssiWritten: 0,
        bleName: ""
      });
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
  onUnload(callback) {
    var _a;
    try {
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
