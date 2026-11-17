/**
 * Connection to one ESPHome Bluetooth proxy: listens to BLE advertisements.
 * Reconnects with exponential backoff and re-subscribes when advertisements stop
 * (since ESPHome 2026.7 a newer API client takes the subscription over, template B.12.24).
 */
import { EventEmitter } from 'node:events';

/** The part of the ESPHome API connection this module needs (allows a fake in tests) */
export interface ApiConnection {
    /** Opens the connection */
    connect(): void;
    /** Closes the connection */
    disconnect(): void;
    /** Adds an event listener */
    on(event: string, listener: (...args: any[]) => void): unknown;
    /** Adds a one-time event listener */
    once(event: string, listener: (...args: any[]) => void): unknown;
    /** Removes all event listeners */
    removeAllListeners(): unknown;
    /** Reads the device info */
    deviceInfoService(): Promise<{ name?: string; esphomeVersion?: string; bluetoothProxyFeatureFlags?: number }>;
    /** Starts forwarding BLE advertisements */
    subscribeBluetoothAdvertisementService(): void;
}

/** Settings of the proxy */
export interface ProxyConfig {
    /** Host name or IP address */
    host: string;
    /** API port */
    port: number;
    /** Base64 Noise key (32 bytes); empty only for proxies without API encryption */
    encryptionKey: string;
}

/** Timer functions of the adapter (compact mode safe) */
export interface Scheduler {
    /** Starts a timer */
    setTimeout(cb: () => void, ms: number): unknown;
    /** Stops a timer */
    clearTimeout(handle: unknown): void;
    /** Current time in ms */
    now(): number;
}

/** Log functions */
export interface ProxyLog {
    /** Debug log */
    debug(msg: string): void;
    /** Info log */
    info(msg: string): void;
    /** Warning log */
    warn(msg: string): void;
}

/** One advertisement */
export interface Advertisement {
    /** 48-bit address */
    address: number;
    /** Signal strength in dBm */
    rssi: number;
    /** Local name if present in this packet */
    name: string;
}

const AUTH_TIMEOUT_MS = 20_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
/** No advertisement for this long: subscribe again */
export const SILENCE_RESUBSCRIBE_MS = 60_000;
/** Still nothing after re-subscribing: reconnect */
export const SILENCE_RECONNECT_MS = 60_000;

/**
 * Next backoff delay.
 *
 * @param attempt Number of failed attempts in a row (1 = first failure)
 */
