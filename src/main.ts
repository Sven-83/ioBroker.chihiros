/*
 * ioBroker.chihiros - Chihiros aquarium devices over Bluetooth through an ESPHome Bluetooth proxy.
 * Phase 1: proxy connection and presence of the configured devices.
 * Phase 2: reads the values of all devices one after the other in short GATT sessions (read only).
 */
import * as utils from '@iobroker/adapter-core';
import { Connection } from '@2colors/esphome-native-api';
import { type Device, decideReachable, parseDevices, presenceLogLevel } from './lib/devices';
import { type GattApi, runSession, SessionError } from './lib/gatt';
import { MessageIds } from './lib/protocol';
import { type Advertisement, type ApiConnection, type ProxyConfig, ProxyClient, type Scheduler } from './lib/proxy';
import { interpret, readPlan } from './lib/reader';
import { COMMON_READ_STATES, readChannels, readStates, resultToStates } from './lib/states';

const EVALUATE_MS = 15_000;
/** RSSI is written at most this often per device */
const RSSI_WRITE_MS = 60_000;
/** First read round after the proxy came up */
const FIRST_READ_DELAY_MS = 20_000;
/** Maximum duration of one GATT session after connecting */
const SESSION_TIMEOUT_MS = 12_000;

const TYPE_NAMES: Record<Device['type'], string> = {
    light: 'Light',
    doser: 'Dosing pump',
    co2: 'CO2 controller',
    doctor: 'Doctor',
    fan: 'Fan',
};

interface DeviceRuntime {
    device: Device;
    lastSeen?: number;
    reachable?: boolean;
    rssi?: number;
    rssiWritten: number;
    bleName: string;
    addressType: number;
    /** Failed reads in a row */
    readFailures: number;
}

class Chihiros extends utils.Adapter {
    private proxy: ProxyClient | null = null;
    private readonly runtime = new Map<number, DeviceRuntime>();
    private evaluateTimer: ioBroker.Interval | undefined = undefined;
    private seenMs = 5 * 60_000;
    /** Since when the proxy forwards advertisements, undefined while it is down */
    private listeningSince: number | undefined = undefined;
    private pollMs = 5 * 60_000;
    private pollTimer: ioBroker.Timeout | undefined = undefined;
    private polling = false;
    private stopping = false;
    private readonly ids = new MessageIds();
    private readonly scheduler: Scheduler = {
        setTimeout: (cb, ms) => this.setTimeout(cb, ms),
        clearTimeout: h => this.clearTimeout(h as ioBroker.Timeout),
        now: () => Date.now(),
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'chihiros' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const host = (this.config.proxyHost ?? '').trim();
        const key = (this.config.proxyKey ?? '').trim();
        const minutes = Number(this.config.seenMinutes);
        this.seenMs = (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 5) * 60_000;
        const poll = Number(this.config.pollMinutes);
        this.pollMs = (Number.isFinite(poll) && poll >= 1 && poll <= 60 ? poll : 5) * 60_000;

        const { devices, errors } = parseDevices(this.config.devices);
        for (const e of errors) {
            this.log.error(`configuration: ${e}`);
        }
        await this.syncDeviceObjects(devices);

        if (!host) {
            this.log.error('configuration: no ESPHome Bluetooth proxy is configured');
            return;
        }
        if (!key) {
            this.log.warn('configuration: the proxy API has no encryption key - please enable API encryption');
        }
        if (devices.length === 0) {
            this.log.warn('configuration: no devices configured, only the proxy connection is checked');
        }

        const cfg: ProxyConfig = { host, port: 6053, encryptionKey: key };
        this.proxy = new ProxyClient(
            cfg,
            c =>
                new Connection({
                    host: c.host,
                    port: c.port,
                    encryptionKey: c.encryptionKey,
                    reconnect: false,
                    clientInfo: `ioBroker.chihiros ${this.version ?? ''}`.trim(),
                }) as unknown as ApiConnection,
            this.scheduler,
            this.log,
        );
        this.proxy.on('up', (info: { name: string; version: string }) => {
            this.listeningSince = Date.now();
            void this.setState('info.connection', true, true);
            void this.setState('info.proxyVersion', info.version, true);
            this.schedulePoll(FIRST_READ_DELAY_MS);
        });
        this.proxy.on('down', () => {
            this.listeningSince = undefined;
            void this.setState('info.connection', false, true);
        });
        this.proxy.on('advertisement', (adv: Advertisement) => this.onAdvertisement(adv));
        this.proxy.start();

        this.evaluateTimer = this.setInterval(() => void this.evaluate(), EVALUATE_MS);
    }

