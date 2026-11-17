/**
 * One short GATT session with a Chihiros device through the ESPHome proxy:
 * connect, enable notifications on the Nordic UART, send query frames, collect answers, disconnect.
 * Chihiros devices accept only one connection, so a refused connection usually means "held by app/hub".
 */
import { type Answer, decodeAnswer } from './protocol';
import type { Scheduler } from './proxy';

/** GATT part of the ESPHome API connection */
export interface GattApi {
    /** Opens a GATT connection */
    connectBluetoothDeviceService(
        address: number,
        addressType?: number,
        useCache?: boolean,
    ): Promise<{ connected: boolean; mtu?: number; error?: number }>;
    /** Closes a GATT connection */
    disconnectBluetoothDeviceService(address: number): Promise<unknown>;
    /** Lists services */
    listBluetoothGATTServicesService(address: number): Promise<{ servicesList: GattService[] }>;
    /** Enables notifications */
    notifyBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
    /** Writes a descriptor */
    writeBluetoothGATTDescriptorService(address: number, handle: number, value: Uint8Array): Promise<unknown>;
    /** Writes a characteristic */
    writeBluetoothGATTCharacteristicService(
        address: number,
        handle: number,
        value: Uint8Array,
        response?: boolean,
    ): Promise<unknown>;
    /** Adds an event listener */
    on(event: string, listener: (...args: any[]) => void): unknown;
    /** Removes an event listener */
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** UUID fields as delivered by the library */
interface UuidFields {
    /** UUID string */
    uuid?: unknown;
    /** UUID as two 64-bit numbers */
    uuidList?: unknown;
    /** 16-bit UUID */
    shortUuid?: number;
}

/** GATT service as delivered by the library */
export interface GattService extends UuidFields {
    /** Characteristics */
    characteristicsList: Array<
        UuidFields & { handle: number; descriptorsList?: Array<UuidFields & { handle: number }> }
    >;
}

/** Session failed; `busy` = device refused or did not answer the connection (app/hub?) */
export class SessionError extends Error {
    /**
     * @param message Reason
     * @param busy True when the device was probably held by another connection
     */
    public constructor(
        message: string,
        public readonly busy: boolean,
    ) {
        super(message);
    }
}

const NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const CCCD = 0x2902;

/**
 * Converts the UUID encodings of the library to a lower-case UUID string.
 *
 * @param o Service, characteristic or descriptor
 */
export function uuidString(o: UuidFields): string {
    if (typeof o.uuid === 'string' && o.uuid.length > 8) {
        return o.uuid.toLowerCase();
    }
    const list = Array.isArray(o.uuidList) ? o.uuidList : Array.isArray(o.uuid) ? o.uuid : null;
    if (list && list.length === 2) {
        try {
            const h =
                BigInt.asUintN(64, BigInt(String(list[0])))
                    .toString(16)
                    .padStart(16, '0') +
                BigInt.asUintN(64, BigInt(String(list[1])))
                    .toString(16)
                    .padStart(16, '0');
            return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        } catch {
            return '';
        }
    }
    if (typeof o.shortUuid === 'number' && o.shortUuid > 0) {
        return `0000${o.shortUuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
    }
    return '';
}

/**
 * Finds write/notify handles of the Nordic UART service.
 *
 * @param services Service list of the device
 */
export function findUart(services: GattService[]): { write: number; notify: number; cccd: number | null } | null {
    for (const s of services) {
        const w = s.characteristicsList.find(c => uuidString(c) === NUS_WRITE);
        const n = s.characteristicsList.find(c => uuidString(c) === NUS_NOTIFY);
        if (w && n) {
            const d = (n.descriptorsList ?? []).find(x => uuidString(x).startsWith(`0000${CCCD.toString(16)}`));
            return { write: w.handle, notify: n.handle, cccd: d ? d.handle : null };
        }
    }
    return null;
}

/** Options of {@link runSession} */
export interface SessionOptions {
    /** 48-bit device address */
    address: number;
    /** Address type from the advertisement */
    addressType: number;
    /** Frames to send in this order */
    frames: Uint8Array[];
    /** True when all needed answers arrived */
    isDone: (answers: Answer[]) => boolean;
    /** Maximum duration after connecting in ms */
    timeoutMs: number;
    /** Pause between frames in ms */
    gapMs: number;
    /** Connection attempts */
    attempts: number;
    /**
     * Index of the first frame whose missing write acknowledgement is tolerated (command frames: e.g. the fan
     * starting from standstill runs the command but does not acknowledge the write). Default: none.
     */
    tolerateFrom?: number;
    /** Called for each tolerated frame without write acknowledgement */
    onUnacked?: (index: number) => void;
}

/**
 * Runs one session and always disconnects afterwards.
 *
 * @param api GATT API of the proxy connection
 * @param opt Session options
 * @param scheduler Adapter timers
 * @returns all answers received
 */
export async function runSession(api: GattApi, opt: SessionOptions, scheduler: Scheduler): Promise<Answer[]> {
    const sleep = (ms: number): Promise<void> => new Promise(r => scheduler.setTimeout(r, ms));
    const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const t = scheduler.setTimeout(() => reject(new SessionError(`${what} timed out`, false)), ms);
            p.then(
                v => {
                    scheduler.clearTimeout(t);
                    resolve(v);
                },
                (e: unknown) => {
                    scheduler.clearTimeout(t);
                    reject(e instanceof Error ? e : new Error(String(e)));
                },
            );
        });

    let connected = false;
    let lastError = '';
    for (let i = 1; i <= opt.attempts && !connected; i++) {
        try {
            const res = await withTimeout(
                api.connectBluetoothDeviceService(opt.address, opt.addressType, false),
                15_000,
                'connect',
            );
            connected = !!res?.connected;
            if (!connected) {
                lastError = `error ${res?.error ?? '?'}`;
            }
        } catch (e) {
            lastError = (e as Error).message;
        }
        if (!connected && i < opt.attempts) {
            await sleep(1_000);
        }
    }
    if (!connected) {
        throw new SessionError(`no connection (${lastError})`, true);
    }

    const answers: Answer[] = [];
    let notifyHandle = -1;
    let wake: (() => void) | null = null;
    const listener = (m: { address?: number; handle?: number; data?: unknown }): void => {
        if (Number(m?.address) !== opt.address || m?.handle !== notifyHandle) {
            return;
        }
        const raw = m.data;
        const bytes =
            typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from((raw as ArrayLike<number>) ?? []);
        const a = decodeAnswer(bytes);
        if (a) {
            answers.push(a);
            wake?.();
        }
    };
    api.on('message.BluetoothGATTNotifyDataResponse', listener);
    try {
        const { servicesList } = await withTimeout(
            api.listBluetoothGATTServicesService(opt.address),
            15_000,
            'service list',
        );
        const uart = findUart(servicesList ?? []);
        if (!uart) {
            throw new SessionError('Nordic UART service not found', false);
        }
        notifyHandle = uart.notify;
        await withTimeout(api.notifyBluetoothGATTCharacteristicService(opt.address, uart.notify), 5_000, 'notify');
        if (uart.cccd !== null) {
            await withTimeout(
                api.writeBluetoothGATTDescriptorService(opt.address, uart.cccd, new Uint8Array([1, 0])),
                5_000,
                'descriptor',
            );
        }
        const deadline = scheduler.now() + opt.timeoutMs;
        for (let i = 0; i < opt.frames.length; i++) {
            try {
                await withTimeout(
                    api.writeBluetoothGATTCharacteristicService(opt.address, uart.write, opt.frames[i], true),
                    6_000,
                    'write',
                );
            } catch (e) {
                if (opt.tolerateFrom === undefined || i < opt.tolerateFrom) {
                    throw e;
                }
                opt.onUnacked?.(i);
            }
            await sleep(opt.gapMs);
        }
        while (!opt.isDone(answers) && scheduler.now() < deadline) {
            await new Promise<void>(r => {
                const t = scheduler.setTimeout(r, Math.min(500, Math.max(1, deadline - scheduler.now())));
                wake = (): void => {
                    scheduler.clearTimeout(t);
                    r();
                };
            });
            wake = null;
        }
        if (!opt.isDone(answers)) {
            throw new SessionError(`incomplete answer (${answers.length} frames)`, false);
        }
        return answers;
    } finally {
        api.removeListener('message.BluetoothGATTNotifyDataResponse', listener);
        try {
            await withTimeout(api.disconnectBluetoothDeviceService(opt.address), 5_000, 'disconnect');
        } catch {
            // the proxy drops the connection anyway
        }
    }
}
