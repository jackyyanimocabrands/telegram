import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { HttpTelegramClient } from '../../src/services/telegram-api.js';
import { TelegramApiError } from '../../src/utils/errors.js';

describe('HttpTelegramClient', () => {
  let client: HttpTelegramClient;
  let fetchStub: sinon.SinonStub;

  const MANAGER_TOKEN = 'test-manager-token-abc';
  const BOT_USER_ID = 987654321;

  beforeEach(() => {
    // Reset singleton so each test gets a clean instance
    (HttpTelegramClient as any)._instance = null;
    client = HttpTelegramClient.getInstance();
    fetchStub = sinon.stub(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    sinon.restore();
    (HttpTelegramClient as any)._instance = null;
  });

  describe('getManagedBotToken', () => {
    it('POSTs to /botTOKEN/getManagedBotToken with { user_id: botUserId } and returns the token string', async () => {
      const expectedToken = 'child-bot-token-xyz';

      fetchStub.resolves({
        json: async () => ({ ok: true, result: expectedToken }),
      });

      const result = await client.getManagedBotToken(MANAGER_TOKEN, BOT_USER_ID);

      expect(result).to.equal(expectedToken);
      expect(fetchStub.calledOnce).to.be.true;

      const [url, options] = fetchStub.firstCall.args as [string, RequestInit];
      expect(url).to.equal(`https://api.telegram.org/bot${MANAGER_TOKEN}/getManagedBotToken`);
      expect(options.method).to.equal('POST');
      expect(options.headers).to.deep.include({ 'Content-Type': 'application/json' });
      expect(JSON.parse(options.body as string)).to.deep.equal({ user_id: BOT_USER_ID });
    });

    it('throws TelegramApiError when the API returns ok=false', async () => {
      fetchStub.resolves({
        status: 403,
        json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot is not a member' }),
      });

      let thrown: unknown;
      try {
        await client.getManagedBotToken(MANAGER_TOKEN, BOT_USER_ID);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).to.be.instanceOf(TelegramApiError);
      const apiErr = thrown as TelegramApiError;
      expect(apiErr.telegramErrorCode).to.equal(403);
      expect(apiErr.telegramDescription).to.include('Forbidden');
    });
  });
});