    /**
     * Creates the objects of the configured devices and removes those of devices no longer configured
     * (only below this instance).
     *
     * @param devices Validated devices
     */
    private async syncDeviceObjects(devices: Device[]): Promise<void> {
        await this.setObjectNotExistsAsync('info.proxyVersion', {
            type: 'state',
            common: {
                name: 'ESPHome version of the proxy',
                type: 'string',
                role: 'info.firmware',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('devices', {
            type: 'folder',
            common: { name: 'Devices' },
            native: {},
        });
        const wanted = new Set(devices.map(d => d.id));
        for (const d of devices) {
            await this.extendObject(`devices.${d.id}`, {
                type: 'device',
                common: { name: `${d.name} (${TYPE_NAMES[d.type]})` },
                native: { type: d.type, mac: d.mac, seasonal: d.seasonal },
            });
            await this.extendObject(`devices.${d.id}.reachable`, {
                type: 'state',
                common: {
                    name: 'Heard by the proxy',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            await this.extendObject(`devices.${d.id}.lastSeen`, {
                type: 'state',
                common: {
                    name: 'Last heard',
                    type: 'number',
                    role: 'date',
                    read: true,
                    write: false,
                    def: 0,
                },
                native: {},
            });
            await this.extendObject(`devices.${d.id}.rssi`, {
                type: 'state',
                common: {
                    name: 'Signal strength',
                    type: 'number',
                    role: 'value',
                    unit: 'dBm',
                    read: true,
                    write: false,
                    def: 0,
                },
                native: {},
            });
            await this.extendObject(`devices.${d.id}.bleName`, {
                type: 'state',
                common: {
                    name: 'Bluetooth name',
                    type: 'string',
                    role: 'info.name',
                    read: true,
                    write: false,
                    def: '',
                },
                native: {},
            });
            for (const ch of readChannels(d.type)) {
                await this.extendObject(`devices.${d.id}.${ch.id}`, {
                    type: 'channel',
                    common: { name: ch.name },
                    native: {},
                });
            }
            for (const st of [...COMMON_READ_STATES, ...readStates(d.type)]) {
                await this.extendObject(`devices.${d.id}.${st.id}`, { type: 'state', common: st.common, native: {} });
            }
            const lastSeen = await this.getStateAsync(`devices.${d.id}.lastSeen`);
            this.runtime.set(d.macNum, {
                device: d,
                lastSeen: typeof lastSeen?.val === 'number' && lastSeen.val > 0 ? lastSeen.val : undefined,
                rssiWritten: 0,
                bleName: '',
                addressType: 0,
                readFailures: 0,
            });
            this.log.debug(`device ${d.id}: ${d.type} ${d.mac}${d.seasonal ? ' (seasonal)' : ''}`);
        }
        const existing = await this.getObjectViewAsync('system', 'device', {
            startkey: `${this.namespace}.devices.`,
            endkey: `${this.namespace}.devices.香`,
        });
        for (const row of existing.rows) {
            const id = row.id.slice(`${this.namespace}.devices.`.length);
            if (!id.includes('.') && !wanted.has(id)) {
                this.log.info(`device ${id} is no longer configured - removing its objects`);
                await this.delObjectAsync(`devices.${id}`, { recursive: true });
            }
        }
    }

    private onAdvertisement(adv: Advertisement): void {
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
    private async evaluate(): Promise<void> {
        const now = Date.now();
        try {
            for (const rt of this.runtime.values()) {
                const d = rt.device;
                const reachable = decideReachable(rt.lastSeen, now, this.seenMs, this.listeningSince, rt.reachable);
                if (reachable !== undefined && reachable !== rt.reachable) {
                    const first = rt.reachable === undefined;
                    rt.reachable = reachable;
                    await this.setState(`devices.${d.id}.reachable`, reachable, true);
                    if (!first || !reachable) {
                        const msg = reachable
                            ? `${d.name} (${d.mac}) is heard again`
                            : `${d.name} (${d.mac}) not heard for ${Math.round(this.seenMs / 60_000)} min${
                                  d.seasonal ? ' (seasonal device, no warning)' : ''
                              } - no power, out of range or held by the app/hub?`;
                        this.log[presenceLogLevel(d, reachable)](msg);
                    }
                }
                if (rt.lastSeen !== undefined && rt.rssi !== undefined && now - rt.rssiWritten >= RSSI_WRITE_MS) {
                    rt.rssiWritten = now;
                    await this.setState(`devices.${d.id}.lastSeen`, rt.lastSeen, true);
                    await this.setState(`devices.${d.id}.rssi`, rt.rssi, true);
                }
            }
        } catch (e) {
            this.log.warn(`evaluate failed: ${(e as Error).message}`);
        }
    }

    private schedulePoll(ms: number): void {
        if (this.stopping) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        this.pollTimer = this.setTimeout(() => {
            this.pollTimer = undefined;
            void this.pollRound();
        }, ms);
    }

    /** Reads all reachable devices one after the other (one GATT connection at a time) */
    private async pollRound(): Promise<void> {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            for (const rt of this.runtime.values()) {
                if (this.stopping || !this.proxy?.connection) {
                    break;
                }
                // a device that does not advertise is held by the app/hub or has no power: do not even try
                if (rt.reachable !== true) {
                    continue;
                }
                await this.readDevice(rt);
            }
        } catch (e) {
            this.log.warn(`read round failed: ${(e as Error).message}`);
        } finally {
            this.polling = false;
            if (this.proxy?.connection) {
                this.schedulePoll(this.pollMs);
            }
        }
    }

    /**
     * One read session with a device; writes the values or the error.
     *
     * @param rt Runtime data of the device
     */
    private async readDevice(rt: DeviceRuntime): Promise<void> {
        const d = rt.device;
        const conn = this.proxy?.connection;
        if (!conn) {
            return;
        }
        const plan = readPlan(d.type, this.ids);
        try {
            const answers = await runSession(
                conn as unknown as GattApi,
                {
                    address: d.macNum,
                    addressType: rt.addressType,
                    frames: plan.frames,
                    isDone: plan.isDone,
                    timeoutMs: SESSION_TIMEOUT_MS,
                    gapMs: 400,
                    attempts: 2,
                },
                this.scheduler,
            );
            if (this.stopping) {
                return;
            }
            const now = new Date();
            const values = resultToStates(interpret(d.type, answers), now);
            for (const [id, val] of Object.entries(values)) {
                await this.setState(`devices.${d.id}.${id}`, val, true);
            }
            await this.setState(`devices.${d.id}.lastRead`, now.getTime(), true);
            await this.setState(`devices.${d.id}.readError`, '', true);
            if (rt.readFailures > 0) {
                this.log.info(`${d.name}: read again after ${rt.readFailures} failed attempt(s)`);
            }
            rt.readFailures = 0;
            this.log.debug(`${d.name}: ${JSON.stringify(values)}`);
        } catch (e) {
            if (this.stopping) {
                return;
            }
            rt.readFailures++;
            const busy = e instanceof SessionError && e.busy;
            const msg = `${(e as Error).message}${busy ? ' - held by the app/hub?' : ''}`;
            await this.setState(`devices.${d.id}.readError`, msg, true);
            // warn once, then every 12th failure (about once an hour with the default interval)
            const level = rt.readFailures === 1 || rt.readFailures % 12 === 0 ? 'warn' : 'debug';
            this.log[level](`${d.name} (${d.mac}): read failed (${rt.readFailures}x): ${msg}`);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            this.stopping = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
            }
            if (this.evaluateTimer) {
                this.clearInterval(this.evaluateTimer);
            }
            this.proxy?.stop();
            this.proxy = null;
            void this.setState('info.connection', false, true);
        } catch {
            // ignore
        } finally {
            callback();
        }
    }
}

// keep the module export for the compact mode
if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Chihiros(options);
} else {
    (() => new Chihiros())();
}
