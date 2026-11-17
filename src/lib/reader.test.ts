import { expect } from 'chai';
import { decodeAnswer, MessageIds } from './protocol';
import { clockDeviation, interpret, readPlan } from './reader';

const hex = (s: string): number[] => s.split(' ').map(x => parseInt(x, 16));
const ans = (s: string): ReturnType<typeof decodeAnswer> => decodeAnswer(hex(s));

const INFO = ans('5b 08 0a 00 01 0a 01 ff ff ff 64 13 88 08')!;
const TOTAL = ans('5b 01 0a 00 01 1e 00 00 0e 12 1c 84 00 00 14')!;
const TODAY = ans('5b 01 0a 00 01 22 00 00 00 00 00 64 00 00 28')!;
const FAN = ans('5b 09 0b 00 01 25 17 12 08 92 00 e1 22')!;
const DOCTOR = ans('5b 04 0c 00 01 25 00 00 0b ff 00 d0 00 22')!;

describe('reader', () => {
    it('asks the dosing pump for status, totals and today', () => {
        const plan = readPlan('doser', new MessageIds());
        expect(plan.frames.map(f => Array.from(f))).to.deep.equal([
            hex('5a 01 06 00 01 04 01 03'),
            hex('a5 01 06 00 02 04 04 05'),
            hex('a5 01 06 00 03 04 05 05'),
        ]);
        expect(plan.isDone([INFO, TOTAL])).to.equal(false);
        expect(plan.isDone([INFO, TOTAL, TODAY])).to.equal(true);
    });

    it('sends only the status query to the other devices', () => {
        for (const t of ['light', 'doctor', 'fan', 'co2'] as const) {
            expect(readPlan(t, new MessageIds()).frames.map(f => Array.from(f))).to.deep.equal([
                hex('5a 01 06 00 01 04 01 03'),
            ]);
        }
        expect(readPlan('co2', new MessageIds()).isDone([INFO])).to.equal(true);
        expect(readPlan('fan', new MessageIds()).isDone([INFO])).to.equal(false);
        expect(readPlan('fan', new MessageIds()).isDone([INFO, FAN])).to.equal(true);
    });

    it('interprets the answers per type', () => {
        expect(interpret('doser', [INFO, TOTAL, TODAY])).to.deep.equal({
            doserTotal: [0, 360.2, 730, 0],
            doserToday: [0, 0, 10, 0],
        });
        expect(interpret('fan', [INFO, FAN]).live).to.deep.equal({ waterTemp: 22.5, humidity: 59.06, roomTemp: 21.94 });
        expect(interpret('doctor', [DOCTOR]).live).to.deep.equal({ waterTemp: 20.8 });
        expect(interpret('co2', [INFO])).to.deep.equal({});
        expect(interpret('light', [INFO]).light).to.equal(undefined);
    });

    it('computes the clock deviation across midnight', () => {
        const at = (h: number, m: number): Date => new Date(2026, 10, 17, h, m);
        expect(clockDeviation(14 * 60, at(14, 0))).to.equal(0);
        expect(clockDeviation(14 * 60 + 3, at(14, 0))).to.equal(3);
        expect(clockDeviation(23 * 60 + 58, at(0, 2))).to.equal(-4);
        expect(clockDeviation(1, at(23, 59))).to.equal(2);
        // after a power cut the clock restarts at 00:00
        expect(clockDeviation(5, at(11, 4))).to.equal(-659);
    });
});
