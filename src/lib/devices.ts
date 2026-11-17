/**
 * Device list from the instance configuration: validation, object IDs, presence.
 * Pure functions only, so everything here is unit tested.
 */

/** Supported Chihiros device types */
export const DEVICE_TYPES = ['light', 'doser', 'co2', 'doctor', 'fan'] as const;

/** One supported device type */
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** A validated device from the configuration */
export interface Device {
    /** Object ID below the instance (unique) */
    id: string;
    /** Display name */
    name: string;
    /** Device type */
    type: DeviceType;
    /** MAC in the form XX:XX:XX:XX:XX:XX */
    mac: string;
    /** MAC as number (ESPHome API format) */
    macNum: number;
    /** Only in use part of the year: no warning when missing */
    seasonal: boolean;
}

/** Result of {@link parseDevices} */
export interface ParseResult {
    /** Valid devices */
    devices: Device[];
    /** One message per rejected row (English, for the log) */
    errors: string[];
}

/**
 * Normalizes a MAC address to XX:XX:XX:XX:XX:XX.
 *
 * @param input MAC with ':' or '-' separators or without separators
 * @returns the normalized MAC or null when invalid
 */
export function normalizeMac(input: unknown): string | null {
    if (typeof input !== 'string') {
        return null;
    }
    const hex = input.trim().replace(/[:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(hex)) {
        return null;
    }
    return hex.match(/../g)!.join(':');
}

/**
 * Converts a normalized MAC to the number used by the ESPHome API.
 *
 * @param mac MAC in the form XX:XX:XX:XX:XX:XX
 */
export function macToNumber(mac: string): number {
    return parseInt(mac.replace(/:/g, ''), 16);
}

/**
 * Converts an ESPHome API address to a MAC string.
 *
 * @param n 48-bit address
 */
export function numberToMac(n: number): string {
    return n.toString(16).toUpperCase().padStart(12, '0').match(/../g)!.join(':');
}

/**
 * Builds a safe object ID from a display name (umlauts transliterated, only a-z 0-9 _).
 *
 * @param name Display name
 * @param fallback ID used when the name gives nothing usable
 */
export function toObjectId(name: string, fallback: string): string {
    const id = name
        .trim()
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return id || fallback;
}

/**
 * Validates the device table of the configuration.
 *
 * @param raw native.devices (anything, the admin may store odd values)
 */
export function parseDevices(raw: unknown): ParseResult {
    const devices: Device[] = [];
    const errors: string[] = [];
    if (!Array.isArray(raw)) {
        return { devices, errors };
    }
    const macs = new Set<string>();
    const ids = new Set<string>();
    raw.forEach((row: unknown, index) => {
        const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
        const line = `device row ${index + 1}`;
        const mac = normalizeMac(r.mac);
        if (!mac) {
            errors.push(`${line}: invalid MAC address "${typeof r.mac === 'string' ? r.mac : ''}"`);
            return;
        }
        const type = typeof r.type === 'string' ? (r.type as DeviceType) : undefined;
        if (!type || !DEVICE_TYPES.includes(type)) {
            errors.push(`${line}: unknown device type "${typeof r.type === 'string' ? r.type : ''}"`);
            return;
        }
        if (macs.has(mac)) {
            errors.push(`${line}: MAC ${mac} is configured twice`);
            return;
        }
        const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : type;
        let id = toObjectId(name, type);
        for (let n = 2; ids.has(id); n++) {
            id = `${toObjectId(name, type)}_${n}`;
        }
        macs.add(mac);
        ids.add(id);
        devices.push({ id, name, type, mac, macNum: macToNumber(mac), seasonal: r.seasonal === true });
    });
    return { devices, errors };
}

/**
 * True when the device was heard within the timeout.
 *
 * @param lastSeen Time of the last advertisement in ms, undefined = never
 * @param now Current time in ms
 * @param timeoutMs Allowed silence in ms
 */
export function isReachable(lastSeen: number | undefined, now: number, timeoutMs: number): boolean {
    return lastSeen !== undefined && now - lastSeen <= timeoutMs;
}

/**
 * Decides the reachable flag. Without a working proxy, and during the first timeout after (re)connecting,
 * a silent device keeps its previous value: missing advertisements then say nothing about the device.
 *
 * @param lastSeen Time of the last advertisement in ms, undefined = never
 * @param now Current time in ms
 * @param timeoutMs Allowed silence in ms
 * @param listeningSince Time since when the proxy forwards advertisements, undefined = proxy down
 * @param previous Current value, undefined = not decided yet
 * @returns the new value, undefined = still not decided
 */
export function decideReachable(
    lastSeen: number | undefined,
    now: number,
    timeoutMs: number,
    listeningSince: number | undefined,
    previous: boolean | undefined,
): boolean | undefined {
    if (listeningSince === undefined) {
        return previous;
    }
    const reachable = isReachable(lastSeen, now, timeoutMs);
    if (!reachable && now - listeningSince < timeoutMs) {
        return previous;
    }
    return reachable;
}

/**
 * Log level for a change of the reachable flag: missing devices warn, seasonal ones only inform.
 *
 * @param device The device
 * @param reachable New value
 */
export function presenceLogLevel(device: Pick<Device, 'seasonal'>, reachable: boolean): 'info' | 'warn' {
    return reachable || device.seasonal ? 'info' : 'warn';
}
