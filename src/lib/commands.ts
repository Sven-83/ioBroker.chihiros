/**
 * Commands (phase 3): writable states per device type and the frames they cause.
 * Only the commands listed here are ever sent (fixed allowlist with fixed limits).
 * Sources: own captures and write tests (Nov 2026).
 */
import type { DeviceType } from './devices';
import { CMD_5A } from './protocol';
import type { StateDef } from './states';

/** Mode byte: set the clock, params [year-2000, month, weekday 1=Mon..7=Sun, hour, minute, second] */
export const MODE_CLOCK = 0x09;
/** Mode byte: set one channel of the light, params [channel, value 0-255] */
export const MODE_CHANNEL = 0x07;

/** Light channels in device order (0=red, 1=green, 2=blue, 3=white; confirmed by write test) */
export const LIGHT_CHANNELS = ['red', 'green', 'blue', 'white'] as const;
/** Name of a light channel */
export type LightChannel = (typeof LIGHT_CHANNELS)[number];

/** Result text: the device accepted the frames but does not report the new value */
export const RESULT_UNCONFIRMED = 'sent, not confirmed (the device does not report this value)';

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
