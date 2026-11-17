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
var proxy_exports = {};
__export(proxy_exports, {
  ProxyClient: () => ProxyClient,
  SILENCE_RECONNECT_MS: () => SILENCE_RECONNECT_MS,
  SILENCE_RESUBSCRIBE_MS: () => SILENCE_RESUBSCRIBE_MS,
  backoffDelay: () => backoffDelay,
  parseAdvertisements: () => parseAdvertisements
});
module.exports = __toCommonJS(proxy_exports);
var import_node_events = require("node:events");
const AUTH_TIMEOUT_MS = 2e4;
const BACKOFF_START_MS = 5e3;
const BACKOFF_MAX_MS = 3e5;
const SILENCE_RESUBSCRIBE_MS = 6e4;
const SILENCE_RECONNECT_MS = 6e4;
function backoffDelay(attempt) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1));
}
function parseAdvertisements(msg) {
  const list = msg == null ? void 0 : msg.advertisementsList;
  if (!Array.isArray(list)) {
    return [];
  }
  const out = [];
  for (const a of list) {
    const address = Number(a == null ? void 0 : a.address);
    const rssi = Number(a == null ? void 0 : a.rssi);
    if (!Number.isFinite(address) || address <= 0 || !Number.isFinite(rssi)) {
      continue;
    }
    out.push({ address, rssi, name: typeof a.name === "string" ? a.name : "" });
  }
  return out;
}
class ProxyClient extends import_node_events.EventEmitter {
  /**
   * @param cfg Proxy settings
   * @param createConnection Factory for an ESPHome API connection (may throw on a malformed key)
   * @param scheduler Adapter timers
   * @param log Adapter log
   */
  constructor(cfg, createConnection, scheduler, log) {
    super();
    this.cfg = cfg;
    this.createConnection = createConnection;
    this.scheduler = scheduler;
    this.log = log;
  }
  conn = null;
  stopped = true;
  up = false;
  attempt = 0;
  generation = 0;
  retryTimer = null;
  authTimer = null;
  watchdogTimer = null;
  lastAdvertisement = 0;
  resubscribed = false;
  /** True while connected, authorized and subscribed */
  get isUp() {
    return this.up;
  }
  /** Starts connecting */
  start() {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }
  /** Closes the connection; no reconnect afterwards */
  stop() {
    this.stopped = true;
    this.teardown("stopped");
  }
  clearTimers() {
    for (const t of [this.retryTimer, this.authTimer, this.watchdogTimer]) {
      if (t) {
        this.scheduler.clearTimeout(t);
      }
    }
    this.retryTimer = this.authTimer = this.watchdogTimer = null;
  }
  teardown(reason) {
    this.generation++;
    this.clearTimers();
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        conn.removeAllListeners();
        conn.disconnect();
      } catch {
      }
      conn.on("error", () => void 0);
    }
    if (this.up) {
      this.up = false;
      this.emit("down", reason);
    }
  }
  fail(reason) {
    if (this.stopped) {
      return;
    }
    this.teardown(reason);
    this.attempt++;
    const delay = backoffDelay(this.attempt);
    const msg = `proxy ${this.cfg.host}: ${reason}, retry in ${Math.round(delay / 1e3)} s`;
    if (this.attempt === 1 || this.attempt % 10 === 0) {
      this.log.warn(msg);
    } else {
      this.log.debug(msg);
    }
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
  connect() {
    if (this.stopped) {
      return;
    }
    const gen = ++this.generation;
    let conn;
    try {
      conn = this.createConnection(this.cfg);
    } catch (e) {
      this.fail(`cannot create the API connection (${e.message})`);
      return;
    }
    this.conn = conn;
    conn.on("error", (e) => {
      var _a;
      if (gen === this.generation) {
        const hint = /ECONNRESET|handshake|noise/i.test(String(e == null ? void 0 : e.message)) ? " - check the API encryption key" : "";
        this.fail(`API error ${(_a = e == null ? void 0 : e.message) != null ? _a : e}${hint}`);
      }
    });
    conn.on("disconnected", () => {
      if (gen === this.generation) {
        this.fail("connection closed");
      }
    });
    conn.on("unauthorized", () => {
      if (gen === this.generation && this.up) {
        this.fail("authorization lost");
      }
    });
    conn.once("authorized", () => {
      if (gen !== this.generation) {
        return;
      }
      void this.onAuthorized(conn, gen);
    });
    conn.on("message.BluetoothLERawAdvertisementsResponse", (msg) => {
      if (gen !== this.generation) {
        return;
      }
      this.lastAdvertisement = this.scheduler.now();
      this.resubscribed = false;
      for (const adv of parseAdvertisements(msg)) {
        this.emit("advertisement", adv);
      }
    });
    this.authTimer = this.scheduler.setTimeout(() => {
      this.authTimer = null;
      if (gen === this.generation && !this.up) {
        this.fail("no answer from the proxy");
      }
    }, AUTH_TIMEOUT_MS);
    this.log.debug(`proxy ${this.cfg.host}: connecting`);
    try {
      conn.connect();
    } catch (e) {
      this.fail(`connect failed (${e.message})`);
    }
  }
  async onAuthorized(conn, gen) {
    var _a, _b, _c, _d;
    if (this.authTimer) {
      this.scheduler.clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    let info = {};
    try {
      info = await conn.deviceInfoService();
    } catch (e) {
      this.log.debug(`proxy ${this.cfg.host}: device info failed (${e.message})`);
    }
    if (gen !== this.generation) {
      return;
    }
    try {
      conn.subscribeBluetoothAdvertisementService();
    } catch (e) {
      this.fail(`subscribe failed (${e.message})`);
      return;
    }
    this.attempt = 0;
    this.up = true;
    this.lastAdvertisement = this.scheduler.now();
    this.resubscribed = false;
    this.log.info(
      `proxy ${this.cfg.host} connected (${(_a = info.name) != null ? _a : "?"}, ESPHome ${(_b = info.esphomeVersion) != null ? _b : "?"})${this.cfg.encryptionKey ? "" : " WITHOUT API encryption"}`
    );
    this.emit("up", { name: (_c = info.name) != null ? _c : "", version: (_d = info.esphomeVersion) != null ? _d : "" });
    this.armWatchdog(gen);
  }
  armWatchdog(gen) {
    this.watchdogTimer = this.scheduler.setTimeout(() => {
      this.watchdogTimer = null;
      if (gen !== this.generation || !this.conn) {
        return;
      }
      const silence = this.scheduler.now() - this.lastAdvertisement;
      if (!this.resubscribed && silence >= SILENCE_RESUBSCRIBE_MS) {
        this.log.warn(
          `proxy ${this.cfg.host}: no advertisements for ${Math.round(silence / 1e3)} s - subscribing again (another API client on this proxy?)`
        );
        this.resubscribed = true;
        try {
          this.conn.subscribeBluetoothAdvertisementService();
        } catch (e) {
          this.fail(`subscribe failed (${e.message})`);
          return;
        }
      } else if (this.resubscribed && silence >= SILENCE_RESUBSCRIBE_MS + SILENCE_RECONNECT_MS) {
        this.fail("still no advertisements after subscribing again");
        return;
      }
      this.armWatchdog(gen);
    }, 1e4);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProxyClient,
  SILENCE_RECONNECT_MS,
  SILENCE_RESUBSCRIBE_MS,
  backoffDelay,
  parseAdvertisements
});
//# sourceMappingURL=proxy.js.map