export function backoffDelay(attempt: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Reads the advertisements out of a BluetoothLERawAdvertisementsResponse (already parsed by the library).
 *
 * @param msg Message from the library
 */
export function parseAdvertisements(msg: unknown): Advertisement[] {
    const list = (msg as { advertisementsList?: unknown[] } | undefined)?.advertisementsList;
    if (!Array.isArray(list)) {
        return [];
    }
    const out: Advertisement[] = [];
    for (const a of list as Array<Record<string, unknown>>) {
        const address = Number(a?.address);
        const rssi = Number(a?.rssi);
        if (!Number.isFinite(address) || address <= 0 || !Number.isFinite(rssi)) {
            continue;
        }
        out.push({ address, rssi, name: typeof a.name === 'string' ? a.name : '' });
    }
    return out;
}

/**
 * Events: 'up' (info: {name, version}), 'down' (reason: string), 'advertisement' (Advertisement)
 */
export class ProxyClient extends EventEmitter {
    private conn: ApiConnection | null = null;
    private stopped = true;
    private up = false;
    private attempt = 0;
    private generation = 0;
    private retryTimer: unknown = null;
    private authTimer: unknown = null;
    private watchdogTimer: unknown = null;
    private lastAdvertisement = 0;
    private resubscribed = false;

    /**
     * @param cfg Proxy settings
     * @param createConnection Factory for an ESPHome API connection (may throw on a malformed key)
     * @param scheduler Adapter timers
     * @param log Adapter log
     */
    public constructor(
        private readonly cfg: ProxyConfig,
        private readonly createConnection: (cfg: ProxyConfig) => ApiConnection,
        private readonly scheduler: Scheduler,
        private readonly log: ProxyLog,
    ) {
        super();
    }

    /** True while connected, authorized and subscribed */
    public get isUp(): boolean {
        return this.up;
    }

    /** Starts connecting */
    public start(): void {
        this.stopped = false;
        this.attempt = 0;
        this.connect();
    }

    /** Closes the connection; no reconnect afterwards */
    public stop(): void {
        this.stopped = true;
        this.teardown('stopped');
    }

    private clearTimers(): void {
        for (const t of [this.retryTimer, this.authTimer, this.watchdogTimer]) {
            if (t) {
                this.scheduler.clearTimeout(t);
            }
        }
        this.retryTimer = this.authTimer = this.watchdogTimer = null;
    }

    private teardown(reason: string): void {
        this.generation++;
        this.clearTimers();
        const conn = this.conn;
        this.conn = null;
        if (conn) {
            try {
                conn.removeAllListeners();
                // the library emits 'error' on a failed disconnect; keep a listener so it is not thrown
                conn.on('error', () => undefined);
                conn.disconnect();
            } catch {
                // already closed
            }
        }
        if (this.up) {
            this.up = false;
            this.emit('down', reason);
        }
    }

    private fail(reason: string): void {
        if (this.stopped) {
            return;
        }
        this.teardown(reason);
        this.attempt++;
        const delay = backoffDelay(this.attempt);
        const msg = `proxy ${this.cfg.host}: ${reason}, retry in ${Math.round(delay / 1000)} s`;
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

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const gen = ++this.generation;
        let conn: ApiConnection;
        try {
            conn = this.createConnection(this.cfg);
        } catch (e) {
            // malformed key: retrying does not help, but keep the backoff so a fixed config is picked up after restart
            this.fail(`cannot create the API connection (${(e as Error).message})`);
            return;
        }
        this.conn = conn;
        conn.on('error', (e: Error) => {
            if (gen === this.generation) {
                const hint = /ECONNRESET|handshake|noise/i.test(String(e?.message))
                    ? ' - check the API encryption key'
                    : '';
                this.fail(`API error ${e?.message ?? e}${hint}`);
            }
        });
        conn.on('disconnected', () => {
            if (gen === this.generation) {
                this.fail('connection closed');
            }
        });
        conn.on('unauthorized', () => {
            if (gen === this.generation && this.up) {
                this.fail('authorization lost');
            }
        });
        conn.once('authorized', () => {
            if (gen !== this.generation) {
                return;
            }
            void this.onAuthorized(conn, gen);
        });
        conn.on('message.BluetoothLERawAdvertisementsResponse', (msg: unknown) => {
            if (gen !== this.generation) {
                return;
            }
            this.lastAdvertisement = this.scheduler.now();
            this.resubscribed = false;
            for (const adv of parseAdvertisements(msg)) {
                this.emit('advertisement', adv);
            }
        });
        this.authTimer = this.scheduler.setTimeout(() => {
            this.authTimer = null;
            if (gen === this.generation && !this.up) {
                this.fail('no answer from the proxy');
            }
        }, AUTH_TIMEOUT_MS);
        this.log.debug(`proxy ${this.cfg.host}: connecting`);
        try {
            conn.connect();
        } catch (e) {
            this.fail(`connect failed (${(e as Error).message})`);
        }
    }

    private async onAuthorized(conn: ApiConnection, gen: number): Promise<void> {
        if (this.authTimer) {
            this.scheduler.clearTimeout(this.authTimer);
            this.authTimer = null;
        }
        let info: { name?: string; esphomeVersion?: string } = {};
        try {
            info = await conn.deviceInfoService();
        } catch (e) {
            this.log.debug(`proxy ${this.cfg.host}: device info failed (${(e as Error).message})`);
        }
        if (gen !== this.generation) {
            return;
        }
        try {
            conn.subscribeBluetoothAdvertisementService();
        } catch (e) {
            this.fail(`subscribe failed (${(e as Error).message})`);
            return;
        }
        this.attempt = 0;
        this.up = true;
        this.lastAdvertisement = this.scheduler.now();
        this.resubscribed = false;
        this.log.info(
            `proxy ${this.cfg.host} connected (${info.name ?? '?'}, ESPHome ${info.esphomeVersion ?? '?'})${
                this.cfg.encryptionKey ? '' : ' WITHOUT API encryption'
            }`,
        );
        this.emit('up', { name: info.name ?? '', version: info.esphomeVersion ?? '' });
        this.armWatchdog(gen);
    }

    private armWatchdog(gen: number): void {
        this.watchdogTimer = this.scheduler.setTimeout(() => {
            this.watchdogTimer = null;
            if (gen !== this.generation || !this.conn) {
                return;
            }
            const silence = this.scheduler.now() - this.lastAdvertisement;
            if (!this.resubscribed && silence >= SILENCE_RESUBSCRIBE_MS) {
                this.log.warn(
                    `proxy ${this.cfg.host}: no advertisements for ${Math.round(silence / 1000)} s - subscribing again (another API client on this proxy?)`,
                );
                this.resubscribed = true;
                try {
                    this.conn.subscribeBluetoothAdvertisementService();
                } catch (e) {
                    this.fail(`subscribe failed (${(e as Error).message})`);
                    return;
                }
            } else if (this.resubscribed && silence >= SILENCE_RESUBSCRIBE_MS + SILENCE_RECONNECT_MS) {
                this.fail('still no advertisements after subscribing again');
                return;
            }
            this.armWatchdog(gen);
        }, 10_000);
    }
}
