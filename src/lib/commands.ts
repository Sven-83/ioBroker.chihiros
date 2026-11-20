/**
 * Commands (phase 3): writable states per device type and the frames they cause.
 * Only the commands listed here are ever sent (fixed allowlist with fixed limits).
 * Sources: own captures and write tests (Nov 2026).
 */
import type { DeviceType } from './devices';
import { CMD_5A, CMD_A5 } from './protocol';
import { PUMPS, type StateDef } from './states';

/** Mode byte: set the clock, params [year-2000, month, weekday 1=Mon..7=Sun, hour, minute, second] */
export const MODE_CLOCK = 0x09;
/** Mode byte: query, e.g. a5/04 [06] and [08] the app sends to the fan before a level */
export const MODE_QUERY = 0x04;
/** Mode byte: set one channel of the light, params [channel, value 0-255] */
export const MODE_CHANNEL = 0x07;

/** Mode byte (a5 family): manual dose 0x1b (= 27 decimal), params [pump index 0-3, 0, 0, 0, ml x 10]; write test 16.11.2026 (0.2 ml) */
export const MODE_DOSE = 0x1b;
/** Largest manual dose per command in ml (safety limit, Sven 17.11.2026) */
export const MAX_DOSE_ML = 5;

/** Mode byte (a5 family): pump channel on/off, params [pump index, 0, 1 = on / 0 = off] (capture 20.11.2026: on) */
export const MODE_PLAN_ACTIVE = 0x20;
/** Mode byte (a5 family): daily dose, params [pump index, weekdays, 1, 1, ml x 10 hi, lo] (same byte as the manual dose, 6 params) */
export const MODE_PLAN_DOSE = 0x1b;
/** Mode byte (a5 family): dosing time, params [pump index, 0, hour, minute, 0, 0] */
export const MODE_PLAN_TIME = 0x15;
/** Weekdays bit mask: Monday 0x40 ... Sunday 0x01, every day 0x7f (capture 20.11.2026: Mo-Fr = 0x7c) */
export const ALL_DAYS = 0x7f;
/** Largest daily dose in ml (safety limit) */
export const MAX_PLAN_ML = 30;

/** Mode byte: setting before a schedule write, CO2 controller sends [07 ff ff] like the app (16.11.2026) */
export const MODE_SETTING = 0x05;
/** Mode byte: CO2 schedule slot, params [hour, minute, action]; action 0x64 = open, 0x00 = close, 0x6f = empty */
export const MODE_CO2_SCHEDULE = 0x16;

/** Mode byte (a5 family): Doctor run setting after the mode, params [01 08] shrimp / [01 72] fish (capture 16.11.2026) */
export const MODE_DOCTOR_RUN = 0x01;
/** Doctor modes with their frames (capture 16.11.2026, hex) */
export const DOCTOR_MODES = {
    fish: { setting: 0x35, run: [0x01, 0x72] },
    shrimp: { setting: 0x36, run: [0x01, 0x08] },
} as const;

/** Highest fan level in the app (Sven 17.11.2026) */
export const MAX_FAN_LEVEL = 20;

/** Light channels in device order (0=red, 1=green, 2=blue, 3=white; confirmed by write test) */
export const LIGHT_CHANNELS = ['red', 'green', 'blue', 'white'] as const;
/** Name of a light channel */
export type LightChannel = (typeof LIGHT_CHANNELS)[number];

/** Result text: the device accepted the frames but does not report the new value */
export const RESULT_UNCONFIRMED = 'sent, not confirmed (the device does not report this value)';
/** Result text: the device did not even acknowledge the write (seen with the fan starting from standstill) */
export const RESULT_UNACKED = 'sent, but the device did not acknowledge it - not confirmed';

/** A frame before encoding: [cmd, mode, params] */
export type RawFrame = [number, number, number[]];

/** Command error (invalid value, not possible now) */
export class CommandError extends Error {}

/** What a write leads to */
export interface CommandPlan {
    /** Short description for lastCommand and the log */
    label: string;
    /** Frames to send after login and clock */
    frames: RawFrame[];
    /** State values (relative ID) to set with ack after the frames were sent */
    states: Record<string, ioBroker.StateValue>;
    /** Dosing pump: confirm the dose by the total counter of this pump (1-4) */
    confirm?: { pump: number; ml: number };
    /** Dosing pump: confirm a daily dose plan by reading the status image back */
    confirmPlan?: { pump: number; on: boolean; time: string };
}

