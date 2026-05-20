import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../src/types/api.js';

const mockUser: AuthenticatedUser = { id: 1, telegramId: 123, firstName: 'Test' };

function makeReq(authHeader?: string): Request {
  return { headers: { authorization: authHeader }, ip: '127.0.0.1', path: '/test' } as any;
}

describe('auth middleware', () => {
  let next: sinon.SinonStub;
  let requireAuth: any;
  let optionalAuth: any;
  let verifyStub: sinon.SinonStub;
  let mod: any;

  beforeEach(async () => {
    next = sinon.stub();
    verifyStub = sinon.stub();

    mod = await esmock('../../src/middleware/auth.ts', {
      '../../src/services/session.js': {
        verifyAccessToken: verifyStub,
      },
    });
    requireAuth = mod.requireAuth;
    optionalAuth = mod.optionalAuth;
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  describe('requireAuth', () => {
    it('calls next(AuthenticationError) when Authorization header is missing', () => {
      requireAuth(makeReq(), {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it('calls next(AuthenticationError) when header does not start with Bearer', () => {
      requireAuth(makeReq('Basic token123'), {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it('sets req.user and calls next() for a valid token', () => {
      verifyStub.returns(mockUser);
      const req = makeReq('Bearer valid.jwt.token');
      requireAuth(req, {} as Response, next);
      expect((req as any).user).to.deep.equal(mockUser);
      expect(next.calledWith()).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });

    it('calls next(AuthenticationError) when verifyAccessToken throws', () => {
      verifyStub.throws(new Error('expired'));
      requireAuth(makeReq('Bearer bad.token'), {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });
  });

  describe('optionalAuth', () => {
    it('calls next() without setting req.user when no Authorization header', () => {
      const req = makeReq();
      optionalAuth(req, {} as Response, next);
      expect((req as any).user).to.be.undefined;
      expect(next.calledOnce).to.be.true;
    });

    it('sets req.user when token is valid', () => {
      verifyStub.returns(mockUser);
      const req = makeReq('Bearer good.token');
      optionalAuth(req, {} as Response, next);
      expect((req as any).user).to.deep.equal(mockUser);
      expect(next.calledOnce).to.be.true;
    });

    it('calls next() without error when token is invalid (graceful)', () => {
      verifyStub.throws(new Error('invalid'));
      const req = makeReq('Bearer bad.token');
      optionalAuth(req, {} as Response, next);
      expect((req as any).user).to.be.undefined;
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });
  });
});
