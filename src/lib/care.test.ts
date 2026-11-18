import { expect } from 'chai';
import {
    AQUARIUM_STATES,
    dailyDose,
    dayKey,
    daysLeft,
    doserCareStates,
    emptyStock,
    FAN_AUTO_STATES,
    fanAutoAction,
    isLow,
    parseStock,
    refill,
    remaining,
    tempAlarm,
    updateStock,
    validateSetting,
} from './care';

describe('care', () => {
    describe('stock', () => {
        it('is unknown until the first refill', () => {
            const { stock } = updateStock(emptyStock(), 0, 5, '2026-11-18');
            expect(remaining(stock)).to.equal(null);
            expect(daysLeft(remaining(stock), dailyDose(stock))).to.equal(null);
        });

        it('counts down from the refill', () => {
            let s = refill(emptyStock(), 0, 450);
            s = updateStock(s, 0, 0, '2026-11-18').stock;
            expect(remaining(s)).to.equal(450);
            s = updateStock(s, 10, 10, '2026-11-19').stock;
            expect(remaining(s)).to.equal(440);
            s = updateStock(s, 10.2, 10, '2026-11-19').stock; // hand dose 0.2 ml
            expect(remaining(s)).to.equal(439.8);
        });

        it('refill uses the counter at that moment and a custom amount', () => {
            let s = updateStock(emptyStock(), 730, 10, '2026-11-17').stock;
            s = refill(s, 730, 300);
            s = updateStock(s, 740, 10, '2026-11-18').stock;
            expect(remaining(s)).to.equal(290);
        });

        it('refill before the first read counts from the first read', () => {
            let s = refill(emptyStock(), null, 450);
            s = updateStock(s, 730, 10, '2026-11-18').stock;
            expect(remaining(s)).to.equal(450);
            s = updateStock(s, 735, 15, '2026-11-18').stock;
            expect(remaining(s)).to.equal(445);
        });

        it('stays continuous when the device resets its counter (refill in the app)', () => {
            let s = refill(emptyStock(), 365.4, 450);
            s = updateStock(s, 400, 5, '2026-11-18').stock;
            expect(remaining(s)).to.equal(415.4);
            const r = updateStock(s, 0, 5, '2026-11-18');
            expect(r.reset).to.equal(true);
            expect(remaining(r.stock)).to.equal(415.4);
            const s2 = updateStock(r.stock, 5, 5, '2026-11-19').stock;
            expect(remaining(s2)).to.equal(410.4);
            // pressing "refilled" afterwards sets it to the bottle
            expect(remaining(refill(s2, 5, 450))).to.equal(450);
        });

        it('never goes below 0', () => {
            let s = refill(emptyStock(), 0, 10);
            s = updateStock(s, 30, 10, '2026-11-18').stock;
            expect(remaining(s)).to.equal(0);
            expect(daysLeft(remaining(s), 10)).to.equal(0);
        });

        it('learns the daily dose from the final value of each day', () => {
            let s = emptyStock();
            s = updateStock(s, 0, 0, '2026-11-18').stock; // before the dose
            s = updateStock(s, 10, 10, '2026-11-18').stock;
            expect(dailyDose(s)).to.equal(10); // no full day yet: today
            s = updateStock(s, 10, 0, '2026-11-19').stock; // new day, not dosed yet
            expect(s.history).to.deep.equal([{ day: '2026-11-18', ml: 10 }]);
            expect(dailyDose(s)).to.equal(10);
            s = updateStock(s, 15, 5, '2026-11-19').stock;
            s = updateStock(s, 15, 0, '2026-11-20').stock;
            expect(dailyDose(s)).to.equal(7.5);
        });

        it('keeps only the last days', () => {
            let s = emptyStock();
            for (let d = 1; d <= 12; d++) {
                s = updateStock(s, d, 1, `2026-11-${String(d).padStart(2, '0')}`).stock;
            }
            expect(s.history).to.have.length(7);
            expect(s.history[6].day).to.equal('2026-11-11');
        });

        it('days left and low', () => {
            expect(daysLeft(445, 5)).to.equal(89);
            expect(daysLeft(35, 5)).to.equal(7);
            expect(daysLeft(100, 0)).to.equal(null);
            expect(isLow(7, 7)).to.equal(true);
            expect(isLow(8, 7)).to.equal(false);
            expect(isLow(null, 7)).to.equal(false);
        });

        it('parses stored JSON and survives garbage', () => {
            const s = refill(emptyStock(), 3, 450);
            expect(parseStock(JSON.stringify(s))).to.deep.equal(s);
            expect(parseStock('{x')).to.deep.equal(emptyStock());
            expect(parseStock('')).to.deep.equal(emptyStock());
            expect(parseStock(JSON.stringify({ baseRemaining: 'a', history: [{ day: 1 }] }))).to.deep.equal(
                emptyStock(),
            );
        });

        it('day key is local', () => {
            expect(dayKey(new Date(2026, 10, 18, 23, 59))).to.equal('2026-11-18');
            expect(dayKey(new Date(2026, 0, 2, 0, 1))).to.equal('2026-01-02');
        });
    });

    describe('temperature', () => {
        it('alarm outside the limits', () => {
            expect(tempAlarm(21.2, 20, 28)).to.equal('');
            expect(tempAlarm(19.9, 20, 28)).to.equal('low');
            expect(tempAlarm(28.1, 20, 28)).to.equal('high');
            expect(tempAlarm(28, 20, 28)).to.equal('');
            expect(tempAlarm(null, 20, 28)).to.equal('');
        });

        it('automatic fan with hysteresis', () => {
            const cfg = { enabled: true, onTemp: 26, offTemp: 25.5, level: 11 };
            expect(fanAutoAction(25.9, cfg, false, false)).to.equal(null);
            expect(fanAutoAction(26, cfg, false, false)).to.equal('on');
            expect(fanAutoAction(25.8, cfg, true, false)).to.equal(null);
            expect(fanAutoAction(25.5, cfg, true, false)).to.equal('off');
            expect(fanAutoAction(27, cfg, true, false)).to.equal(null);
            // set by hand: wait
            expect(fanAutoAction(27, cfg, false, true)).to.equal(null);
            // disabled: switch off only what the automatic switched on
            expect(fanAutoAction(27, { ...cfg, enabled: false }, true, false)).to.equal('off');
            expect(fanAutoAction(27, { ...cfg, enabled: false }, false, false)).to.equal(null);
            // off limit above the on limit is corrected
            expect(fanAutoAction(25.95, { ...cfg, offTemp: 27 }, true, false)).to.equal(null);
            expect(fanAutoAction(25.9, { ...cfg, offTemp: 27 }, true, false)).to.equal('off');
            expect(fanAutoAction(undefined, cfg, false, false)).to.equal(null);
        });
    });

    describe('settings', () => {
        const def = (id: string): (typeof AQUARIUM_STATES.settings)[number] =>
            [...AQUARIUM_STATES.settings, ...FAN_AUTO_STATES.settings, ...doserCareStates().settings].find(
                s => s.id === id,
            )!;

        it('defines the defaults Sven asked for', () => {
            expect(def('tempMin').common.def).to.equal(20);
            expect(def('tempMax').common.def).to.equal(28);
            expect(def('warnDays').common.def).to.equal(7);
            expect(def('autoOnTemp').common.def).to.equal(26);
            expect(def('auto').common.def).to.equal(false);
            expect(def('pump1.refillAmount').common.def).to.equal(450);
            expect(doserCareStates().values.map(s => s.id)).to.include('pump4.daysLeft');
        });

        it('validates numbers, booleans and text', () => {
            expect(validateSetting(def('tempMax'), '26,5')).to.equal(26.5);
            expect(validateSetting(def('pump2.refillAmount'), 300)).to.equal(300);
            expect(() => validateSetting(def('tempMax'), 80)).to.throw('outside');
            expect(() => validateSetting(def('tempMax'), 'x')).to.throw('not a number');
            expect(() => validateSetting(def('tempMax'), null)).to.throw('not a number');
            expect(validateSetting(def('auto'), 'true')).to.equal(true);
            expect(validateSetting(def('auto'), 0)).to.equal(false);
            expect(validateSetting(def('pump1.label'), 'Eisen')).to.equal('Eisen');
        });
    });
});
