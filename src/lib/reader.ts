/**
 * What to ask each device type and how to turn the answers into values (read only, phase 2).
 */
import type { DeviceType } from './devices';
import {
    type Answer,
    decodeDoctorLive,
    decodeDoserMl,
    decodeDoserPlan,
    type DoserPlan,
    decodeFanLive,
    decodeLightImage,
    encodeFrame,
    type LightImage,
    type LiveValues,
    type MessageIds,
    MSG,
    QUERY,
} from './protocol';

/** Values read from one device */
export interface ReadResult {
    /** Water/room temperature and humidity (Doctor, fan) */
    live?: LiveValues;
    /** Dosed ml per pump in total */
    doserTotal?: number[];
    /** Dosed ml per pump today */
    doserToday?: number[];
    /** Daily dose per pump as stored in the pump */
    doserPlan?: DoserPlan[];
    /** Clock and schedule of the light */
    light?: LightImage;
}

/** Query plan of a device type */
export interface ReadPlan {
    /** Frames to send */
    frames: Uint8Array[];
    /** True when all needed answers arrived */
    isDone: (answers: Answer[]) => boolean;
}

const has = (answers: Answer[], type: number): boolean => answers.some(a => a.type === type);

/**
 * Builds the query frames and completion check for a device type.
 *
 * @param type Device type
 * @param ids Message ID generator of this adapter instance
 */
export function readPlan(type: DeviceType, ids: MessageIds): ReadPlan {
    const frame = (q: readonly [number, number, readonly number[]]): Uint8Array =>
        encodeFrame(q[0], q[1], q[2], ids.next());
    switch (type) {
        case 'doser':
            return {
                frames: [frame(QUERY.status), frame(QUERY.doserTotal), frame(QUERY.doserToday)],
                isDone: a => has(a, MSG.doserTotal) && has(a, MSG.doserToday) && has(a, MSG.image),
            };
        case 'light':
            return { frames: [frame(QUERY.status)], isDone: a => has(a, MSG.image) };
        case 'doctor':
        case 'fan':
            return { frames: [frame(QUERY.status)], isDone: a => has(a, MSG.live) };
        case 'co2':
        default:
            return { frames: [frame(QUERY.status)], isDone: a => has(a, MSG.info) };
    }
}

/**
 * Extracts the values of a device type from the answers (the newest answer of a type wins).
 *
 * @param type Device type
 * @param answers Answers of one session
 */
export function interpret(type: DeviceType, answers: Answer[]): ReadResult {
    const last = (t: number): Answer | undefined => [...answers].reverse().find(a => a.type === t);
    const out: ReadResult = {};
    switch (type) {
        case 'doser': {
            const total = last(MSG.doserTotal);
            const today = last(MSG.doserToday);
            out.doserTotal = (total && decodeDoserMl(total)) ?? undefined;
            out.doserToday = (today && decodeDoserMl(today)) ?? undefined;
            const img = last(MSG.image);
            const plan = img && decodeDoserPlan(img);
            if (plan) {
                out.doserPlan = plan;
            }
            break;
        }
        case 'light': {
            const img = last(MSG.image);
            out.light = (img && decodeLightImage(img)) ?? undefined;
            break;
        }
        case 'doctor': {
            const live = last(MSG.live);
            out.live = (live && decodeDoctorLive(live)) ?? undefined;
            break;
        }
        case 'fan': {
            const live = last(MSG.live);
            out.live = (live && decodeFanLive(live)) ?? undefined;
            break;
        }
        default:
            break;
    }
    return out;
}

/**
 * Difference between device clock and local time in minutes (-720..720), e.g. after a power cut.
 *
 * @param clockMinute Device clock in minutes after midnight
 * @param now Local time
 */
export function clockDeviation(clockMinute: number, now: Date): number {
    let d = clockMinute - (now.getHours() * 60 + now.getMinutes());
    if (d > 720) {
        d -= 1440;
    } else if (d < -720) {
        d += 1440;
    }
    return d;
}
