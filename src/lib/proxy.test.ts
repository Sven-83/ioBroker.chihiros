import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import {
    type ApiConnection,
    backoffDelay,
    parseAdvertisements,
    ProxyClient,
    SILENCE_RECONNECT_MS,
    SILENCE_RESUBSCRIBE_MS,
} from './proxy';

class FakeConnection extends EventEmitter implements ApiConnection {
    public connects = 0;
    public disconnects = 0;
    public subscribes = 0;
    public connect(): void {
        this.connects++;
    }
    public disconnect(): void {
        this.disconnects++;
    }
    public deviceInfoService(): Promise<{ name: string; esphomeVersion: string }> {
        return Promise.resolve({ name: 'proxy-1', esphomeVersion: '2026.10.2' });
    }
    public subscribeBluetoothAdvertisementService(): void {
        this.subscribes++;
    }
}

/** Manual clock with timers */
class Clock {
    public t = 0;
    private timers: Array<{ at: number; cb: () => void; id: number }> = [];
    private next = 1;
    public setTimeout = (cb: () => void, ms: number): unknown => {
        const id = this.next++;
        this.timers.push({ at: this.t + ms, cb, id });
        return id;
    };
    public clearTimeout = (h: unknown): void => {
        this.timers = this.timers.filter(x => x.id !== h);
    };
    public now = (): number => this.t;
    public advance(ms: number): void {
        const end = this.t + ms;
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at);
            const first = this.timers[0];
            if (!first || first.at > end) {
                break;
            }
            this.timers.shift();
            this.t = first.at;
            first.cb();
        }
        this.t = end;
    }
}

const silentLog = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };
const flush = (): Promise<void> => new Promise(r => setImmediate(r));

function setup(): { clock: Clock; conns: FakeConnection[]; client: ProxyClient; events: string[] } {
    const clock = new Clock();
    const conns: FakeConnection[] = [];
    const events: string[] = [];
    const client = new ProxyClient(
        { host: 'p', port: 6053, encryptionKey: 'k' },
        () => {
            const c = new FakeConnection();
            conns.push(c);
            return c;
        },
        clock,
        silentLog,
    );
    client.on('up', () => events.push('up'));
    client.on('down', () => events.push('down'));
    return { clock, conns, client, events };
}

describe('proxy', () => {
    it('backs off exponentially up to 5 minutes', () => {
        expect(backoffDelay(1)).to.equal(5_000);
        expect(backoffDelay(2)).to.equal(10_000);
        expect(backoffDelay(4)).to.equal(40_000);
        expect(backoffDelay(20)).to.equal(300_000);
    });

    it('parses advertisements and skips broken entries', () => {
        expect(parseAdvertisements(undefined)).to.deep.equal([]);
        const list = parseAdvertisements({
            advertisementsList: [
                { address: 0x0a1b2c3d4e01, rssi: -63, name: 'DYNFAN' },
                { address: 0x0a1b2c3d4e02, rssi: -47 },
                { address: 'x', rssi: -50 },
                { address: 0, rssi: -50 },
                null,
            ],
        });
        expect(list).to.deep.equal([
            { address: 0x0a1b2c3d4e01, rssi: -63, name: 'DYNFAN' },
            { address: 0x0a1b2c3d4e02, rssi: -47, name: '' },
        ]);
    });

    it('subscribes after authorization and forwards advertisements', async () => {
        const { conns, client, events } = setup();
        const advs: number[] = [];
        client.on('advertisement', (a: { address: number }) => advs.push(a.address));
        client.start();
        expect(conns).to.have.length(1);
        conns[0].emit('authorized');
        await flush();
        expect(client.isUp).to.equal(true);
        expect(events).to.deep.equal(['up']);
        expect(conns[0].subscribes).to.equal(1);
        conns[0].emit('message.BluetoothLERawAdvertisementsResponse', {
            advertisementsList: [{ address: 5, rssi: -40 }],
        });
        expect(advs).to.deep.equal([5]);
        client.stop();
        expect(events).to.deep.equal(['up', 'down']);
    });

    it('reconnects with backoff after an error', async () => {
        const { clock, conns, client, events } = setup();
        client.start();
        conns[0].emit('authorized');
        await flush();
        conns[0].emit('error', new Error('read ECONNRESET'));
        expect(events).to.deep.equal(['up', 'down']);
        expect(conns[0].disconnects).to.equal(1);
        clock.advance(4_999);
        expect(conns).to.have.length(1);
        clock.advance(1);
        expect(conns).to.have.length(2);
        // second failure doubles the delay
        conns[1].emit('disconnected');
        clock.advance(9_999);
        expect(conns).to.have.length(2);
        clock.advance(1);
        expect(conns).to.have.length(3);
        client.stop();
    });

    it('gives up waiting for authorization after a timeout', () => {
        const { clock, conns, client } = setup();
        client.start();
        clock.advance(20_000);
        expect(conns[0].disconnects).to.equal(1);
        clock.advance(5_000);
        expect(conns).to.have.length(2);
        client.stop();
    });

    it('subscribes again when advertisements stop, then reconnects', async () => {
        const { clock, conns, client, events } = setup();
        client.start();
        conns[0].emit('authorized');
        await flush();
        clock.advance(SILENCE_RESUBSCRIBE_MS + 10_000);
        expect(conns[0].subscribes).to.equal(2);
        expect(events).to.deep.equal(['up']);
        clock.advance(SILENCE_RECONNECT_MS);
        expect(events).to.deep.equal(['up', 'down']);
        expect(conns[0].disconnects).to.equal(1);
        client.stop();
    });

    it('keeps running while advertisements arrive', async () => {
        const { clock, conns, client, events } = setup();
        client.start();
        conns[0].emit('authorized');
        await flush();
        for (let i = 0; i < 30; i++) {
            clock.advance(10_000);
            conns[0].emit('message.BluetoothLERawAdvertisementsResponse', { advertisementsList: [] });
        }
        expect(conns[0].subscribes).to.equal(1);
        expect(events).to.deep.equal(['up']);
        client.stop();
    });

    it('ignores events of an old connection', async () => {
        const { clock, conns, client, events } = setup();
        client.start();
        conns[0].emit('error', new Error('boom'));
        clock.advance(5_000);
        conns[0].emit('authorized');
        await flush();
        expect(client.isUp).to.equal(false);
        conns[1].emit('authorized');
        await flush();
        expect(events).to.deep.equal(['up']);
        client.stop();
    });
});