/** States every writable device gets */
export const COMMON_COMMAND_STATES: StateDef[] = [
    {
        id: 'lastCommand',
        common: { name: 'Last command', type: 'string', role: 'text', read: true, write: false, def: '' },
    },
    {
        id: 'commandResult',
        common: {
            name: 'Result of the last command',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '',
        },
    },
];

const COLOR_ROLE: Record<LightChannel, string> = {
    red: 'level.color.red',
    green: 'level.color.green',
    blue: 'level.color.blue',
    white: 'level.color.white',
};

/**
 * Writable states of a device type (empty = no commands yet).
 *
 * @param type Device type
 */
export function writeStates(type: DeviceType): StateDef[] {
    switch (type) {
        case 'light':
            return [
                ...LIGHT_CHANNELS.map((ch): StateDef => ({
                    id: ch,
                    common: {
                        name: `${ch[0].toUpperCase()}${ch.slice(1)} (0-255, set by this adapter, not reported by the light)`,
                        type: 'number',
                        role: COLOR_ROLE[ch],
                        min: 0,
                        max: 255,
                        read: true,
                        write: true,
                        def: 0,
                    },
                })),
                {
                    id: 'on',
                    common: {
                        name: 'On (all channels to the set values) / off (all channels 0)',
                        type: 'boolean',
                        role: 'switch.light',
                        read: true,
                        write: true,
                        def: false,
                    },
                },
            ];
        case 'doser':
            return Array.from({ length: PUMPS }, (_, i): StateDef[] => [
                {
                    id: `pump${i + 1}.plan`,
                    common: {
                        name: `Pump ${i + 1}: daily dose plan as JSON {"on":true,"time":"14:00","ml":5,"days":127} (days: Mon 64 ... Sun 1; amount and days are not reported by the pump)`,
                        type: 'string',
                        role: 'json',
                        read: true,
                        write: true,
                        def: '',
                    },
                },
            ])
                .flat()
                .concat(
                    Array.from({ length: PUMPS }, (_, i) => ({
                        id: `pump${i + 1}.doseNow`,
                        common: {
                            name: `Pump ${i + 1}: dose now (ml, 0.1-${MAX_DOSE_ML})`,
                            type: 'number',
                            role: 'level',
                            unit: 'ml',
                            min: 0,
                            max: MAX_DOSE_ML,
                            step: 0.1,
                            read: true,
                            write: true,
                            def: 0,
                        },
                    })),
                );
        case 'co2':
            return [
                {
                    id: 'schedule',
                    common: {
                        name: 'CO2 time windows "HH:MM-HH:MM, ..." (empty or 00:00-23:59 = always); overwrites the schedule of the app',
                        type: 'string',
                        role: 'text',
                        read: true,
                        write: true,
                        def: '',
                    },
                },
                {
                    id: 'on',
                    common: {
                        name: 'CO2 on (schedule 00:00-23:59) / off (schedule empty); overwrites the schedule of the app',
                        type: 'boolean',
                        role: 'switch',
                        read: true,
                        write: true,
                        def: false,
                    },
                },
            ];
        case 'doctor':
            return [
                {
                    id: 'mode',
                    common: {
                        name: 'Mode (set by this adapter, not reported by the Doctor)',
                        type: 'string',
                        role: 'level.mode',
                        states: { fish: 'Fish', shrimp: 'Shrimp' },
                        read: true,
                        write: true,
                        def: '',
                    },
                },
            ];
        case 'fan':
            return [
                {
                    id: 'level',
                    common: {
                        name: `Level (0 = off, 1-${MAX_FAN_LEVEL}; set by this adapter, not reported by the fan)`,
                        type: 'number',
                        role: 'level',
                        min: 0,
                        max: MAX_FAN_LEVEL,
                        step: 1,
                        read: true,
                        write: true,
                        def: 0,
                    },
                },
            ];
        default:
            return [];
    }
}

/**
 * Clock frame parameters for a local time.
 *
 * @param now Local time
 */
export function clockParams(now: Date): number[] {
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    return [now.getFullYear() - 2000, now.getMonth() + 1, weekday, now.getHours(), now.getMinutes(), now.getSeconds()];
}

/**
 * Clock frame for a local time.
 *
 * @param now Local time
 */
export function clockFrame(now: Date): RawFrame {
    return [CMD_5A, MODE_CLOCK, clockParams(now)];
}

/**
 * Validates a channel value: integer 0-255.
 *
 * @param value Written value
 */
function channelValue(value: ioBroker.StateValue): number {
    const v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255) {
        throw new CommandError(`invalid value ${JSON.stringify(value)} (0-255)`);
    }
    return Math.round(v);
}

