import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { findUart, type GattApi, type GattService, runSession, SessionError, uuidString } from './gatt';

const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_W = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_N = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const ADDR = 0x0a1b2c3d4e01;

const SERVICES: GattService[] = [
    { shortUuid: 0x1800, characteristicsList: [{ shortUuid: 0x2a00, handle: 3 }] },
    {
        uuid: NUS,
        characteristicsList: [
            { uuid: NUS_W, handle: 16 },
            { uuid: NUS_N, handle: 18, descriptorsList: [{ shortUuid: 0x2902, handle: 19 }] },
        ],
    },
];

class FakeGatt extends EventEmitter implements GattApi {
    public connectResults: Array<{ connected: boolean; error?: number }> = [{ connected: true }];
    public writes: number[][] = [];
    public disconnects = 0;
    /** Answers sent as notification after each write */
    public reply: (frame: number[]) => number[][] = () => [];

    public connectBluetoothDeviceService(): Promise<{ connected: boolean; error?: number }> {
        return Promise.resolve(this.connectResults.shift() ?? { connected: false, error: 133 });
    }
    public disconnectBluetoothDeviceService(): Promise<unknown> {
        this.disconnects++;
        return Promise.resolve();
    }
    public listBluetoothGATTServicesService(): Promise<{ servicesList: GattService[] }> {
        return Promise.resolve({ servicesList: SERVICES });
    }
    public notifyBluetoothGATTCharacteristicService(): Promise<unknown> {
        return Promise.resolve();
    }
    public writeBluetoothGATTDescriptorService(): Promise<unknown> {
        return Promise.resolve();
    }
    public writeBluetoothGATTCharacteristicService(_a: number, _h: number, value: Uint8Array): Promise<unknown> {
        const f = Array.from(value);
        this.writes.push(f);
        for (const r of this.reply(f)) {
            setImmediate(() =>
                this.emit('message.BluetoothGATTNotifyDataResponse', {
                    address: ADDR,
                    handle: 18,
                    data: Buffer.from(r).toString('base64'),
                }),
            );
        }
        return Promise.resolve();
    }
}

const scheduler = {
    setTimeout: (cb: () => void, ms: number): unknown => setTimeout(cb, ms),
    clearTimeout: (h: unknown): void => clearTimeout(h as NodeJS.Timeout),
    now: (): number => Date.now(),
};

const INFO = [0x5b, 0x03, 0x0a, 0x00, 0x01, 0x0a, 0x01, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x03];
const opts = {
    address: ADDR,
    addressType: 0,
    frames: [Uint8Array.from([0x5a, 0x01, 0x06, 0x00, 0x01, 0x04, 0x01, 0x03])],
    isDone: (a: Array<{ type: number }>): boolean => a.some(x => x.type === 0x0a),
    timeoutMs: 300,
    gapMs: 1,
    attempts: 2,
};

describe('gatt', () => {
    it('reads UUIDs in all library encodings', () => {
        expect(uuidString({ uuid: NUS_W.toUpperCase() })).to.equal(NUS_W);
        expect(uuidString({ shortUuid: 0x2902 })).to.equal('00002902-0000-1000-8000-00805f9b34fb');
        // 128-bit UUID as two signed 64-bit numbers (as strings)
        const hi = BigInt.asIntN(64, BigInt('0x6e400003b5a3f393')).toString();
        const lo = BigInt.asIntN(64, BigInt('0xe0a9e50e24dcca9e')).toString();
        expect(uuidString({ uuidList: [hi, lo] })).to.equal(NUS_N);
        expect(uuidString({})).to.equal('');
    });

    it('finds the Nordic UART handles', () => {
        expect(findUart(SERVICES)).to.deep.equal({ write: 16, notify: 18, cccd: 19 });
        expect(findUart([SERVICES[0]])).to.equal(null);
    });

    it('sends the frames, collects the answer and disconnects', async () => {
        const api = new FakeGatt();
        api.reply = () => [INFO];
        const answers = await runSession(api, opts, scheduler);
        expect(answers.map(a => a.type)).to.deep.equal([0x0a]);
        expect(api.writes).to.deep.equal([[0x5a, 0x01, 0x06, 0x00, 0x01, 0x04, 0x01, 0x03]]);
        expect(api.disconnects).to.equal(1);
        expect(api.listenerCount('message.BluetoothGATTNotifyDataResponse')).to.equal(0);
    });

    it('retries the connection once', async () => {
        const api = new FakeGatt();
        api.connectResults = [{ connected: false, error: 133 }, { connected: true }];
        api.reply = () => [INFO];
        await runSession(api, opts, scheduler);
        expect(api.writes).to.have.length(1);
    });

    it('reports a refused connection as busy', async () => {
        const api = new FakeGatt();
        api.connectResults = [];
        try {
            await runSession(api, opts, scheduler);
            expect.fail('no error');
        } catch (e) {
            expect(e).to.be.instanceOf(SessionError);
            expect((e as SessionError).busy).to.equal(true);
            expect((e as Error).message).to.match(/error 133/);
        }
        expect(api.writes).to.have.length(0);
    });

    it('fails on a missing answer but still disconnects', async () => {
        const api = new FakeGatt();
        try {
            await runSession(api, opts, scheduler);
            expect.fail('no error');
        } catch (e) {
            expect((e as SessionError).busy).to.equal(false);
            expect((e as Error).message).to.match(/incomplete answer/);
        }
        expect(api.disconnects).to.equal(1);
    });

    it('ignores notifications of other devices and handles', async () => {
        const api = new FakeGatt();
        api.reply = () => [];
        const p = runSession(api, opts, scheduler);
        setTimeout(() => {
            api.emit('message.BluetoothGATTNotifyDataResponse', { address: ADDR + 1, handle: 18, data: INFO });
            api.emit('message.BluetoothGATTNotifyDataResponse', { address: ADDR, handle: 17, data: INFO });
            api.emit('message.BluetoothGATTNotifyDataResponse', { address: ADDR, handle: 18, data: INFO });
        }, 20);
        const answers = await p;
        expect(answers).to.have.length(1);
    });
});
