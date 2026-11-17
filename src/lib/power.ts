/**
 * Optional power measurement per device (e.g. a Shelly plug): only read, never switched.
 * Fan: running when it draws power (measured 17.11.2026: off 0 W, level 1-7 about 1.4 W, level 20 2.6 W).
 * CO2 controller: the valve is open when the controller draws power (measured 16.11.2026: open 2.9 W, closed 0 W).
 */
import type { DeviceType } from './devices';
import type { StateDef } from './states';

/** Power from which a device counts as running / valve open, in W */
export const POWER_ON_W: Partial<Record<DeviceType, number>> = { fan: 0.5, co2: 1 };

/** Power up to which a device counts as off, in W */
export const POWER_OFF_W = 0.2;

/**
 * Fan: levels tried one after the other (each in its own connection, power checked in between) when the fan
 * does not start. A fan standing still sometimes starts only after several level changes (17.11.2026: app
 * 11, 4, 7, 11; adapter level 20 from standstill started at once).
 */
export const FAN_KICK_LEVELS = [20, 11, 4, 20, 11] as const;

/**
 * State that shows the measured on state (only when a power state is configured).
 *
 * @param type Device type
 */
export function powerIndicator(type: DeviceType): StateDef | null {
    switch (type) {
        case 'fan':
            return {
                id: 'running',
                common: {
                    name: 'Running (from the power measurement)',
                    type: 'boolean',
                    role: 'indicator.working',
                    read: true,
                    write: false,
                },
            };
        case 'co2':
            return {
                id: 'valveOpen',
                common: {
                    name: 'Valve open (from the power measurement)',
                    type: 'boolean',
                    role: 'indicator.working',
                    read: true,
                    write: false,
                },
            };
        default:
            return null;
    }
}

/**
 * On state from a power value; null when the type has no threshold or the value is not a number.
 *
 * @param type Device type
 * @param watts Measured power
 */
export function isOn(type: DeviceType, watts: unknown): boolean | null {
    const limit = POWER_ON_W[type];
    if (limit === undefined || typeof watts !== 'number' || !Number.isFinite(watts)) {
        return null;
    }
    return watts >= limit;
}

/**
 * Checks a power state ID from the configuration: a plain foreign object ID, no wildcards.
 *
 * @param raw Configured value
 */
export function parsePowerState(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const id = raw.trim();
    return /^[A-Za-z0-9_\-#]+(\.[A-Za-z0-9_\-#]+)+$/.test(id) ? id : null;
}
