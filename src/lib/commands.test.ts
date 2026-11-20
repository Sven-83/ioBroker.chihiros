import { expect } from 'chai';
import {
    co2ShouldBeOpen,
    parseCo2Windows,
    clockFrame,
    clockParams,
    co2Command,
    CommandError,
    doctorCommand,
    doseMinutes,
    doserCommand,
    planCommand,
    planConflict,
    fanCommand,
    lightCommand,
    writeStates,
} from './commands';

const CUR = { red: 133, green: 84, blue: 129, white: 65, on: true };

describe('commands', () => {
    it('defines the writable light states only for the light', () => {
        expect(writeStates('light').map(s => s.id)).to.deep.equal(['red', 'green', 'blue', 'white', 'on']);
        expect(writeStates('light').every(s => s.common.write)).to.equal(true);
        expect(writeStates('doser').map(s => s.id)).to.deep.equal([
            'pump1.plan',
            'pump2.plan',
            'pump3.plan',
            'pump4.plan',
            'pump1.doseNow',
            'pump2.doseNow',
            'pump3.doseNow',
            'pump4.doseNow',
        ]);
        expect(writeStates('doser')[4].common.max).to.equal(5);
        expect(writeStates('fan').map(s => s.id)).to.deep.equal(['level']);
        expect(writeStates('co2').map(s => s.id)).to.deep.equal(['schedule', 'on']);
        expect(writeStates('doctor').map(s => s.id)).to.deep.equal(['mode']);
        expect(writeStates('doctor')[0].common.states).to.deep.equal({ fish: 'Fish', shrimp: 'Shrimp' });
    });

    it('builds the clock frame like the app', () => {
        // capture 16.11.2026 21:43:46 (Monday): 1a 0b 01 15 2b 2e
        expect(clockParams(new Date(2026, 10, 16, 21, 43, 46))).to.deep.equal([0x1a, 0x0b, 0x01, 0x15, 0x2b, 0x2e]);
        // capture 17.11.2026 17:15:58 (Tuesday): 1a 0b 02 11 0f 3a
        expect(clockFrame(new Date(2026, 10, 17, 17, 15, 58))).to.deep.equal([
            0x5a,
            0x09,
            [0x1a, 0x0b, 0x02, 0x11, 0x0f, 0x3a],
        ]);
        // Sunday = 7
        expect(clockParams(new Date(2026, 10, 22, 0, 0, 0))[2]).to.equal(7);
    });

    it('sets one channel while the light is on', () => {
        expect(lightCommand('green', 0, CUR)).to.deep.equal({
            label: 'green 0',
            frames: [[0x5a, 0x07, [1, 0]]],
            states: { green: 0, on: true },
        });
        expect(lightCommand('white', '255', CUR).frames).to.deep.equal([[0x5a, 0x07, [3, 255]]]);
        expect(lightCommand('blue', 12.6, CUR).states.blue).to.equal(13);
    });

    it('switches the light on with all values when a colour is set while off', () => {
        const plan = lightCommand('red', 100, { ...CUR, on: false });
        expect(plan.frames).to.deep.equal([
            [0x5a, 0x07, [0, 100]],
            [0x5a, 0x07, [1, 84]],
            [0x5a, 0x07, [2, 129]],
            [0x5a, 0x07, [3, 65]],
        ]);
        expect(plan.states).to.deep.equal({ red: 100, on: true });
    });

    it('reports off when the last channel goes to 0', () => {
        const cur = { red: 0, green: 0, blue: 0, white: 10, on: true };
        expect(lightCommand('white', 0, cur).states).to.deep.equal({ white: 0, on: false });
    });

    it('switches off and on again with the last values', () => {
        expect(lightCommand('on', false, CUR).frames.map(f => f[2])).to.deep.equal([
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
        ]);
        const on = lightCommand('on', true, { ...CUR, on: false });
        expect(on.frames.map(f => f[2])).to.deep.equal([
            [0, 133],
            [1, 84],
            [2, 129],
            [3, 65],
        ]);
        expect(on.label).to.equal('on (133/84/129/65)');
    });

    it('rejects invalid values and impossible commands', () => {
        for (const v of [-1, 256, 'abc', null, true]) {
            expect(() => lightCommand('red', v, CUR)).to.throw(CommandError);
        }
        expect(() => lightCommand('on', true, { red: 0, green: 0, blue: 0, white: 0, on: false })).to.throw(
            /set a colour first/,
        );
        expect(() => lightCommand('schedule', 'x', CUR)).to.throw(/not writable/);
    });

    it('builds the manual dose like the write test', () => {
        // write test 16.11.2026: pump 2, 0.2 ml = a5/1b (27 decimal) [01 00 00 00 02]
        expect(doserCommand('pump2.doseNow', 0.2)).to.deep.equal({
            label: 'pump 2: dose 0.2 ml',
            frames: [[0xa5, 0x1b, [1, 0, 0, 0, 2]]],
            states: { 'pump2.doseNow': 0.2 },
            confirm: { pump: 2, ml: 0.2 },
        });
        expect(doserCommand('pump3.doseNow', '5').frames).to.deep.equal([[0xa5, 0x1b, [2, 0, 0, 0, 50]]]);
        expect(doserCommand('pump1.doseNow', 1.04).confirm).to.deep.equal({ pump: 1, ml: 1 });
    });

    it('rejects doses outside 0.1-5 ml and unknown pumps', () => {
        for (const v of [0, 0.04, 5.1, 100, -1, 'x', null, true]) {
            expect(() => doserCommand('pump1.doseNow', v)).to.throw(CommandError);
        }
        expect(() => doserCommand('pump5.doseNow', 1)).to.throw(/not writable/);
        expect(() => doserCommand('pump1.total', 1)).to.throw(/not writable/);
    });

    it('builds the fan level like the write test', () => {
        // write test 17.11.2026: 5a/07 [ff 05] = level 5
        const queries = [
            [0xa5, 0x04, [0x06]],
            [0xa5, 0x04, [0x08]],
        ];
        expect(fanCommand('level', 5)).to.deep.equal({
            label: 'level 5',
            frames: [...queries, [0x5a, 0x07, [0xff, 5]]],
            states: { level: 5 },
        });
        expect(fanCommand('level', '0')).to.deep.equal({
            label: 'off',
            frames: [...queries, [0x5a, 0x07, [0xff, 0]]],
            states: { level: 0 },
        });
        expect(fanCommand('level', 20).frames[2]).to.deep.equal([0x5a, 0x07, [0xff, 20]]);
    });

    it('rejects invalid fan levels', () => {
        for (const v of [-1, 21, 2.5, 'x', null, true]) {
            expect(() => fanCommand('level', v)).to.throw(CommandError);
        }
        expect(() => fanCommand('speed', 1)).to.throw(/not writable/);
    });

    it('switches CO2 through the schedule like the write test', () => {
        // write test 16.11.2026 (decimal there): [90,5,[7,255,255]], [90,22,[0,0,100]], [90,22,[23,59,0]] = on
        expect(co2Command('on', true)).to.deep.equal({
            label: 'CO2 on (schedule 00:00-23:59)',
            frames: [
                [0x5a, 0x05, [7, 255, 255]],
                [0x5a, 22, [0, 0, 100]],
                [0x5a, 22, [23, 59, 0]],
            ],
            states: { on: true, schedule: '' },
        });
        // off: [90,22,[0,0,111]], [90,22,[23,59,111]]
        expect(co2Command('on', 'false').frames).to.deep.equal([
            [0x5a, 0x05, [7, 255, 255]],
            [0x5a, 22, [0, 0, 111]],
            [0x5a, 22, [23, 59, 111]],
        ]);
        expect(co2Command('on', 0).states).to.deep.equal({ on: false });
    });

    it('rejects invalid CO2 values', () => {
        for (const v of ['on', 2, null, 'x']) {
            expect(() => co2Command('on', v)).to.throw(CommandError);
        }
        expect(() => co2Command('valveOpen', true)).to.throw(/not writable/);
    });

    it('sets the Doctor mode like the app', () => {
        // capture 16.11.2026: 5a 01 08 00 28 05 36 ff ff 12 + a5 01 07 00 29 01 01 08 27 = shrimp
        expect(doctorCommand('mode', 'shrimp')).to.deep.equal({
            label: 'mode shrimp',
            frames: [
                [0x5a, 0x05, [0x36, 0xff, 0xff]],
                [0xa5, 0x01, [0x01, 0x08]],
            ],
            states: { mode: 'shrimp' },
        });
        // 5a 01 08 00 2c 05 35 ff ff 15 + a5 01 07 00 2d 01 01 72 59 = fish
        expect(doctorCommand('mode', ' Fish ').frames).to.deep.equal([
            [0x5a, 0x05, [0x35, 0xff, 0xff]],
            [0xa5, 0x01, [0x01, 0x72]],
        ]);
    });

    it('rejects unknown Doctor modes', () => {
        for (const v of ['plants', '', 1, null, true]) {
            expect(() => doctorCommand('mode', v)).to.throw(CommandError);
        }
        expect(() => doctorCommand('waterTemp', 'fish')).to.throw(/not writable/);
    });

    it('daily dose plan: frames like the app (capture 20.11.2026) and limits', () => {
        // the app wrote P2 (index 1): a5/20 [01 00 01], a5/1b [01 7f 01 01 00 32], a5/15 [01 00 0e 03 00 00]
        const p = doserCommand('pump2.plan', '{"on":true,"time":"14:03","ml":5,"days":127}');
        expect(p.frames).to.deep.equal([
            [0xa5, 0x20, [1, 0, 1]],
            [0xa5, 0x1b, [1, 0x7f, 1, 1, 0, 50]],
            [0xa5, 0x15, [1, 0, 14, 3, 0, 0]],
        ]);
        expect(p.confirmPlan).to.deep.equal({ pump: 2, on: true, time: '14:03' });
        // Mo-Fr and 5.5 ml as sent by the app (second capture 20.11.2026)
        expect(doserCommand('pump2.plan', '{"on":true,"time":"14:03","ml":5.5,"days":124}').frames[1]).to.deep.equal([
            0xa5,
            0x1b,
            [1, 0x7c, 1, 1, 0, 0x37],
        ]);
        expect(p.states).to.deep.equal({ 'pump2.plan': '{"on":true,"time":"14:03","ml":5,"days":127}' });
        expect(planCommand(4, 'pump4.plan', '{"on":true,"time":"8:00","ml":25.6}').frames[1]).to.deep.equal([
            0xa5,
            0x1b,
            [3, 0x7f, 1, 1, 1, 0],
        ]);
        expect(doserCommand('pump1.plan', '{"on":false}').frames).to.deep.equal([[0xa5, 0x20, [0, 0, 0]]]);
        for (const v of [
            'x',
            '{}',
            '{"on":true,"time":"25:00","ml":1}',
            '{"on":true,"time":"10:00","ml":0}',
            '{"on":true,"time":"10:00","ml":31}',
            '{"on":true,"time":"10:00","ml":1,"days":0}',
            '{"on":true,"time":"10:00","ml":1,"days":128}',
        ]) {
            expect(() => doserCommand('pump1.plan', v), v).to.throw(CommandError);
        }
    });

    it('never two doses at the same time (Sven 20.11.2026)', () => {
        expect(doseMinutes(5)).to.equal(2);
        expect(doseMinutes(10)).to.equal(2);
        expect(doseMinutes(30)).to.equal(4);
        // plans of 20.11.2026: P3 10 ml at 14:00, P2 5 ml at 14:03
        const p3 = { pump: 3, minute: 840, ml: 10 };
        expect(planConflict({ pump: 2, minute: 843, ml: 5 }, [p3])).to.equal(null);
        expect(planConflict({ pump: 2, minute: 842, ml: 5 }, [p3])).to.equal(null);
        expect(planConflict({ pump: 2, minute: 841, ml: 5 }, [p3])).to.deep.equal(p3);
        expect(planConflict({ pump: 4, minute: 839, ml: 1 }, [p3])).to.deep.equal(p3);
        expect(planConflict({ pump: 3, minute: 840, ml: 10 }, [p3])).to.equal(null);
        // across midnight
        expect(planConflict({ pump: 1, minute: 0, ml: 1 }, [{ pump: 2, minute: 1439, ml: 5 }])).to.not.equal(null);
    });

    it('CO2 time windows: one open and one close slot per window', () => {
        expect(co2Command('schedule', '10:00-12:00, 13:00-20:00').frames).to.deep.equal([
            [0x5a, 0x05, [0x07, 0xff, 0xff]],
            [0x5a, 0x16, [10, 0, 0x64]],
            [0x5a, 0x16, [12, 0, 0x00]],
            [0x5a, 0x16, [13, 0, 0x64]],
            [0x5a, 0x16, [20, 0, 0x00]],
        ]);
        // always = the frames of the app
        expect(co2Command('schedule', '').frames).to.deep.equal(co2Command('on', true).frames);
        expect(co2Command('schedule', '00:00-23:59').states).to.deep.equal({ schedule: '', on: true });
        expect(co2Command('schedule', '13:00-20:00,9:30-10:00').states.schedule).to.equal('09:30-10:00, 13:00-20:00');
        for (const bad of [
            'x',
            '12:00-11:00',
            '10:00-12:00, 11:00-13:00',
            '10:00-24:00',
            '1:00-2:00,3:00-4:00,5:00-6:00,7:00-8:00,9:00-10:00',
        ]) {
            expect(() => parseCo2Windows(bad), bad).to.throw(CommandError);
        }
        expect(co2ShouldBeOpen('', new Date(2026, 10, 20, 23))).to.equal(true);
        expect(co2ShouldBeOpen('10:00-12:00', new Date(2026, 10, 20, 11, 59))).to.equal(true);
        expect(co2ShouldBeOpen('10:00-12:00', new Date(2026, 10, 20, 12, 0))).to.equal(false);
    });
});
