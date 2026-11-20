/**
 * Chihiros BLE protocol (Nordic UART): frame encoding and decoding of the read-only answers.
 * Frame layout: [cmd, 0x01, len, msgHi, msgLo, mode, ...params, checksum], checksum = XOR of bytes 1..n-2.
 * Answers start with 0x5b; byte 5 is the message type, the payload follows. Some device families end
 * their answers with 0x22 instead of a checksum, so answers are decoded by type and length only.
 * Sources: chihiros-led-control docs/protocol.md (MIT) and own captures (Nov 2026).
 */

/** Command byte of the "5a" family (status, time, settings) */
export const CMD_5A = 0x5a;
/** Command byte of the "a5" family (queries of dosing pump and Doctor) */
export const CMD_A5 = 0xa5;

/** Read-only queries; nothing here changes a device */
export const QUERY = {
    /** Status / login, every device answers with a 0x0a frame */
    status: [CMD_5A, 0x04, [0x01]] as const,
    /** Dosing pump: total dosed ml per pump (answer 0x1e) */
    doserTotal: [CMD_A5, 0x04, [0x04]] as const,
    /** Dosing pump: dosed ml today per pump (answer 0x22) */
    doserToday: [CMD_A5, 0x04, [0x05]] as const,
};

/** Message types of the answers */
export const MSG = {
    info: 0x0a,
    image: 0xfe,
    doserTotal: 0x1e,
    doserToday: 0x22,
    live: 0x25,
} as const;

/** Creates message IDs like the app: 16 bit, the low byte never becomes 0x5a */
export class MessageIds {
    private hi = 0;
    private lo = 0;

    /** Next ID as [hi, lo] */
    public next(): [number, number] {
        if (this.lo === 0xff) {
            this.hi = (this.hi + 1) & 0xff;
            this.lo = 0;
        } else {
            this.lo++;
        }
        if (this.lo === 0x5a) {
            this.lo++;
        }
        return [this.hi, this.lo];
    }
}

/**
 * Encodes a command frame.
 *
 * @param cmd Command byte (0x5a or 0xa5)
 * @param mode Mode byte
 * @param params Parameter bytes
 * @param id Message ID [hi, lo]
 */
export function encodeFrame(cmd: number, mode: number, params: readonly number[], id: [number, number]): Uint8Array {
    const f = [cmd, 0x01, params.length + 5, id[0], id[1], mode, ...params];
    let cs = f[1];
    for (let i = 2; i < f.length; i++) {
        cs ^= f[i];
    }
    return Uint8Array.from([...f, cs & 0xff]);
}

/** A decoded answer */
export interface Answer {
    /** Message type (byte 5) */
    type: number;
    /** Bytes after the type (including a trailing checksum/terminator) */
    payload: number[];
}

/**
 * Splits an answer frame.
 *
 * @param data Notification bytes
 * @returns the answer or null when it is no 0x5b answer
 */
export function decodeAnswer(data: Uint8Array | number[]): Answer | null {
    const b = Array.from(data);
    if (b.length < 7 || b[0] !== 0x5b) {
        return null;
    }
    return { type: b[5], payload: b.slice(6) };
}

const u16 = (p: number[], i: number): number => ((p[i] << 8) | p[i + 1]) >>> 0;

/** Live values of fan and Doctor (message 0x25) */
export interface LiveValues {
    /** Water temperature in °C */
    waterTemp?: number;
    /** Room temperature in °C (fan only) */
    roomTemp?: number;
    /** Relative humidity in % (fan only, not confirmed by the app) */
    humidity?: number;
}

/**
 * Decodes the live message 0x25 of the fan: humidity 0.01 %, room 0.01 °C, water 0.1 °C.
 *
 * @param a Answer of type 0x25
 */
export function decodeFanLive(a: Answer): LiveValues | null {
    if (a.type !== MSG.live || a.payload.length < 6) {
        return null;
    }
    const humidity = u16(a.payload, 0) / 100;
    const roomTemp = u16(a.payload, 2) / 100;
    const waterTemp = u16(a.payload, 4) / 10;
    // a switched-off fan reports zeros for its own sensor
    const out: LiveValues = { waterTemp };
    if (humidity > 0 || roomTemp > 0) {
        out.humidity = humidity;
        out.roomTemp = roomTemp;
    }
    return out;
}

/**
 * Decodes the live message 0x25 of the Doctor: water temperature in 0.1 °C at payload bytes 4-5.
 *
 * @param a Answer of type 0x25
 */
export function decodeDoctorLive(a: Answer): LiveValues | null {
    if (a.type !== MSG.live || a.payload.length < 6) {
        return null;
    }
    return { waterTemp: u16(a.payload, 4) / 10 };
}

/**
 * Decodes dosed ml per pump (messages 0x1e total and 0x22 today): 4 x uint16 in 0.1 ml.
 *
 * @param a Answer of type 0x1e or 0x22
 */
export function decodeDoserMl(a: Answer): number[] | null {
    if ((a.type !== MSG.doserTotal && a.type !== MSG.doserToday) || a.payload.length < 8) {
        return null;
    }
    return [0, 2, 4, 6].map(i => u16(a.payload, i) / 10);
}