/**
 * Builds the frames for a write to a light state.
 *
 * @param id Relative state ID (red, green, blue, white, on)
 * @param value Written value
 * @param current Current channel values (as last set) and on state
 */
export function lightCommand(
    id: string,
    value: ioBroker.StateValue,
    current: Record<LightChannel, number> & { on: boolean },
): CommandPlan {
    const frame = (ch: number, v: number): RawFrame => [CMD_5A, MODE_CHANNEL, [ch, v]];
    const idx = (LIGHT_CHANNELS as readonly string[]).indexOf(id);
    if (idx >= 0) {
        const v = channelValue(value);
        const next = { ...current, [id]: v } as Record<LightChannel, number>;
        const anyOn = LIGHT_CHANNELS.some(ch => next[ch] > 0);
        // while the light is off, a colour switches it on with all set values
        const frames = current.on ? [frame(idx, v)] : LIGHT_CHANNELS.map((ch, i) => frame(i, next[ch]));
        return { label: `${id} ${v}`, frames, states: { [id]: v, on: anyOn } };
    }
    if (id === 'on') {
        const on = value === true || value === 1 || value === 'true';
        if (!on) {
            return { label: 'off', frames: LIGHT_CHANNELS.map((_, i) => frame(i, 0)), states: { on: false } };
        }
        if (!LIGHT_CHANNELS.some(ch => current[ch] > 0)) {
            throw new CommandError('all channels are 0 - set a colour first');
        }
        return {
            label: `on (${LIGHT_CHANNELS.map(ch => current[ch]).join('/')})`,
            frames: LIGHT_CHANNELS.map((ch, i) => frame(i, current[ch])),
            states: { on: true },
        };
    }
    throw new CommandError(`${id} is not writable`);
}

/**
 * Builds the frame for a manual dose of the dosing pump.
 *
 * @param id Relative state ID (pumpN.doseNow)
 * @param value Written value in ml
 */
export function doserCommand(id: string, value: ioBroker.StateValue): CommandPlan {
    const plan = /^pump([1-4])\.plan$/.exec(id);
    if (plan) {
        return planCommand(Number(plan[1]), id, value);
    }
    const m = /^pump([1-4])\.doseNow$/.exec(id);
    if (!m) {
        throw new CommandError(`${id} is not writable`);
    }
    const pump = Number(m[1]);
    const v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new CommandError(`invalid value ${JSON.stringify(value)} (0.1-${MAX_DOSE_ML} ml)`);
    }
    const tenths = Math.round(v * 10);
    if (tenths < 1 || tenths > MAX_DOSE_ML * 10) {
        throw new CommandError(`invalid amount ${v} ml (0.1-${MAX_DOSE_ML} ml)`);
    }
    const ml = tenths / 10;
    return {
        label: `pump ${pump}: dose ${ml} ml`,
        frames: [[CMD_A5, MODE_DOSE, [pump - 1, 0, 0, 0, tenths]]],
        states: { [id]: ml },
        confirm: { pump, ml },
    };
}

/**
 * Dosing must never run on two pumps at the same time (Sven 20.11.2026). A dose is assumed to take
 * DOSE_SECONDS_PER_ML per ml (conservative), plus a gap before the next pump may start.
 */
export const DOSE_SECONDS_PER_ML = 6;
/** Minutes between the end of one dose and the start of another */
export const DOSE_GAP_MIN = 1;

/** Daily dose of one pump for the overlap check */
export interface PlanSlot {
    /** Pump 1-4 */
    pump: number;
    /** Start in minutes after midnight */
    minute: number;
    /** Amount in ml */
    ml: number;
}

/**
 * Minutes a dose occupies incl. the gap after it (at least 1 + gap).
 *
 * @param ml Amount
 */
export function doseMinutes(ml: number): number {
    return Math.max(1, Math.ceil((ml * DOSE_SECONDS_PER_ML) / 60)) + DOSE_GAP_MIN;
}

/**
 * Finds a pump whose daily dose would run at the same time as the new one (also across midnight).
 *
 * @param slot New daily dose
 * @param others Active daily doses of the other pumps
 */
export function planConflict(slot: PlanSlot, others: PlanSlot[]): PlanSlot | null {
    const day = 1440;
    for (const o of others) {
        if (o.pump === slot.pump) {
            continue;
        }
        const a0 = slot.minute;
        const a1 = a0 + doseMinutes(slot.ml);
        for (const shift of [-day, 0, day]) {
            const b0 = o.minute + shift;
            const b1 = b0 + doseMinutes(o.ml);
            if (a0 < b1 && b0 < a1) {
                return o;
            }
        }
    }
    return null;
}

