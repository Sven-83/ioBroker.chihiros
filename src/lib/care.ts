/**
 * Phase 4: calculations and warnings.
 * - Fertiliser stock per pump: amount filled at the last refill minus what the pump dosed since then,
 *   daily dose learned from the last days, "days left" and a low flag.
 * - Water temperature limits (from the Doctor) and the automatic fan.
 * All settings are writable states (changeable from VIS), validated here.
 */
import { PUMPS, type StateDef } from './states';

/** Days of daily doses kept for the average */
export const HISTORY_DAYS = 7;
/** Counter drop from which the device counts as reset (e.g. bottle refilled in the app), in ml */
const RESET_TOLERANCE_ML = 0.05;

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Stored stock calculation of one pump (JSON in pumpN.stock) */
export interface Stock {
    /** ml in the bottle at the baseline; null = never refilled through the adapter (unknown) */
    baseRemaining: number | null;
    /** Total counter of the pump at the baseline */
    baseTotal: number;
    /** Total counter at the last read (to notice a reset by the device) */
    lastTotal: number | null;
    /** Final "dosed today" of the last days, newest last */
    history: Array<{ day: string; ml: number }>;
    /** Day of `today` (YYYY-MM-DD, local) */
    day: string;
    /** Last "dosed today" of `day` */
    today: number;
}