/** Daily dose of one pump as stored in the dosing pump (status image 0xfe, capture 20.11.2026) */
export interface DoserPlan {
    /** A daily dose is programmed (block flag 0x00; 0x04 = channel unused) */
    on: boolean;
    /** Dosing time in minutes after midnight */
    minute: number;
    /** Daily amount in ml */
    ml: number;
}

/**
 * Decodes the daily dose per pump from the status image 0xfe of the dosing pump: clock at payload bytes 1-2,
 * then one 9-byte block per pump from byte 3: [flag, hour, minute, 4 unknown bytes, ml x 10 (uint16)].
 * The weekdays of a plan are not part of the image (capture 20.11.2026).
 *
 * @param a Answer of type 0xfe from the dosing pump
 */
export function decodeDoserPlan(a: Answer): DoserPlan[] | null {
    const p = a.payload;
    if (a.type !== MSG.image || p.length < 3 + 9 * 4 || p[1] > 23 || p[2] > 59) {
        return null;
    }
    const out: DoserPlan[] = [];
    for (let i = 0; i < 4; i++) {
        const b = 3 + 9 * i;
        const h = p[b + 1];
        const m = p[b + 2];
        if (h > 23 || m > 59) {
            return null;
        }
        out.push({ on: p[b] === 0, minute: h * 60 + m, ml: u16(p, b + 7) / 10 });
    }
    return out;
}

/** One point of the light schedule */
export interface SchedulePoint {
    /** Minutes after midnight */
    minute: number;
    /** Brightness level at that time (0 = off) */
    level: number;
}

/** Status image of the light (message 0xfe) */
export interface LightImage {
    /** Device clock in minutes after midnight */
    clockMinute: number;
    /** Schedule points (ramps between them) */
    points: SchedulePoint[];
}

/**
 * Decodes the status image 0xfe of the WRGB light: clock at payload bytes 1-2, schedule points
 * (hour, minute, level) from payload byte 19 on until a 0 terminator.
 *
 * @param a Answer of type 0xfe
 */
export function decodeLightImage(a: Answer): LightImage | null {
    const p = a.payload;
    if (a.type !== MSG.image || p.length < 20 || p[1] > 23 || p[2] > 59) {
        return null;
    }
    const points: SchedulePoint[] = [];
    for (let i = 19; i + 2 < p.length; i += 3) {
        const h = p[i];
        const m = p[i + 1];
        if (h > 23 || m > 59) {
            break;
        }
        if (h === 0 && m === 0 && p[i + 2] === 0 && points.length > 0) {
            break;
        }
        points.push({ minute: h * 60 + m, level: p[i + 2] });
    }
    return { clockMinute: p[1] * 60 + p[2], points };
}

/**
 * Formats minutes after midnight as HH:MM.
 *
 * @param minute Minutes after midnight
 */
export function formatMinute(minute: number): string {
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * Level of the schedule at a time (linear ramps between points, before the first point = off).
 *
 * @param points Schedule points, sorted by time
 * @param minute Minutes after midnight
 */
export function scheduleLevel(points: SchedulePoint[], minute: number): number {
    if (points.length === 0 || minute < points[0].minute) {
        return 0;
    }
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (minute >= a.minute && minute < b.minute) {
            return Math.round(a.level + ((b.level - a.level) * (minute - a.minute)) / (b.minute - a.minute));
        }
    }
    return points[points.length - 1].level;
}

/** One on window of the schedule, as the app shows it (including sunrise and sunset) */
export interface ScheduleWindow {
    /** Start of the sunrise, minutes after midnight */
    start: number;
    /** End of the sunset, minutes after midnight */
    end: number;
    /** Sunrise duration in minutes */
    sunrise: number;
    /** Sunset duration in minutes */
    sunset: number;
}

/**
 * On windows of the schedule. A window runs from the off point before the first on point (start of the sunrise)
 * to the off point after the last on point (end of the sunset).
 *
 * @param points Schedule points, sorted by time
 */
export function scheduleWindowList(points: SchedulePoint[]): ScheduleWindow[] {
    const out: ScheduleWindow[] = [];
    let i = 0;
    while (i < points.length) {
        if (points[i].level === 0) {
            i++;
            continue;
        }
        const onStart = points[i].minute;
        const start = i > 0 ? points[i - 1].minute : onStart;
        let j = i;
        while (j + 1 < points.length && points[j + 1].level > 0) {
            j++;
        }
        const onEnd = points[j].minute;
        const end = j + 1 < points.length ? points[j + 1].minute : onEnd;
        out.push({ start, end, sunrise: onStart - start, sunset: end - onEnd });
        i = j + 1;
    }
    return out;
}

/**
 * Time windows in which the light is on as the app shows them, e.g. "11:00-12:00, 14:00-20:00".
 *
 * @param points Schedule points, sorted by time
 */
export function scheduleWindows(points: SchedulePoint[]): string {
    return scheduleWindowList(points)
        .map(w => `${formatMinute(w.start)}-${formatMinute(w.end)}`)
        .join(', ');
}
