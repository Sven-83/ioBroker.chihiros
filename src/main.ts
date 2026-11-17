/*
 * ioBroker.chihiros - Chihiros aquarium devices over Bluetooth through an ESPHome Bluetooth proxy.
 * Phase 1: proxy connection and presence of the configured devices.
 * Phase 2: reads the values of all devices one after the other in short GATT sessions.
 * Phase 3: commands (allowlist per device type) through a queue shared with the read rounds; sets device clocks.
 */
import * as utils from '@iobroker/adapter-core';
import { Connection } from '@2colors/esphome-native-api';
import { type Device, decideReachable, parseDevices, presenceLogLevel } from './lib/devices';
import { type GattApi, runSession, SessionError } from './lib/gatt';
import {
    COMMON_COMMAND_STATES,
    clockFrame,
    co2Command,
    CommandError,
    type CommandPlan,
    doserCommand,
    fanCommand,
    lightCommand,
    type RawFrame,
    RESULT_UNACKED,
    RESULT_UNCONFIRMED,
    writeStates,
} from './lib/commands';
import { FAN_KICK_LEVELS, isOn, POWER_OFF_W, powerIndicator } from './lib/power';
import { encodeFrame, MessageIds, MSG, QUERY } from './lib/protocol';
import { type Advertisement, type ApiConnection, type ProxyConfig, ProxyClient, type Scheduler } from './lib/proxy';
import { clockDeviation, interpret, readPlan } from './lib/reader';
import { COMMON_READ_STATES, readChannels, readStates, resultToStates } from './lib/states';