/**
 * Builds the frames for the daily dose plan of a pump (captures 20.11.2026): on = channel on, weekdays + amount,
 * time; off = channel off. The pump reports on/off and the time back, not the amount and the weekdays.
 * Unlike the app no top-up of the difference is dosed when the amount grows after today's dose.
 *
 * @param pump Pump 1-4
 * @param id Relative state ID (pumpN.plan)
 * @param value JSON {on, time "HH:MM", ml, days}
 */
export function planCommand(pump: number, id: string, value: ioBroker.StateValue): CommandPlan {
    let p: Record<string, unknown>;
    try {
        p = typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : {};
    } catch {
        throw new CommandError(`invalid plan ${JSON.stringify(value)} (JSON expected)`);
    }
    if (!p || typeof p !== 'object' || typeof p.on !== 'boolean') {
        throw new CommandError(`invalid plan ${JSON.stringify(value)} ("on" missing)`);
    }
    const ch = pump - 1;
    if (!p.on) {
        return {
            label: `pump ${pump}: daily dose off`,
            frames: [[CMD_A5, MODE_PLAN_ACTIVE, [ch, 0, 0]]],
            states: { [id]: JSON.stringify({ on: false }) },
            confirmPlan: { pump, on: false, time: '' },
        };
    }
    const t = typeof p.time === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(p.time) : null;
    const hour = t ? Number(t[1]) : NaN;
    const minute = t ? Number(t[2]) : NaN;
    if (!t || hour > 23 || minute > 59) {
        throw new CommandError(`invalid time ${JSON.stringify(p.time)} (HH:MM)`);
    }
    const ml = typeof p.ml === 'number' ? p.ml : NaN;
    const tenths = Math.round(ml * 10);
    if (!Number.isFinite(ml) || tenths < 1 || tenths > MAX_PLAN_ML * 10) {
        throw new CommandError(`invalid amount ${JSON.stringify(p.ml)} (0.1-${MAX_PLAN_ML} ml)`);
    }
    const days = p.days === undefined ? ALL_DAYS : Number(p.days);
    if (!Number.isInteger(days) || days < 1 || days > ALL_DAYS) {
        throw new CommandError(`invalid days ${JSON.stringify(p.days)} (1-127)`);
    }
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
        label: `pump ${pump}: daily ${tenths / 10} ml at ${time} (days ${days})`,
        frames: [
            [CMD_A5, MODE_PLAN_ACTIVE, [ch, 0, 1]],
            [CMD_A5, MODE_PLAN_DOSE, [ch, days, 1, 1, tenths >> 8, tenths & 0xff]],
            [CMD_A5, MODE_PLAN_TIME, [ch, 0, hour, minute, 0, 0]],
        ],
        states: { [id]: JSON.stringify({ on: true, time, ml: tenths / 10, days }) },
        confirmPlan: { pump, on: true, time },
    };
}

/**
 * Builds the frame for a fan level: 5a/07 [ff level] (write test 17.11.2026: [ff 05] = level 5, [ff 00] = off).
 *
 * @param id Relative state ID (level)
 * @param value Written level
 */
export function fanCommand(id: string, value: ioBroker.StateValue): CommandPlan {
    if (id !== 'level') {
        throw new CommandError(`${id} is not writable`);
    }
    const v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_FAN_LEVEL) {
        throw new CommandError(`invalid level ${JSON.stringify(value)} (0-${MAX_FAN_LEVEL})`);
    }
    return {
        label: v === 0 ? 'off' : `level ${v}`,
        // like the app: the two queries (settings, temperature history) before the level
        frames: [
            [CMD_A5, MODE_QUERY, [0x06]],
            [CMD_A5, MODE_QUERY, [0x08]],
            [CMD_5A, MODE_CHANNEL, [0xff, v]],
        ],
        states: { level: v },
    };
}

/**
 * Builds the frames to switch CO2 on or off through the schedule of the controller (write test 16.11.2026,
 * confirmed by the power of the controller): on = open at 00:00, close at 23:59; off = both slots empty.
 * The plug of the controller always stays on; it is never switched.
 *
 * @param id Relative state ID (on)
 * @param value Written value
 */
