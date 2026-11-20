import { expect } from 'chai';
import { readChannels, readStates, resultToStates } from './states';

describe('states', () => {
    it('defines read states per type', () => {
        expect(readStates('doser')).to.have.length(16);
        expect(readStates('doser')[0].id).to.equal('pump1.total');
        expect(readStates('fan').map(s => s.id)).to.deep.equal(['waterTemp', 'roomTemp', 'humidity']);
        expect(readStates('doctor').map(s => s.id)).to.deep.equal(['waterTemp']);
        expect(readStates('light').map(s => s.id)).to.include('scheduledLevel');
        expect(readStates('co2')).to.deep.equal([]);
        expect(readChannels('doser').map(c => c.id)).to.deep.equal(['pump1', 'pump2', 'pump3', 'pump4']);
        expect(readChannels('fan')).to.deep.equal([]);
    });

    it('maps results to state values', () => {
        const now = new Date(2026, 10, 17, 14, 30);
        expect(resultToStates({ doserTotal: [0, 360.2, 730, 0], doserToday: [0, 0, 10, 0] }, now)).to.deep.equal({
            'pump1.total': 0,
            'pump2.total': 360.2,
            'pump3.total': 730,
            'pump4.total': 0,
            'pump1.today': 0,
            'pump2.today': 0,
            'pump3.today': 10,
            'pump4.today': 0,
        });
        expect(resultToStates({ live: { waterTemp: 22 } }, now)).to.deep.equal({ waterTemp: 22 });
        const light = resultToStates(
            {
                light: {
                    clockMinute: 14 * 60 + 29,
                    points: [
                        { minute: 14 * 60, level: 0 },
                        { minute: 14 * 60 + 1, level: 133 },
                        { minute: 19 * 60 + 59, level: 133 },
                        { minute: 20 * 60, level: 0 },
                    ],
                },
            },
            now,
        );
        expect(light).to.deep.equal({
            clock: '14:29',
            clockDeviation: -1,
            schedule: '14:00-20:00',
            sunrise: 1,
            sunset: 1,
            schedulePoints:
                '[{"time":"14:00","level":0},{"time":"14:01","level":133},{"time":"19:59","level":133},{"time":"20:00","level":0}]',
            scheduledLevel: 133,
        });
        expect(resultToStates({}, now)).to.deep.equal({});
    });
});