const EVALUATE_MS = 15_000;
/** RSSI is written at most this often per device */
const RSSI_WRITE_MS = 60_000;
/** First read round after the proxy came up */
const FIRST_READ_DELAY_MS = 20_000;
/** Maximum duration of one GATT session after connecting */
const SESSION_TIMEOUT_MS = 12_000;
/** Clock deviation (minutes) from which the light clock is set */
const CLOCK_MAX_DEVIATION_MIN = 2;
/** Devices without a readable clock get the clock at least this often */
const CLOCK_REFRESH_MS = 24 * 3600_000;
/** First counter check after a manual dose: base delay plus time per ml */
const DOSE_CONFIRM_DELAY_MS = 15_000;
const DOSE_MS_PER_ML = 6_000;
/** Second counter check */
const DOSE_CONFIRM_RETRY_MS = 30_000;
/** CO2: power check after a command */
const CO2_CHECK_DELAY_MS = 10_000;
/** Fan: power check after a level command and after the kick */
const FAN_CHECK_DELAY_MS = 10_000;
/** Fan: wait after each kick level before the power is checked */
const FAN_KICK_STEP_MS = 4_000;

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
    /** Set the clock in the next session */
    clockDue: boolean;
    /** When the clock was set last */
    clockSetAt: number;
    /** Why the clock is due (logged as info); empty = routine (logged as debug) */
    clockReason: string;
    /** Last set values of the writable states */
    values: Record<string, ioBroker.StateValue>;
    /** Last measured on state (power state), undefined = unknown */
    powerOn?: boolean;
    /** Counts the commands; a running confirmation stops when a newer command came */
    commandSeq: number;
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
    private clockSync = true;
    /** Serialises all GATT sessions (the proxy and the devices handle one connection at a time) */
    private gattChain: Promise<void> = Promise.resolve();
    /** Power state ID -> device */
    private readonly powerStates = new Map<string, DeviceRuntime>();
    private readonly scheduler: Scheduler = {
        setTimeout: (cb, ms) => this.setTimeout(cb, ms),
        clearTimeout: h => this.clearTimeout(h as ioBroker.Timeout),
        now: () => Date.now(),
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'chihiros' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
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
        this.clockSync = this.config.clockSync !== false;

        const { devices, errors } = parseDevices(this.config.devices);
        for (const e of errors) {
            this.log.error(`configuration: ${e}`);
        }
        await this.syncDeviceObjects(devices);
        await this.subscribeStatesAsync('devices.*');
        for (const rt of this.runtime.values()) {
            const id = rt.device.powerState;
            if (id && powerIndicator(rt.device.type)) {
                this.powerStates.set(id, rt);
                await this.subscribeForeignStatesAsync(id);
                await this.onPower(rt, await this.getForeignStateAsync(id));
            }
        }

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
            const writable = writeStates(d.type);
            const values: Record<string, ioBroker.StateValue> = {};
            for (const st of writable.length > 0 ? [...COMMON_COMMAND_STATES, ...writable] : []) {
                await this.extendObject(`devices.${d.id}.${st.id}`, { type: 'state', common: st.common, native: {} });
            }
            for (const st of writable) {
                const cur = await this.getStateAsync(`devices.${d.id}.${st.id}`);
                values[st.id] = cur?.val ?? st.common.def ?? null;
            }
            const lastSeen = await this.getStateAsync(`devices.${d.id}.lastSeen`);
            this.runtime.set(d.macNum, {
                device: d,
                lastSeen: typeof lastSeen?.val === 'number' && lastSeen.val > 0 ? lastSeen.val : undefined,
                rssiWritten: 0,
                bleName: '',
                addressType: 0,
                readFailures: 0,
                // the light reports its clock (checked by deviation), the others get it after the start
                clockDue: d.type !== 'light',
                clockSetAt: 0,
                clockReason: '',
                values,
                commandSeq: 0,
            });
            const indicator = powerIndicator(d.type);
            if (indicator && d.powerState) {
                await this.extendObject(`devices.${d.id}.${indicator.id}`, {
                    type: 'state',
                    common: indicator.common,
                    native: {},
                });
            } else if (indicator && (await this.getObjectAsync(`devices.${d.id}.${indicator.id}`))) {
                await this.delObjectAsync(`devices.${d.id}.${indicator.id}`);
            }
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
                    if (reachable && !first && d.type !== 'light') {
                        // back after a power cut or after the app: the clock may be wrong
                        rt.clockDue = true;
                        rt.clockReason = 'heard again';
                    }
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
                await this.withGatt(() => this.readDevice(rt));
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
    private async readDevice(rt: DeviceRuntime): Promise<Record<string, ioBroker.StateValue> | null> {
        const d = rt.device;
        const conn = this.proxy?.connection;
        if (!conn) {
            return null;
        }
        const plan = readPlan(d.type, this.ids);
        if (d.type !== 'light' && Date.now() - rt.clockSetAt > CLOCK_REFRESH_MS) {
            rt.clockDue = true;
        }
        const setClock = this.clockSync && rt.clockDue;
        if (setClock) {
            // after the status query, like the app
            plan.frames.splice(1, 0, this.encode(clockFrame(new Date())));
        }
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
                return null;
            }
            const now = new Date();
            if (setClock) {
                this.clockWasSet(rt, now);
            }
            const result = interpret(d.type, answers);
            if (result.light && Math.abs(clockDeviation(result.light.clockMinute, now)) >= CLOCK_MAX_DEVIATION_MIN) {
                rt.clockDue = true;
                rt.clockReason = 'deviation';
                this.log.info(
                    `${d.name}: device clock deviates by ${clockDeviation(result.light.clockMinute, now)} min${
                        this.clockSync ? ' - setting it in the next round' : ''
                    }`,
                );
            }
            const values = resultToStates(result, now);
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
            return values;
        } catch (e) {
            if (this.stopping) {
                return null;
            }
            rt.readFailures++;
            const busy = e instanceof SessionError && e.busy;
            const msg = `${(e as Error).message}${busy ? ' - held by the app/hub?' : ''}`;
            await this.setState(`devices.${d.id}.readError`, msg, true);
            // warn once, then every 12th failure (about once an hour with the default interval)
            const level = rt.readFailures === 1 || rt.readFailures % 12 === 0 ? 'warn' : 'debug';
            this.log[level](`${d.name} (${d.mac}): read failed (${rt.readFailures}x): ${msg}`);
            return null;
        }
    }

    /**
     * Runs GATT work after all work queued before (one session at a time).
     *
     * @param fn Work
     */
    private withGatt<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.gattChain.then(fn, fn);
        this.gattChain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * Encodes a raw frame with the next message ID.
     *
     * @param f Raw frame
     */
    private encode(f: RawFrame | readonly [number, number, readonly number[]]): Uint8Array {
        return encodeFrame(f[0], f[1], f[2], this.ids.next());
    }

    /**
     * Notes a set clock.
     *
     * @param rt Runtime data of the device
     * @param now Time that was set
     */
    private clockWasSet(rt: DeviceRuntime, now: Date): void {
        const reason = rt.clockReason;
        rt.clockDue = false;
        rt.clockReason = '';
        rt.clockSetAt = now.getTime();
        this.log[reason ? 'info' : 'debug'](
            `${rt.device.name}: clock set to ${now.toLocaleTimeString()}${reason ? ` (${reason})` : ''}`,
        );
    }

    /**
     * Handles writes to the command states (ack=false).
     *
     * @param id Full state ID
     * @param state New state
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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
        const [devId, ...rest] = id.slice(prefix.length).split('.');
        const stateId = rest.join('.');
        const rt = [...this.runtime.values()].find(r => r.device.id === devId);
        if (!rt || !writeStates(rt.device.type).some(s => s.id === stateId)) {
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
    private buildPlan(rt: DeviceRuntime, stateId: string, value: ioBroker.StateValue): CommandPlan {
        switch (rt.device.type) {
            case 'light': {
                const num = (k: string): number => {
                    const v = rt.values[k];
                    return typeof v === 'number' ? v : 0;
                };
                const cur = {
                    red: num('red'),
                    green: num('green'),
                    blue: num('blue'),
                    white: num('white'),
                    on: rt.values.on === true,
                };
                return lightCommand(stateId, value, cur);
            }
            case 'doser':
                return doserCommand(stateId, value);
            case 'fan':
                return fanCommand(stateId, value);
            case 'co2':
                return co2Command(stateId, value);
            default:
                throw new CommandError(`${stateId} is not writable`);
        }
    }

    /**
     * Validates and sends one command, then confirms the states with ack (or restores them on failure).
     *
     * @param rt Runtime data of the device
     * @param stateId Relative state ID
     * @param value Written value
     */
    private async runCommand(rt: DeviceRuntime, stateId: string, value: ioBroker.StateValue): Promise<void> {
        const d = rt.device;
        const base = `devices.${d.id}`;
        const seq = ++rt.commandSeq;
        let plan: CommandPlan | undefined;
        try {
            plan = this.buildPlan(rt, stateId, value);
            await this.setState(`${base}.lastCommand`, plan.label, true);
            if (!this.proxy?.connection) {
                throw new CommandError('proxy not connected');
            }
            if (rt.reachable !== true) {
                throw new CommandError('device not reachable (no power, or held by the app/hub?)');
            }
            const confirm = plan.confirm;
            let before: number | undefined;
            if (confirm) {
                const st = await this.getStateAsync(`${base}.pump${confirm.pump}.total`);
                before = typeof st?.val === 'number' ? st.val : undefined;
            }
            const frames = plan.frames;
            const acked = await this.withGatt(() => this.sendCommand(rt, frames));
            for (const [k, v] of Object.entries(plan.states)) {
                rt.values[k] = v;
                await this.setState(`${base}.${k}`, v, true);
            }
            this.log.info(`${d.name}: ${plan.label} sent${acked ? '' : ' (no write acknowledgement)'}`);
            if (confirm) {
                await this.setState(`${base}.commandResult`, 'sent, waiting for the pump counter', true);
                void this.confirmDose(rt, confirm, before);
            } else if (d.type === 'co2' && d.powerState && typeof plan.states.on === 'boolean') {
                await this.setState(`${base}.commandResult`, 'sent, checking the power', true);
                void this.confirmCo2(rt, plan.states.on, seq);
            } else if (d.type === 'fan' && d.powerState && typeof plan.states.level === 'number') {
                await this.setState(`${base}.commandResult`, 'sent, checking the power', true);
                void this.confirmFan(rt, plan.states.level, seq);
            } else {
                await this.setState(`${base}.commandResult`, acked ? RESULT_UNCONFIRMED : RESULT_UNACKED, true);
            }
        } catch (e) {
            if (this.stopping) {
                return;
            }
            const busy = e instanceof SessionError && e.busy;
            const msg = `${(e as Error).message}${busy ? ' - held by the app/hub?' : ''}`;
            if (!plan) {
                await this.setState(`${base}.lastCommand`, `${stateId} ${JSON.stringify(value)}`, true);
            }
            await this.setState(`${base}.commandResult`, `error: ${msg}`, true);
            // the device keeps its old value: show it again
            await this.setState(`${base}.${stateId}`, rt.values[stateId] ?? null, true);
            this.log.warn(`${d.name}: ${plan?.label ?? stateId} failed: ${msg}`);
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
    private async confirmDose(
        rt: DeviceRuntime,
        c: { pump: number; ml: number },
        before: number | undefined,
    ): Promise<void> {
        const base = `devices.${rt.device.id}`;
        const key = `pump${c.pump}.total`;
        let after: ioBroker.StateValue | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const wait = attempt === 1 ? DOSE_CONFIRM_DELAY_MS + c.ml * DOSE_MS_PER_ML : DOSE_CONFIRM_RETRY_MS;
            await new Promise<void>(r => this.scheduler.setTimeout(r, wait));
            if (this.stopping) {
                return;
            }
            const values = await this.withGatt(() => this.readDevice(rt));
            after = values?.[key];
            if (typeof after === 'number' && typeof before === 'number' && after - before >= c.ml - 0.05) {
                const msg = `confirmed: pump ${c.pump} total ${before} -> ${after} ml`;
                await this.setState(`${base}.commandResult`, msg, true);
                this.log.info(`${rt.device.name}: dose ${msg}`);
                return;
            }
        }
        const msg = `not confirmed: pump ${c.pump} total ${before ?? '?'} -> ${after ?? '?'} ml - please check the pump`;
        await this.setState(`${base}.commandResult`, msg, true);
        this.log.warn(`${rt.device.name}: dose ${c.ml} ml ${msg}`);
    }

    /**
     * Updates the on state of a device from its power state.
     *
     * @param rt Runtime data of the device
     * @param state Power state
     */
    private async onPower(rt: DeviceRuntime, state: ioBroker.State | null | undefined): Promise<void> {
        const indicator = powerIndicator(rt.device.type);
        const on = indicator ? isOn(rt.device.type, state?.val) : null;
        if (!indicator || on === null || on === rt.powerOn || this.stopping) {
            return;
        }
        rt.powerOn = on;
        try {
            await this.setState(`devices.${rt.device.id}.${indicator.id}`, on, true);
        } catch (e) {
            this.log.debug(`${rt.device.name}: power state not written: ${(e as Error).message}`);
        }
    }

    /**
     * Last reported power of a device, null when unknown. Its age is not checked: plugs like the Shelly report
     * a value only when it changes, so 0 W can be hours old and still valid.
     *
     * @param rt Runtime data of the device
     */
    private async currentPower(rt: DeviceRuntime): Promise<number | null> {
        if (!rt.device.powerState) {
            return null;
        }
        const st = await this.getForeignStateAsync(rt.device.powerState);
        if (!st || typeof st.val !== 'number') {
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
    private async confirmCo2(rt: DeviceRuntime, on: boolean, seq: number): Promise<void> {
        const base = `devices.${rt.device.id}`;
        await new Promise<void>(r => this.scheduler.setTimeout(r, CO2_CHECK_DELAY_MS));
        if (this.stopping || seq !== rt.commandSeq) {
            return;
        }
        try {
            const w = await this.currentPower(rt);
            let text: string;
            let level: 'debug' | 'warn' = 'debug';
            if (w === null) {
                text = 'sent, not confirmed (no current power value)';
            } else if (on ? isOn('co2', w) : w <= POWER_OFF_W) {
                text = `confirmed: valve ${on ? 'open' : 'closed'} (${w} W)`;
            } else {
                text = `not confirmed: valve still ${on ? 'closed' : 'open'} (${w} W) - please check the CO2 controller`;
                level = 'warn';
            }
            await this.setState(`${base}.commandResult`, text, true);
            this.log[level](`${rt.device.name}: ${text}`);
        } catch (e) {
            this.log.warn(`${rt.device.name}: power check failed: ${(e as Error).message}`);
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
    private async confirmFan(rt: DeviceRuntime, level: number, seq: number): Promise<void> {
        const base = `devices.${rt.device.id}`;
        const name = rt.device.name;
        const stale = (): boolean => this.stopping || seq !== rt.commandSeq;
        const result = async (text: string, level2: 'info' | 'warn' | 'debug' = 'debug'): Promise<void> => {
            await this.setState(`${base}.commandResult`, text, true);
            this.log[level2](`${name}: ${text}`);
        };
        const measure = async (): Promise<number | null> => {
            await new Promise<void>(r => this.scheduler.setTimeout(r, FAN_CHECK_DELAY_MS));
            return stale() ? null : this.currentPower(rt);
        };
        try {
            let w = await measure();
            if (stale()) {
                return;
            }
            if (w === null) {
                await result('sent, not confirmed (no current power value)');
                return;
            }
            if (level === 0) {
                if (w <= POWER_OFF_W) {
                    await result(`confirmed: off (${w} W)`);
                } else {
                    await result(`not confirmed: still ${w} W after "off" - please check the fan`, 'warn');
                }
                return;
            }
            if (isOn('fan', w)) {
                await result(`confirmed: running (${w} W)`);
                return;
            }
            await result(`not running after level ${level} (${w} W) - kicking ${FAN_KICK_LEVELS.join(' / ')}`, 'info');
            const send = (l: number): Promise<boolean> =>
                this.withGatt(() => this.sendCommand(rt, fanCommand('level', l).frames));
            const pause = (): Promise<void> => new Promise(r => this.scheduler.setTimeout(r, FAN_KICK_STEP_MS));
            for (const [i, kickLevel] of FAN_KICK_LEVELS.entries()) {
                // each level in its own connection: a fan that does not start blocks for about 5 s per level
                await send(kickLevel);
                await pause();
                if (stale()) {
                    return;
                }
                w = await this.currentPower(rt);
                if (w !== null && isOn('fan', w)) {
                    if (kickLevel !== level) {
                        await send(level);
                    }
                    await result(
                        `confirmed after kick (step ${i + 1}, level ${kickLevel}): running (${w} W), level ${level} set`,
                        'info',
                    );
                    return;
                }
            }
            // the last kick level was sent: set the wanted level again so the state stays true
            await send(level);
            await result(
                `not running after ${FAN_KICK_LEVELS.length} kick steps (${w ?? '?'} W) - please check the fan`,
                'warn',
            );
        } catch (e) {
            if (!stale()) {
                await result(`error while checking: ${(e as Error).message}`, 'warn');
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
    private async sendCommand(rt: DeviceRuntime, frames: RawFrame[], gapMs = 400): Promise<boolean> {
        const conn = this.proxy?.connection;
        if (!conn || this.stopping) {
            throw new CommandError('proxy not connected');
        }
        const now = new Date();
        let acked = true;
        await runSession(
            conn as unknown as GattApi,
            {
                address: rt.device.macNum,
                addressType: rt.addressType,
                frames: [this.encode(QUERY.status), this.encode(clockFrame(now)), ...frames.map(f => this.encode(f))],
                isDone: a => a.some(x => x.type === MSG.info),
                timeoutMs: SESSION_TIMEOUT_MS + frames.length * gapMs,
                gapMs,
                attempts: 2,
                // login and clock must be acknowledged, the command frames themselves not always
                tolerateFrom: 2,
                onUnacked: () => (acked = false),
            },
            this.scheduler,
        );
        this.clockWasSet(rt, now);
        return acked;
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
