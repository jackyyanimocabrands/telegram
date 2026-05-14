import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import jwt from 'jsonwebtoken';
import { env } from '../../src/config/env.js';

const APP_ISSUER = 'hellominds-telegram-connector';

describe('email-verification service', () => {
  let signVerificationToken: (email: string, botId: string, userId: string) => string;
  let verifyVerificationToken: (token: string) => { email: string; botId: string; userId: string };
  let sendVerificationEmail: (email: string, botId: string, userId: string) => Promise<void>;

  let sendStub: sinon.SinonStub;
  let sesClientStub: { send: sinon.SinonStub };

  beforeEach(async () => {
    sendStub = sinon.stub().resolves({ MessageId: 'test-message-id' });
    sesClientStub = { send: sendStub };

    const mod = await esmock('../../src/services/email-verification.ts', {
      '@aws-sdk/client-ses': {
        SESClient: class {
          send(cmd: unknown) { return sesClientStub.send(cmd); }
        },
        SendEmailCommand: class {
          constructor(public input: unknown) {}
        },
      },
    });

    signVerificationToken = mod.signVerificationToken;
    verifyVerificationToken = mod.verifyVerificationToken;
    sendVerificationEmail = mod.sendVerificationEmail;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── signVerificationToken ────────────────────────────────────────────────

  describe('signVerificationToken', () => {
    it('returns a string JWT with three dot-separated parts', () => {
      const token = signVerificationToken('test@example.com', 'bot-123', 'user-456');
      expect(token).to.be.a('string');
      expect(token.split('.')).to.have.length(3);
    });

    it('encodes email, botId, userId, and purpose claims', () => {
      const token = signVerificationToken('foo@bar.com', 'botA', 'userB');
      const decoded = jwt.verify(token, env.ES256_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: APP_ISSUER,
        audience: APP_ISSUER,
      }) as jwt.JwtPayload;
      expect(decoded.email).to.equal('foo@bar.com');
      expect(decoded.botId).to.equal('botA');
      expect(decoded.userId).to.equal('userB');
      expect(decoded.purpose).to.equal('email-verification');
    });
  });

  // ── verifyVerificationToken ──────────────────────────────────────────────

  describe('verifyVerificationToken', () => {
    it('round-trips correctly — returns email, botId, userId', () => {
      const token = signVerificationToken('hello@example.com', 'bot-1', 'user-1');
      const payload = verifyVerificationToken(token);
      expect(payload.email).to.equal('hello@example.com');
      expect(payload.botId).to.equal('bot-1');
      expect(payload.userId).to.equal('user-1');
    });

    it('throws on a completely invalid token', () => {
      expect(() => verifyVerificationToken('not.a.jwt')).to.throw();
    });

    it('throws on an expired token', () => {
      // Sign with -1s TTL (already expired)
      const expiredToken = jwt.sign(
        { email: 'x@x.com', botId: 'b', userId: 'u', purpose: 'email-verification' },
        env.ES256_PRIVATE_KEY,
        { algorithm: 'ES256', expiresIn: -1, issuer: APP_ISSUER, audience: APP_ISSUER },
      );
      expect(() => verifyVerificationToken(expiredToken)).to.throw();
    });

    it('throws on wrong purpose claim', () => {
      // Sign with a different purpose
      const wrongPurposeToken = jwt.sign(
        { email: 'x@x.com', botId: 'b', userId: 'u', purpose: 'access' },
        env.ES256_PRIVATE_KEY,
        { algorithm: 'ES256', expiresIn: 900, issuer: APP_ISSUER, audience: APP_ISSUER },
      );
      expect(() => verifyVerificationToken(wrongPurposeToken)).to.throw(/purpose/i);
    });

    it('throws on missing purpose claim', () => {
      const noPurposeToken = jwt.sign(
        { email: 'x@x.com', botId: 'b', userId: 'u' },
        env.ES256_PRIVATE_KEY,
        { algorithm: 'ES256', expiresIn: 900, issuer: APP_ISSUER, audience: APP_ISSUER },
      );
      expect(() => verifyVerificationToken(noPurposeToken)).to.throw();
    });
  });

  // ── sendVerificationEmail ────────────────────────────────────────────────

  describe('sendVerificationEmail', () => {
    it('calls SES SendEmailCommand with correct To, From, and Subject', async () => {
      await sendVerificationEmail('recipient@example.com', 'bot-99', '12345');

      expect(sendStub.calledOnce).to.be.true;
      const cmd = sendStub.firstCall.args[0];
      expect(cmd.input.Destination.ToAddresses).to.deep.equal(['recipient@example.com']);
      expect(cmd.input.Source).to.equal(env.SES_FROM_ADDRESS);
      expect(cmd.input.Message.Subject.Data).to.equal('Verify your email');
    });

    it('embeds the verification link in both body variants', async () => {
      await sendVerificationEmail('link@example.com', 'bot-link', '99999');

      const cmd = sendStub.firstCall.args[0];
      const textBody: string = cmd.input.Message.Body.Text.Data;
      const htmlBody: string = cmd.input.Message.Body.Html.Data;

      expect(textBody).to.include(`${env.BASE_URL}/verify-email?token=`);
      expect(htmlBody).to.include(`${env.BASE_URL}/verify-email?token=`);
    });

    it('includes a valid verification token in the link that round-trips', async () => {
      await sendVerificationEmail('check@example.com', 'bot-check', '77777');

      const cmd = sendStub.firstCall.args[0];
      const textBody: string = cmd.input.Message.Body.Text.Data;
      const match = textBody.match(/token=([^\s\n]+)/);
      expect(match).to.not.be.null;
      const token = match![1];
      const payload = verifyVerificationToken(token);
      expect(payload.email).to.equal('check@example.com');
      expect(payload.botId).to.equal('bot-check');
      expect(payload.userId).to.equal('77777');
    });

    it('rejects when SES send throws', async () => {
      sendStub.rejects(new Error('SES throttled'));
      let threw = false;
      try {
        await sendVerificationEmail('fail@example.com', 'bot-fail', '111');
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('SES throttled');
      }
      expect(threw).to.be.true;
    });

    it('throws when SES_FROM_ADDRESS is absent', async () => {
      const mod = await esmock('../../src/services/email-verification.ts', {
        '@aws-sdk/client-ses': {
          SESClient: class {
            send(cmd: unknown) { return sesClientStub.send(cmd); }
          },
          SendEmailCommand: class {
            constructor(public input: unknown) {}
          },
        },
        '../../src/config/env.js': {
          env: { ...env, SES_FROM_ADDRESS: undefined },
        },
      });
      let threw = false;
      try {
        await mod.sendVerificationEmail('x@x.com', 'b', 'u');
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.match(/SES_FROM_ADDRESS/);
      }
      expect(threw).to.be.true;
    });
  });
});