export function co2Command(id: string, value: ioBroker.StateValue): CommandPlan {
    if (id === 'schedule') {
        return co2ScheduleCommand(value);
    }
    if (id !== 'on') {
        throw new CommandError(`${id} is not writable`);
    }
    let on: boolean;
    if (value === true || value === 1 || value === 'true') {
        on = true;
    } else if (value === false || value === 0 || value === 'false') {
        on = false;
    } else {
        throw new CommandError(`invalid value ${JSON.stringify(value)} (true/false)`);
    }
    return {
        label: on ? 'CO2 on (schedule 00:00-23:59)' : 'CO2 off (schedule empty)',
        frames: [
            [CMD_5A, MODE_SETTING, [0x07, 0xff, 0xff]],
            [CMD_5A, MODE_CO2_SCHEDULE, on ? [0x00, 0x00, 0x64] : [0x00, 0x00, 0x6f]],
            [CMD_5A, MODE_CO2_SCHEDULE, on ? [0x17, 0x3b, 0x00] : [0x17, 0x3b, 0x6f]],
        ],
        states: on ? { on, schedule: '' } : { on },
    };
}

/** Most CO2 time windows (Sven 20.11.2026: up to 4; whether the controller keeps more than one: write test) */
export const MAX_CO2_WINDOWS = 4;

/**
 * Parses CO2 time windows "HH:MM-HH:MM, ..." into minutes; throws on invalid text or overlapping windows.
 *
 * @param text Windows
 */
export function parseCo2Windows(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const part of text
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)) {
        const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part);
        const a = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
        const e = m ? Number(m[3]) * 60 + Number(m[4]) : NaN;
        if (!m || Number(m[2]) > 59 || Number(m[4]) > 59 || !(a >= 0 && a < e && e <= 1439)) {
            throw new CommandError(
                `invalid window ${JSON.stringify(part)} (HH:MM-HH:MM, end after start, at most 23:59)`,
            );
        }
        out.push([a, e]);
    }
    out.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < out.length; i++) {
        if (out[i][0] <= out[i - 1][1]) {
            throw new CommandError('windows overlap');
        }
    }
    if (out.length > MAX_CO2_WINDOWS) {
        throw new CommandError(`at most ${MAX_CO2_WINDOWS} windows`);
    }
    return out;
}

/**
 * CO2 schedule with time windows: per window one slot "open" at the start and one "close" at the end
 * (5a/16 [hour, minute, 0x64 | 0x00], like the app for 00:00-23:59).
 *
 * @param value Windows text
 */
export function co2ScheduleCommand(value: ioBroker.StateValue): CommandPlan {
    const text = typeof value === 'string' ? value : '';
    const win = parseCo2Windows(text);
    const all = !win.length || (win.length === 1 && win[0][0] === 0 && win[0][1] === 1439);
    const list: Array<[number, number]> = all ? [[0, 1439]] : win;
    const hm = (m: number): [number, number] => [Math.floor(m / 60), m % 60];
    const fmt = (m: number): string =>
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const norm = all ? '' : list.map(([a, e]) => `${fmt(a)}-${fmt(e)}`).join(', ');
    return {
        label: `CO2 schedule ${all ? '00:00-23:59 (always)' : norm}`,
        frames: [
            [CMD_5A, MODE_SETTING, [0x07, 0xff, 0xff]],
            ...list.flatMap(([a, e]): RawFrame[] => [
                [CMD_5A, MODE_CO2_SCHEDULE, [...hm(a), 0x64]],
                [CMD_5A, MODE_CO2_SCHEDULE, [...hm(e), 0x00]],
            ]),
        ],
        states: { schedule: norm, on: true },
    };
}

/**
 * Whether the valve should be open now by the windows (empty = always).
 *
 * @param schedule Windows text
 * @param now Local time
 */
export function co2ShouldBeOpen(schedule: string, now: Date): boolean {
    const win = schedule ? parseCo2Windows(schedule) : [];
    const m = now.getHours() * 60 + now.getMinutes();
    return !win.length || win.some(([a, e]) => m >= a && m < e);
}

/**
 * Builds the frames for the Doctor mode (capture 16.11.2026): 5a/05 [35|36 ff ff], then a5/01 [01 72|08].
 *
 * @param id Relative state ID (mode)
 * @param value Written mode: fish or shrimp
 */
export function doctorCommand(id: string, value: ioBroker.StateValue): CommandPlan {
    if (id !== 'mode') {
        throw new CommandError(`${id} is not writable`);
    }
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (mode !== 'fish' && mode !== 'shrimp') {
        throw new CommandError(`invalid mode ${JSON.stringify(value)} (fish/shrimp)`);
    }
    const m = DOCTOR_MODES[mode];
    return {
        label: `mode ${mode}`,
        frames: [
            [CMD_5A, MODE_SETTING, [m.setting, 0xff, 0xff]],
            [CMD_A5, MODE_DOCTOR_RUN, [...m.run]],
        ],
        states: { mode },
    };
}