/** Stock without any data */
export function emptyStock(): Stock {
    return { baseRemaining: null, baseTotal: 0, lastTotal: null, history: [], day: '', today: 0 };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Reads the stored stock; anything broken gives an empty stock.
 *
 * @param raw Stored JSON
 */
export function parseStock(raw: unknown): Stock {
    if (typeof raw !== 'string' || !raw) {
        return emptyStock();
    }
    try {
        const o = JSON.parse(raw) as Partial<Stock>;
        const history = Array.isArray(o.history)
            ? o.history.filter(h => h && typeof h.day === 'string' && isNum(h.ml)).slice(-HISTORY_DAYS)
            : [];
        return {
            baseRemaining: isNum(o.baseRemaining) ? o.baseRemaining : null,
            baseTotal: isNum(o.baseTotal) ? o.baseTotal : 0,
            lastTotal: isNum(o.lastTotal) ? o.lastTotal : null,
            history,
            day: typeof o.day === 'string' ? o.day : '',
            today: isNum(o.today) ? o.today : 0,
        };
    } catch {
        return emptyStock();
    }
}

/**
 * Local day key YYYY-MM-DD.
 *
 * @param d Date
 */
export function dayKey(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Bottle refilled: from now on the remaining amount counts down from `amount`.
 *
 * @param s Stock
 * @param total Current total counter (null = not read yet: counts from the next read)
 * @param amount ml in the bottle after refilling
 */
export function refill(s: Stock, total: number | null, amount: number): Stock {
    const base = total ?? s.lastTotal ?? 0;
    return { ...s, baseRemaining: amount, baseTotal: base, lastTotal: total ?? s.lastTotal };
}

/**
 * Takes a new read of the pump.
 *
 * @param s Stock
 * @param total Total counter (ml since the last reset by the device)
 * @param today Dosed today by the schedule
 * @param day Local day of the read
 * @returns New stock; `reset` when the device counter went back (bottle reset in the app)
 */
export function updateStock(s: Stock, total: number, today: number, day: string): { stock: Stock; reset: boolean } {
    let next: Stock = { ...s, history: [...s.history] };
    let reset = false;
    if (s.lastTotal === null && s.baseRemaining !== null) {
        // refilled before the first read: count from this read
        next.baseTotal = total;
    } else if (s.lastTotal !== null && total < s.lastTotal - RESET_TOLERANCE_ML) {
        // the device counts from 0 again: keep the remaining amount continuous
        reset = true;
        const before = remaining(s);
        next = { ...next, baseRemaining: before, baseTotal: 0 };
    }
    if (day !== s.day) {
        if (s.day) {
            next.history.push({ day: s.day, ml: s.today });
            next.history = next.history.slice(-HISTORY_DAYS);
        }
        next.day = day;
    }
    next.today = today;
    next.lastTotal = total;
    return { stock: next, reset };
}

/**
 * Remaining ml in the bottle (not below 0); null = unknown.
 *
 * @param s Stock
 */
export function remaining(s: Stock): number | null {
    if (s.baseRemaining === null) {
        return null;
    }
    const used = (s.lastTotal ?? s.baseTotal) - s.baseTotal;
    return Math.max(0, round1(s.baseRemaining - used));
}

/**
 * Daily dose: average of the last full days, before the first full day the dose of today.
 *
 * @param s Stock
 */
export function dailyDose(s: Stock): number {
    if (s.history.length === 0) {
        return round1(s.today);
    }
    return round1(s.history.reduce((a, h) => a + h.ml, 0) / s.history.length);
}

/**
 * Full days the bottle still lasts; null = unknown or the pump does not dose.
 *
 * @param rest Remaining ml
 * @param daily Daily dose
 */
export function daysLeft(rest: number | null, daily: number): number | null {
    if (rest === null || daily <= 0) {
        return null;
    }
    return Math.floor(rest / daily);
}

/**
 * Low: lasts at most `warnDays` days.
 *
 * @param days Days left
 * @param warnDays Warning limit
 */
export function isLow(days: number | null, warnDays: number): boolean {
    return days !== null && days <= warnDays;
}

/**
 * Temperature alarm: "low", "high" or "" (ok / unknown).
 *
 * @param temp Water temperature
 * @param min Lower limit
 * @param max Upper limit
 */
export function tempAlarm(temp: unknown, min: number, max: number): '' | 'low' | 'high' {
    if (!isNum(temp)) {
        return '';
    }
    if (temp < min) {
        return 'low';
    }
    return temp > max ? 'high' : '';
}

/** Settings of the automatic fan */
export interface FanAuto {
    /** Automatic switched on */
    enabled: boolean;
    /** Fan on from this water temperature */
    onTemp: number;
    /** Fan off again at this water temperature */
    offTemp: number;
    /** Fan level while on */
    level: number;
}

/**
 * What the automatic fan has to do now.
 *
 * @param temp Water temperature (Doctor)
 * @param cfg Settings
 * @param active The automatic switched the fan on
 * @param hold The fan was set by hand while the automatic was on: wait until the water is cool again
 */
export function fanAutoAction(temp: unknown, cfg: FanAuto, active: boolean, hold: boolean): 'on' | 'off' | null {
    if (!cfg.enabled) {
        return active ? 'off' : null;
    }
    if (!isNum(temp) || hold) {
        return null;
    }
    const off = Math.min(cfg.offTemp, cfg.onTemp - 0.1);
    if (!active && temp >= cfg.onTemp) {
        return 'on';
    }
    if (active && temp <= off) {
        return 'off';
    }
    return null;
}

// ---- state definitions ----

const setting = (
    name: string,
    type: 'number' | 'boolean' | 'string',
    role: string,
    def: ioBroker.StateValue,
    extra: Partial<ioBroker.StateCommon> = {},
): ioBroker.StateCommon => ({ name, type, role, read: true, write: true, def, ...extra });
const value = (
    name: string,
    type: 'number' | 'boolean' | 'string',
    role: string,
    extra: Partial<ioBroker.StateCommon> = {},
): ioBroker.StateCommon => ({ name, type, role, read: true, write: false, ...extra });

/** Bottle size (Sven 18.11.2026: all bottles hold 450 ml) */
export const DEFAULT_REFILL_ML = 450;

/**
 * Stock states of one pump.
 *
 * @param p Pump 1-4
 */
export function pumpCareStates(p: number): { settings: StateDef[]; values: StateDef[] } {
    const id = (s: string): string => `pump${p}.${s}`;
    return {
        settings: [
            { id: id('label'), common: setting(`Pump ${p}: content (free text)`, 'string', 'text', '') },
            {
                id: id('refillAmount'),
                common: setting(`Pump ${p}: ml in the bottle after refilling`, 'number', 'level', DEFAULT_REFILL_ML, {
                    unit: 'ml',
                    min: 0,
                    max: 5000,
                }),
            },
            {
                id: id('refilled'),
                common: {
                    name: `Pump ${p}: bottle refilled (press after refilling)`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
            },
        ],
        values: [
            { id: id('refilledAt'), common: value(`Pump ${p}: last refill`, 'number', 'date') },
            {
                id: id('remaining'),
                common: value(`Pump ${p}: remaining in the bottle (calculated)`, 'number', 'value', { unit: 'ml' }),
            },
            {
                id: id('dailyDose'),
                common: value(`Pump ${p}: daily dose (average of the last days)`, 'number', 'value', {
                    unit: 'ml',
                }),
            },
            {
                id: id('daysLeft'),
                common: value(`Pump ${p}: bottle lasts for (days)`, 'number', 'value', { unit: 'd' }),
            },
            {
                id: id('low'),
                common: value(`Pump ${p}: bottle almost empty`, 'boolean', 'indicator.alarm', { def: false }),
            },
            {
                id: id('stock'),
                common: value(`Pump ${p}: stock calculation (internal)`, 'string', 'json', { def: '' }),
            },
        ],
    };
}

/** All pump stock states */
export function doserCareStates(): { settings: StateDef[]; values: StateDef[] } {
    const out = { settings: [] as StateDef[], values: [] as StateDef[] };
    for (let p = 1; p <= PUMPS; p++) {
        const s = pumpCareStates(p);
        out.settings.push(...s.settings);
        out.values.push(...s.values);
    }
    return out;
}

/** States of the whole aquarium (instance level, channel "aquarium") */
export const AQUARIUM_STATES: { settings: StateDef[]; values: StateDef[] } = {
    settings: [
        {
            id: 'tempMin',
            common: setting('Water temperature: lower limit', 'number', 'level.temperature', 20, {
                unit: '°C',
                min: 10,
                max: 35,
            }),
        },
        {
            id: 'tempMax',
            common: setting('Water temperature: upper limit', 'number', 'level.temperature', 28, {
                unit: '°C',
                min: 10,
                max: 35,
            }),
        },
        {
            id: 'warnDays',
            common: setting('Fertiliser: warn when a bottle lasts at most (days)', 'number', 'level', 7, {
                unit: 'd',
                min: 0,
                max: 60,
            }),
        },
    ],
    values: [
        {
            id: 'waterTemp',
            common: value('Water temperature (Doctor)', 'number', 'value.temperature', { unit: '°C' }),
        },
        {
            id: 'tempAlarm',
            common: value('Water temperature outside the limits: "low", "high" or empty', 'string', 'text', {
                def: '',
            }),
        },
        {
            id: 'fertiliserLow',
            common: value('Fertiliser: bottles almost empty (text, empty = ok)', 'string', 'text', { def: '' }),
        },
    ],
};

/** States of the automatic fan (below the fan device) */
export const FAN_AUTO_STATES: { settings: StateDef[]; values: StateDef[] } = {
    settings: [
        {
            id: 'auto',
            common: setting('Automatic: fan by water temperature (Doctor)', 'boolean', 'switch.enable', false),
        },
        {
            id: 'autoOnTemp',
            common: setting('Automatic: on from', 'number', 'level.temperature', 26, { unit: '°C', min: 15, max: 35 }),
        },
        {
            id: 'autoOffTemp',
            common: setting('Automatic: off again at', 'number', 'level.temperature', 25.5, {
                unit: '°C',
                min: 15,
                max: 35,
            }),
        },
        {
            id: 'autoLevel',
            common: setting('Automatic: level', 'number', 'level', 11, { min: 1, max: 20 }),
        },
    ],
    values: [
        {
            id: 'autoActive',
            common: value('Automatic switched the fan on', 'boolean', 'indicator', { def: false }),
        },
    ],
};

/**
 * Validates a written setting by its definition; returns the value to store.
 *
 * @param def State definition
 * @param val Written value
 */
export function validateSetting(def: StateDef, val: ioBroker.StateValue): ioBroker.StateValue {
    const c = def.common;
    if (c.type === 'number') {
        const n = typeof val === 'string' ? Number(val.replace(',', '.')) : Number(val);
        if (val === null || val === '' || !Number.isFinite(n)) {
            throw new Error(`${def.id}: ${JSON.stringify(val)} is not a number`);
        }
        if ((c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) {
            throw new Error(`${def.id}: ${n} is outside ${c.min ?? '-'}..${c.max ?? '-'}`);
        }
        return round1(n);
    }
    if (c.type === 'boolean') {
        return val === true || val === 'true' || val === 1;
    }
    return String(val ?? '').slice(0, 100);
}
