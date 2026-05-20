import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('BotManagementApiClient', () => {
  let BotManagementApiClient: any;
  let fetchStub: sinon.SinonStub;
  let mod: any;

  const FAKE_ENV = {
    BOT_MGMT_API_URL: 'https://bot-mgmt.example.com',
    BOT_MGMT_API_KEY: 'test-bot-mgmt-api-key-32chars-xxxx',
  };

  beforeEach(async () => {
    fetchStub = sinon.stub(globalThis, 'fetch' as any);

    mod = await esmock('../../src/services/bot-management-api.ts', {
      '../../src/config/env.js': { env: FAKE_ENV },
    });
    BotManagementApiClient = mod.BotManagementApiClient;
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  // ── createBot ─────────────────────────────────────────────────────────────

  describe('createBot', () => {
    it('returns result on success', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ id: '123', name: 'MyBot' }),
      });

      const client = new BotManagementApiClient();
      const result = await client.createBot('user@example.com', { name: 'MyBot' });

      expect(result).to.deep.equal({ id: '123', name: 'MyBot' });
      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.equal(`${FAKE_ENV.BOT_MGMT_API_URL}/bots`);
      expect(options.method).to.equal('POST');
      expect(options.headers['Authorization']).to.equal(`Bearer ${FAKE_ENV.BOT_MGMT_API_KEY}`);
      expect(options.headers['X-User-Email']).to.equal('user@example.com');
    });

    it('throws with body error message on API error with body', async () => {
      fetchStub.resolves({
        ok: false,
        statusText: 'Conflict',
        json: async () => ({ error: 'Name taken' }),
      });

      const client = new BotManagementApiClient();
      let threw = false;
      try {
        await client.createBot('user@example.com', { name: 'Duplicate' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.equal('Name taken');
      }
      expect(threw).to.be.true;
    });

    it('throws with statusText when JSON body parse fails', async () => {
      fetchStub.resolves({
        ok: false,
        statusText: 'Conflict',
        json: async () => { throw new Error('invalid json'); },
      });

      const client = new BotManagementApiClient();
      let threw = false;
      try {
        await client.createBot('user@example.com', { name: 'Duplicate' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('Conflict');
      }
      expect(threw).to.be.true;
    });

    it('throws when BOT_MGMT_API_URL or BOT_MGMT_API_KEY is not configured', async () => {
      const unconfiguredMod = await esmock('../../src/services/bot-management-api.ts', {
        '../../src/config/env.js': { env: {} },
      });
      const UnconfiguredClient = unconfiguredMod.BotManagementApiClient;
      const client = new UnconfiguredClient();

      let threw = false;
      try {
        await client.createBot('user@example.com', { name: 'X' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('not configured');
      }
      expect(threw).to.be.true;

      await esmock.purge(unconfiguredMod);
      mod = undefined;
    });
  });

  // ── configureBot ──────────────────────────────────────────────────────────

  describe('configureBot', () => {
    it('returns result on success', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ id: 'bot-99', name: 'Updated Bot' }),
      });

      const client = new BotManagementApiClient();
      const result = await client.configureBot('user@example.com', 'bot-99', { name: 'Updated Bot' });

      expect(result).to.deep.equal({ id: 'bot-99', name: 'Updated Bot' });
      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.equal(`${FAKE_ENV.BOT_MGMT_API_URL}/bots/bot-99`);
      expect(options.method).to.equal('PATCH');
      expect(options.headers['Authorization']).to.equal(`Bearer ${FAKE_ENV.BOT_MGMT_API_KEY}`);
      expect(options.headers['X-User-Email']).to.equal('user@example.com');
    });

    it('throws with body error message on API error with body', async () => {
      fetchStub.resolves({
        ok: false,
        statusText: 'Forbidden',
        json: async () => ({ error: 'Insufficient permissions' }),
      });

      const client = new BotManagementApiClient();
      let threw = false;
      try {
        await client.configureBot('user@example.com', 'bot-99', { name: 'Updated Bot' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.equal('Insufficient permissions');
      }
      expect(threw).to.be.true;
    });

    it('throws with statusText when JSON body parse fails', async () => {
      fetchStub.resolves({
        ok: false,
        statusText: 'Internal Server Error',
        json: async () => { throw new Error('invalid json'); },
      });

      const client = new BotManagementApiClient();
      let threw = false;
      try {
        await client.configureBot('user@example.com', 'bot-99', { name: 'Updated Bot' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.include('Internal Server Error');
      }
      expect(threw).to.be.true;
    });
  });
});
