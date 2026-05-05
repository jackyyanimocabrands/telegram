import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type { Request, Response, NextFunction } from 'express';
import { verifyManagerWebhookSecret, verifyChildWebhookSecret } from '../../src/middleware/webhook-secret.js';

function makeReq(secret?: string, botId?: string): Partial<Request> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret;
  return { headers, ip: '127.0.0.1', params: { botId } } as any;
}

describe('webhook-secret middleware', () => {
  let next: sinon.SinonStub;

  beforeEach(() => {
    next = sinon.stub();
  });

  afterEach(() => sinon.restore());

  describe('verifyManagerWebhookSecret', () => {
    it('calls next() with no error for correct secret', () => {
      const req = makeReq('test-webhook-secret-32-chars-long-ok');
      verifyManagerWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });

    it('calls next(ForbiddenError) for wrong secret', () => {
      const req = makeReq('wrong-secret');
      verifyManagerWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it('calls next(ForbiddenError) when header is missing', () => {
      const req = makeReq(undefined);
      verifyManagerWebhookSecret(req as Request, {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    it('calls next(ForbiddenError) for empty string secret', () => {
      const req = makeReq('');
      verifyManagerWebhookSecret(req as Request, {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });
  });

  describe('verifyChildWebhookSecret', () => {
    it('calls next() with no error for correct child secret', () => {
      const req = makeReq('child-webhook-secret-32-chars-ok-x', '123');
      verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });

    it('calls next(ForbiddenError) for wrong child secret', () => {
      const req = makeReq('wrong', '123');
      verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });
  });
});
