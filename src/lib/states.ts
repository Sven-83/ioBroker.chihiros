/**
 * State definitions per device type (read values, phase 2) and the mapping of read results to states.
 */
import type { DeviceType } from './devices';
import { formatMinute, scheduleLevel, scheduleWindowList, scheduleWindows } from './protocol';
import { clockDeviation, type ReadResult } from './reader';

/** One state below devices.<id> */
export interface StateDef {
    /** Relative ID, e.g. "waterTemp" or "pump1.total" */
    id: string;
    /** Object common part */
    common: ioBroker.StateCommon;
}

const num = (name: string, role: string, unit?: string): ioBroker.StateCommon => ({
    name,
    type: 'number',
    role,
    read: true,
    write: false,
    ...(unit ? { unit } : {}),
});
const str = (name: string, role: string): ioBroker.StateCommon => ({
    name,
    type: 'string',
    role,
    read: true,
    write: false,
    def: '',
});

/** Number of pump channels of the dosing pump */
export const PUMPS = 4;

/** States every device gets for reading */
export const COMMON_READ_STATES: StateDef[] = [
    { id: 'lastRead', common: { ...num('Last successful read', 'date'), def: 0 } },
    { id: 'readError', common: str('Error of the last read (empty = ok)', 'text') },
];

/**
 * Read states of a device type.
 *
 * @param type Device type
 */
export function readStates(type: DeviceType): StateDef[] {
    switch (type) {
        case 'doser': {
            const out: StateDef[] = [];
            for (let p = 1; p <= PUMPS; p++) {
                out.push({ id: `pump${p}.total`, common: num(`Pump ${p}: dosed in total`, 'value', 'ml') });
                out.push({ id: `pump${p}.today`, common: num(`Pump ${p}: dosed today (scheduled)`, 'value', 'ml') });
            }
            return out;
        }
        case 'light':
            return [
                { id: 'clock', common: str('Device clock', 'text') },
                { id: 'clockDeviation', common: num('Device clock minus local time', 'value', 'min') },
                { id: 'schedule', common: str('Scheduled on times incl. sunrise and sunset', 'text') },
                { id: 'sunrise', common: num('Sunrise duration (first window)', 'value', 'min') },
                { id: 'sunset', common: num('Sunset duration (first window)', 'value', 'min') },
                { id: 'schedulePoints', common: str('Schedule points (JSON)', 'json') },
                {
                    id: 'scheduledLevel',
                    common: num('Red by schedule now (0-255; green, blue, white are not reported)', 'value'),
                },
            ];
        case 'doctor':
            return [{ id: 'waterTemp', common: num('Water temperature', 'value.temperature', '°C') }];
        case 'fan':
            return [
                { id: 'waterTemp', common: num('Water temperature', 'value.temperature', '°C') },
                { id: 'roomTemp', common: num('Room temperature', 'value.temperature', '°C') },
                { id: 'humidity', common: num('Humidity (not confirmed by the app)', 'value.humidity', '%') },
            ];
        default:
            return [];
    }
}

/**
 * Channels needed for the read states
 *
 * @param type Device type
 */
export function readChannels(type: DeviceType): Array<{ id: string; name: string }> {
    if (type !== 'doser') {
        return [];
    }
    return Array.from({ length: PUMPS }, (_, i) => ({ id: `pump${i + 1}`, name: `Pump ${i + 1}` }));
}

/**
 * Converts a read result into state values (relative ID → value). Missing parts are left out.
 *
 * @param result Read result
 * @param now Local time of the read
 */
export function resultToStates(result: ReadResult, now: Date): Record<string, ioBroker.StateValue> {
    const out: Record<string, ioBroker.StateValue> = {};
    if (result.doserTotal) {
        result.doserTotal.forEach((v, i) => (out[`pump${i + 1}.total`] = v));
    }
    if (result.doserToday) {
        result.doserToday.forEach((v, i) => (out[`pump${i + 1}.today`] = v));
    }
    if (result.live) {
        for (const k of ['waterTemp', 'roomTemp', 'humidity'] as const) {
            const v = result.live[k];
            if (v !== undefined) {
                out[k] = v;
            }
        }
    }
    if (result.light) {
        const { clockMinute, points } = result.light;
        out.clock = formatMinute(clockMinute);
        out.clockDeviation = clockDeviation(clockMinute, now);
        out.schedule = scheduleWindows(points);
        const first = scheduleWindowList(points)[0];
        if (first) {
            out.sunrise = first.sunrise;
            out.sunset = first.sunset;
        }
        out.schedulePoints = JSON.stringify(points.map(p => ({ time: formatMinute(p.minute), level: p.level })));
        out.scheduledLevel = scheduleLevel(points, now.getHours() * 60 + now.getMinutes());
    }
    return out;
}
