import { expect } from 'chai';
import { clockFrame, clockParams, CommandError, doserCommand, lightCommand, writeStates } from './commands';

const CUR = { red: 133, green: 84, blue: 129, white: 65, on: true };

describe('commands', () => {
    it('defines the writable light states only for the light', () => {
        expect(writeStates('light').map(s => s.id)).to.deep.equal(['red', 'green', 'blue', 'white', 'on']);
        expect(writeStates('light').every(s => s.common.write)).to.equal(true);
        expect(writeStates('doser').map(s => s.id)).to.deep.equal([
            'pump1.doseNow',
            'pump2.doseNow',
            'pump3.doseNow',
            'pump4.doseNow',
        ]);
        expect(writeStates('doser')[0].common.max).to.equal(5);
        expect(writeStates('fan')).to.deep.equal([]);
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
        // write test 16.11.2026: pump 2, 0.2 ml = a5/27 [01 00 00 00 02]
        expect(doserCommand('pump2.doseNow', 0.2)).to.deep.equal({
            label: 'pump 2: dose 0.2 ml',
            frames: [[0xa5, 0x27, [1, 0, 0, 0, 2]]],
            states: { 'pump2.doseNow': 0.2 },
            confirm: { pump: 2, ml: 0.2 },
        });
        expect(doserCommand('pump3.doseNow', '5').frames).to.deep.equal([[0xa5, 0x27, [2, 0, 0, 0, 50]]]);
        expect(doserCommand('pump1.doseNow', 1.04).confirm).to.deep.equal({ pump: 1, ml: 1 });
    });

    it('rejects doses outside 0.1-5 ml and unknown pumps', () => {
        for (const v of [0, 0.04, 5.1, 100, -1, 'x', null, true]) {
            expect(() => doserCommand('pump1.doseNow', v)).to.throw(CommandError);
        }
        expect(() => doserCommand('pump5.doseNow', 1)).to.throw(/not writable/);
        expect(() => doserCommand('pump1.total', 1)).to.throw(/not writable/);
    });
});
