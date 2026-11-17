import { expect } from 'chai';
import { parseDevices } from './devices';
import { FAN_KICK_LEVELS, isOn, parsePowerState, powerIndicator } from './power';

/**
 * Fake MAC for tests (never a real device)
 *
 * @param last Last byte as hex
 */
const mac = (last: string): string => `0A:1B:2C:3D:4E:${last}`;

describe('power', () => {
    it('decides running / valve open from the measured power', () => {
        // fan: off 0 W, level 1-7 about 1.4 W, level 20 2.6 W (17.11.2026)
        expect(isOn('fan', 0)).to.equal(false);
        expect(isOn('fan', 0.3)).to.equal(false);
        expect(isOn('fan', 1.43)).to.equal(true);
        expect(isOn('fan', 2.6)).to.equal(true);
        // CO2: valve open 2.9 W, closed 0 W (16.11.2026)
        expect(isOn('co2', 2.92)).to.equal(true);
        expect(isOn('co2', 0)).to.equal(false);
        // no threshold or no number
        expect(isOn('light', 50)).to.equal(null);
        expect(isOn('fan', null)).to.equal(null);
        expect(isOn('fan', '1.4')).to.equal(null);
    });

    it('has indicator states for fan and CO2 only', () => {
        expect(powerIndicator('fan')?.id).to.equal('running');
        expect(powerIndicator('co2')?.id).to.equal('valveOpen');
        expect(powerIndicator('co2')?.common.write).to.equal(false);
        expect(powerIndicator('doser')).to.equal(null);
    });

    it('kicks the fan up, then down', () => {
        expect([...FAN_KICK_LEVELS]).to.deep.equal([11, 4]);
    });

    it('accepts plain state IDs only', () => {
        expect(parsePowerState(' shelly.0.SHPLG-S#ABCDEF#1.Relay0.Power ')).to.equal(
            'shelly.0.SHPLG-S#ABCDEF#1.Relay0.Power',
        );
        for (const bad of ['', 'Power', 'shelly.0.*', 'shelly.0..Power', 'a b.c', 42, null]) {
            expect(parsePowerState(bad)).to.equal(null);
        }
    });

    it('reads the power state from the device configuration', () => {
        const r = parseDevices([
            { name: 'Fan', type: 'fan', mac: mac('01'), seasonal: true, powerState: 'shelly.0.X#1.Relay0.Power' },
            { name: 'CO2', type: 'co2', mac: mac('02'), powerState: 'not valid *' },
            { name: 'Light', type: 'light', mac: mac('03'), powerState: '' },
        ]);
        expect(r.devices.map(d => d.powerState)).to.deep.equal(['shelly.0.X#1.Relay0.Power', undefined, undefined]);
        expect(r.errors).to.deep.equal(['device row 2: invalid power state ID "not valid *" - ignored']);
    });
});
