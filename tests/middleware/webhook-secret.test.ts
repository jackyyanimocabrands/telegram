import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { Request, Response, NextFunction } from 'express';

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

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── Manager webhook secret (sync, unchanged) ──────────────────────────────

  describe('verifyManagerWebhookSecret', () => {
    let verifyManagerWebhookSecret: (req: Request, res: Response, next: NextFunction) => void;

    beforeEach(async () => {
      // Load without stubbing token-store — manager middleware doesn't use it
      const mod = await esmock('../../src/middleware/webhook-secret.ts', {
        '../../src/services/token-store.js': {
          getBotWebhookSecretCached: sinon.stub().resolves(null),
        },
      });
      verifyManagerWebhookSecret = mod.verifyManagerWebhookSecret;
    });

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

  // ── Child webhook secret (async, per-bot lookup) ──────────────────────────

  describe('verifyChildWebhookSecret', () => {
    let verifyChildWebhookSecret: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    let getBotWebhookSecretCachedStub: sinon.SinonStub;

    const BOT_SECRET = 'per-bot-secret-hex-string-64-chars-aaaaaaaaaaaaaaaaaaaaaa1234567890';

    beforeEach(async () => {
      getBotWebhookSecretCachedStub = sinon.stub().resolves(BOT_SECRET);

      const mod = await esmock('../../src/middleware/webhook-secret.ts', {
        '../../src/services/token-store.js': {
          getBotWebhookSecretCached: getBotWebhookSecretCachedStub,
        },
      });
      verifyChildWebhookSecret = mod.verifyChildWebhookSecret;
    });

    // ── Per-bot secret from DB ──

    it('per-bot: calls next() with no error for correct bot secret', async () => {
      const req = makeReq(BOT_SECRET, '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });

    it('per-bot: calls next(ForbiddenError) for wrong secret when bot has a secret', async () => {
      const req = makeReq('wrong-secret', '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    // ── Fallback to env var ──

    it('fallback: uses env CHILD_WEBHOOK_SECRET when DB returns null', async () => {
      getBotWebhookSecretCachedStub.resolves(null);
      // CHILD_WEBHOOK_SECRET is set by the test .env to 'child-webhook-secret-32-chars-ok-x'
      const req = makeReq('child-webhook-secret-32-chars-ok-x', '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args).to.deep.equal([]);
    });

    it('fallback: calls next(ForbiddenError) when fallback secret is also wrong', async () => {
      getBotWebhookSecretCachedStub.resolves(null);
      const req = makeReq('totally-wrong', '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    // ── Missing header ──

    it('calls next(ForbiddenError) when secret header is missing', async () => {
      const req = makeReq(undefined, '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });

    // ── Cache hit ──

    it('cache: getBotWebhookSecretCached called once per request (spy check)', async () => {
      const req = makeReq(BOT_SECRET, '123');
      await verifyChildWebhookSecret(req as Request, {} as Response, next);
      expect(getBotWebhookSecretCachedStub.calledOnce).to.be.true;
    });
  });
});
