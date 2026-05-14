import { describe, it } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type { Redis } from 'ioredis';
import { acquireLock, releaseLock } from '../../src/services/conversation-lock.js';

function makeFakeRedis(setResult: 'OK' | null, delResult = 1): Redis {
  return {
    set: sinon.stub().resolves(setResult),
    del: sinon.stub().resolves(delResult),
  } as unknown as Redis;
}

describe('conversation-lock', () => {
  describe('acquireLock', () => {
    it('returns true when SET NX EX succeeds', async () => {
      const redis = makeFakeRedis('OK');
      expect(await acquireLock('manager:42', 60, redis)).to.be.true;
    });

    it('returns false when lock is already held', async () => {
      const redis = makeFakeRedis(null);
      expect(await acquireLock('manager:42', 60, redis)).to.be.false;
    });

    it('uses correct key format lock:{conversationId}', async () => {
      const redis = makeFakeRedis('OK');
      await acquireLock('child:7:42', 60, redis);
      const setStub = redis.set as unknown as sinon.SinonStub;
      expect(setStub.firstCall.args[0]).to.equal('lock:child:7:42');
    });

    it('passes NX and EX options to SET', async () => {
      const redis = makeFakeRedis('OK');
      await acquireLock('manager:42', 30, redis);
      const setStub = redis.set as unknown as sinon.SinonStub;
      const args = setStub.firstCall.args;
      expect(args[2]).to.equal('NX');
      expect(args[3]).to.equal('EX');
      expect(args[4]).to.equal(30);
    });
  });

  describe('releaseLock', () => {
    it('calls DEL with correct key', async () => {
      const redis = makeFakeRedis('OK');
      await releaseLock('manager:42', redis);
      const delStub = redis.del as unknown as sinon.SinonStub;
      expect(delStub.firstCall.args[0]).to.equal('lock:manager:42');
    });

    it('resolves even if DEL returns 0 (key already gone)', async () => {
      const redis = makeFakeRedis('OK', 0);
      let threw = false;
      try { await releaseLock('manager:42', redis); } catch { threw = true; }
      expect(threw).to.be.false;
    });
  });
});
