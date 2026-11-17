import { expect } from 'chai';
import {
    decodeAnswer,
    decodeDoctorLive,
    decodeDoserMl,
    decodeFanLive,
    decodeLightImage,
    encodeFrame,
    formatMinute,
    MessageIds,
    QUERY,
    scheduleLevel,
    scheduleWindows,
} from './protocol';

/**
 * Hex string "5b 01 ..." to bytes
 *
 * @param s Bytes as hex, separated by spaces
 */
const hex = (s: string): number[] => s.split(' ').map(x => parseInt(x, 16));

// answers captured from real devices on 17.11.2026 (no addresses inside)
const LIGHT_IMAGE = hex(
    '5b 17 30 00 01 fe 02 0e 00 0b 00 0e 00 00 00 0c 00 00 00 00 00 00 02 0e 00 0b 00 00 0b 01 85 0b 3b 85 0c 00 00 0e 00 00 0e 01 85 13 3b 85 14 00 00 00',
);
const DOSER_TOTAL = hex('5b 01 0a 00 01 1e 00 00 0e 12 1c 84 00 00 14');
const DOSER_TODAY = hex('5b 01 0a 00 01 22 00 00 00 00 00 64 00 00 28');
const DOCTOR_LIVE = hex('5b 04 0c 00 01 25 00 00 0b ff 00 d0 00 22');
const FAN_LIVE = hex('5b 09 0b 00 01 25 17 12 08 92 00 e1 22');
const FAN_LIVE_OFF = hex('5b 09 0b 00 01 25 00 00 00 00 00 dc 22');

describe('protocol', () => {
    it('encodes the status query exactly like the app', () => {
        const ids = new MessageIds();
        const [cmd, mode, params] = QUERY.status;
        expect(Array.from(encodeFrame(cmd, mode, params, ids.next()))).to.deep.equal(hex('5a 01 06 00 01 04 01 03'));
        const [c2, m2, p2] = QUERY.doserTotal;
        expect(Array.from(encodeFrame(c2, m2, p2, ids.next()))).to.deep.equal(hex('a5 01 06 00 02 04 04 05'));
        const [c3, m3, p3] = QUERY.doserToday;
        expect(Array.from(encodeFrame(c3, m3, p3, ids.next()))).to.deep.equal(hex('a5 01 06 00 03 04 05 05'));
    });

    it('skips 0x5a as low byte of the message ID and wraps', () => {
        const ids = new MessageIds();
        const seen: number[] = [];
        for (let i = 0; i < 300; i++) {
            const [hi, lo] = ids.next();
            expect(lo).not.to.equal(0x5a);
            seen.push(hi);
        }
        expect(Math.max(...seen)).to.equal(1);
    });

    it('rejects frames that are no answers', () => {
        expect(decodeAnswer([])).to.equal(null);
        expect(decodeAnswer(hex('5a 01 06 00 01 04 01 03'))).to.equal(null);
        expect(decodeAnswer(hex('5b 01 02'))).to.equal(null);
    });

    it('decodes dosed ml per pump', () => {
        expect(decodeDoserMl(decodeAnswer(DOSER_TOTAL)!)).to.deep.equal([0, 360.2, 730, 0]);
        expect(decodeDoserMl(decodeAnswer(DOSER_TODAY)!)).to.deep.equal([0, 0, 10, 0]);
        expect(decodeDoserMl(decodeAnswer(FAN_LIVE)!)).to.equal(null);
    });

    it('decodes the Doctor water temperature', () => {
        expect(decodeDoctorLive(decodeAnswer(DOCTOR_LIVE)!)).to.deep.equal({ waterTemp: 20.8 });
        expect(decodeDoctorLive(decodeAnswer(DOSER_TOTAL)!)).to.equal(null);
    });

    it('decodes the fan sensors', () => {
        expect(decodeFanLive(decodeAnswer(FAN_LIVE)!)).to.deep.equal({
            waterTemp: 22.5,
            humidity: 59.06,
            roomTemp: 21.94,
        });
        // switched-off fan: own sensor reports zeros, water temperature stays valid
        expect(decodeFanLive(decodeAnswer(FAN_LIVE_OFF)!)).to.deep.equal({ waterTemp: 22 });
    });

    describe('light', () => {
        const img = decodeLightImage(decodeAnswer(LIGHT_IMAGE)!)!;

        it('reads clock and schedule points', () => {
            expect(formatMinute(img.clockMinute)).to.equal('14:00');
            expect(img.points.map(p => `${formatMinute(p.minute)}=${p.level}`)).to.deep.equal([
                '11:00=0',
                '11:01=133',
                '11:59=133',
                '12:00=0',
                '14:00=0',
                '14:01=133',
                '19:59=133',
                '20:00=0',
            ]);
        });

        it('summarises the on windows', () => {
            expect(scheduleWindows(img.points)).to.equal('11:01-11:59, 14:01-19:59');
            expect(scheduleWindows([])).to.equal('');
            expect(scheduleWindows([{ minute: 600, level: 50 }])).to.equal('10:00-10:00');
        });

        it('computes the scheduled level including ramps', () => {
            expect(scheduleLevel(img.points, 10 * 60)).to.equal(0);
            expect(scheduleLevel(img.points, 11 * 60 + 30)).to.equal(133);
            expect(scheduleLevel(img.points, 13 * 60)).to.equal(0);
            expect(scheduleLevel(img.points, 14 * 60 + 1)).to.equal(133);
            expect(scheduleLevel(img.points, 21 * 60)).to.equal(0);
            expect(
                scheduleLevel(
                    [
                        { minute: 0, level: 0 },
                        { minute: 60, level: 100 },
                    ],
                    30,
                ),
            ).to.equal(50);
        });

        it('rejects other images', () => {
            expect(decodeLightImage(decodeAnswer(DOSER_TOTAL)!)).to.equal(null);
        });
    });
});
