import { expect } from 'chai';
import {
    decideReachable,
    isReachable,
    macToNumber,
    normalizeMac,
    numberToMac,
    parseDevices,
    presenceLogLevel,
    toObjectId,
} from './devices';

/**
 * Fake MAC built at runtime (no MAC literals in the repository)
 *
 * @param last Last byte as two hex digits
 * @param sep Separator between the bytes
 */
const mac = (last: string, sep = ':'): string => ['0A', '1B', '2C', '3D', '4E', last].join(sep);

describe('devices', () => {
    describe('normalizeMac', () => {
        it('accepts colon, dash and plain notation', () => {
            expect(normalizeMac(mac('5f').toLowerCase())).to.equal(mac('5F'));
            expect(normalizeMac(mac('5F', '-'))).to.equal(mac('5F'));
            expect(normalizeMac(` ${mac('5F', '')} `)).to.equal(mac('5F'));
        });
        it('rejects invalid values', () => {
            expect(normalizeMac(mac('5F').slice(0, 14))).to.equal(null);
            expect(normalizeMac(mac('5G'))).to.equal(null);
            expect(normalizeMac(undefined)).to.equal(null);
            expect(normalizeMac(42)).to.equal(null);
        });
    });

    it('converts MAC and ESPHome address both ways', () => {
        const n = macToNumber(mac('5F'));
        expect(n).to.equal(0x0a1b2c3d4e5f);
        expect(numberToMac(n)).to.equal(mac('5F'));
        expect(numberToMac(0xab)).to.equal(['00', '00', '00', '00', '00', 'AB'].join(':'));
    });

    it('builds object IDs from names', () => {
        expect(toObjectId('Lüfter', 'fan')).to.equal('luefter');
        expect(toObjectId('  Dosierpumpe  Dünger ', 'doser')).to.equal('dosierpumpe_duenger');
        expect(toObjectId('Größe', 'x')).to.equal('groesse');
        expect(toObjectId('***', 'co2')).to.equal('co2');
        expect(toObjectId('Café', 'x')).to.equal('cafe');
    });

    describe('parseDevices', () => {
        it('returns nothing for a missing table', () => {
            expect(parseDevices(undefined)).to.deep.equal({ devices: [], errors: [] });
            expect(parseDevices('x')).to.deep.equal({ devices: [], errors: [] });
        });

        it('validates rows and keeps the valid ones', () => {
            const r = parseDevices([
                { name: 'Lampe', type: 'light', mac: mac('01').toLowerCase() },
                { name: 'Lüfter', type: 'fan', mac: mac('02', ''), seasonal: true },
                { name: 'Falsch', type: 'light', mac: 'nope' },
                { name: 'Typ', type: 'heater', mac: mac('03') },
                { name: 'Doppelt', type: 'doser', mac: mac('01') },
                null,
            ]);
            expect(r.devices.map(d => d.id)).to.deep.equal(['lampe', 'luefter']);
            expect(r.devices[0]).to.include({ type: 'light', mac: mac('01'), seasonal: false });
            expect(r.devices[1]).to.include({ seasonal: true, macNum: 0x0a1b2c3d4e02 });
            expect(r.errors).to.have.length(4);
            expect(r.errors[0]).to.match(/row 3: invalid MAC/);
            expect(r.errors[1]).to.match(/row 4: unknown device type "heater"/);
            expect(r.errors[2]).to.equal(`device row 5: MAC ${mac('01')} is configured twice`);
            expect(r.errors[3]).to.match(/row 6: invalid MAC/);
        });

        it('makes IDs unique and falls back to the type as name', () => {
            const r = parseDevices([
                { name: 'Pumpe', type: 'doser', mac: mac('11') },
                { name: 'Pumpe', type: 'doser', mac: mac('12') },
                { name: '', type: 'co2', mac: mac('13') },
            ]);
            expect(r.devices.map(d => d.id)).to.deep.equal(['pumpe', 'pumpe_2', 'co2']);
            expect(r.devices[2].name).to.equal('co2');
        });
    });

    it('decides reachability from the last advertisement', () => {
        expect(isReachable(undefined, 1000, 300)).to.equal(false);
        expect(isReachable(800, 1000, 300)).to.equal(true);
        expect(isReachable(700, 1000, 300)).to.equal(true);
        expect(isReachable(699, 1000, 300)).to.equal(false);
    });

    describe('decideReachable', () => {
        const T = 300;
        it('keeps the previous value while the proxy is down', () => {
            expect(decideReachable(undefined, 10_000, T, undefined, undefined)).to.equal(undefined);
            expect(decideReachable(100, 10_000, T, undefined, true)).to.equal(true);
        });
        it('does not report a device missing right after (re)connecting', () => {
            // started at 1000, never heard yet: undecided during the first timeout
            expect(decideReachable(undefined, 1200, T, 1000, undefined)).to.equal(undefined);
            // proxy was down for long, device was reachable before: keep it during the grace time
            expect(decideReachable(100, 1200, T, 1000, true)).to.equal(true);
        });
        it('decides after the grace time', () => {
            expect(decideReachable(undefined, 1300, T, 1000, undefined)).to.equal(false);
            expect(decideReachable(100, 1300, T, 1000, true)).to.equal(false);
        });
        it('reports a heard device at once', () => {
            expect(decideReachable(1100, 1200, T, 1000, undefined)).to.equal(true);
            expect(decideReachable(1100, 1200, T, 1000, false)).to.equal(true);
        });
    });

    it('warns only for missing devices that are not seasonal', () => {
        expect(presenceLogLevel({ seasonal: false }, false)).to.equal('warn');
        expect(presenceLogLevel({ seasonal: true }, false)).to.equal('info');
        expect(presenceLogLevel({ seasonal: false }, true)).to.equal('info');
    });
});
