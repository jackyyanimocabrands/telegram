import { describe, it } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type { Redis } from 'ioredis';
import { checkManagerThrottle } from '../../src/services/conversation-throttle.js';

function makeFakeRedis(setResult: 'OK' | null, pttlResult: number): Redis {
  return {
    set: sinon.stub().resolves(setResult),
    pttl: sinon.stub().resolves(pttlResult),
  } as unknown as Redis;
}

describe('checkManagerThrottle', () => {
  it('returns allowed=true and retryAfterMs=0 when SET NX succeeds', async () => {
    const fakeRedis = makeFakeRedis('OK', 0);
    const result = await checkManagerThrottle(42, 5000, fakeRedis);
    expect(result.allowed).to.be.true;
    expect(result.retryAfterMs).to.equal(0);
  });

  it('returns allowed=false with PTTL retryAfterMs when SET NX fails', async () => {
    const fakeRedis = makeFakeRedis(null, 3142);
    const result = await checkManagerThrottle(42, 5000, fakeRedis);
    expect(result.allowed).to.be.false;
    expect(result.retryAfterMs).to.equal(3142);
  });

  it('falls back to windowMs when PTTL returns -1 (key just expired)', async () => {
    const fakeRedis = makeFakeRedis(null, -1);
    const result = await checkManagerThrottle(42, 5000, fakeRedis);
    expect(result.allowed).to.be.false;
    expect(result.retryAfterMs).to.equal(5000);
  });

  it('falls back to windowMs when PTTL returns -2 (key missing)', async () => {
    const fakeRedis = makeFakeRedis(null, -2);
    const result = await checkManagerThrottle(42, 5000, fakeRedis);
    expect(result.allowed).to.be.false;
    expect(result.retryAfterMs).to.equal(5000);
  });

  it('uses key format throttle:manager:{userId}', async () => {
    const fakeRedis = makeFakeRedis('OK', 0);
    await checkManagerThrottle(99, 5000, fakeRedis);
    const setStub = fakeRedis.set as unknown as sinon.SinonStub;
    expect(setStub.firstCall.args[0]).to.equal('throttle:manager:99');
  });

  it('passes PX and NX options to SET', async () => {
    const fakeRedis = makeFakeRedis('OK', 0);
    await checkManagerThrottle(42, 8000, fakeRedis);
    const setStub = fakeRedis.set as unknown as sinon.SinonStub;
    const args = setStub.firstCall.args;
    expect(args[2]).to.equal('PX');
    expect(args[3]).to.equal(8000);
    expect(args[4]).to.equal('NX');
  });

  it('does not call PTTL when SET NX succeeds (performance)', async () => {
    const fakeRedis = makeFakeRedis('OK', 0);
    await checkManagerThrottle(42, 5000, fakeRedis);
    const pttlStub = fakeRedis.pttl as unknown as sinon.SinonStub;
    expect(pttlStub.called).to.be.false;
  });

  it('propagates Redis errors to the caller', async () => {
    const fakeRedis = {
      set: sinon.stub().rejects(new Error('Redis ECONNREFUSED')),
      pttl: sinon.stub().resolves(0),
    } as unknown as Redis;
    let threw = false;
    try {
      await checkManagerThrottle(42, 5000, fakeRedis);
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.include('Redis ECONNREFUSED');
    }
    expect(threw).to.be.true;
  });
});
