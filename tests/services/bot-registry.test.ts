import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { Update } from '../../src/types/telegram.js';
import { MockTelegramClient } from '../mocks/telegram-client.js';

describe('BotRegistry', () => {
  let BotRegistry: any;
  let mockTelegram: MockTelegramClient;
  let getAppStateStub: sinon.SinonStub;
  let setAppStateStub: sinon.SinonStub;
  let savePollingOffsetStub: sinon.SinonStub;
  let findManagedBotByBotIdStub: sinon.SinonStub;

  beforeEach(async () => {
    mockTelegram = new MockTelegramClient();
    // Default: getUpdates resolves to [] immediately
    mockTelegram.getUpdates.resolves([]);
    getAppStateStub = sinon.stub().resolves(null);
    setAppStateStub = sinon.stub().resolves();
    savePollingOffsetStub = sinon.stub().resolves();
    findManagedBotByBotIdStub = sinon.stub().resolves(null);

    // Use the esmock module for BotRegistry so DB stubs are applied.
    // Do NOT include telegram-api.js — BotRegistry gets TelegramClient via
    // constructor injection (mockTelegram), not via esmock.
    const module = await esmock('../../src/services/bot-registry.ts', {
      '../../src/db/queries/app-state.js': {
        getAppState: getAppStateStub,
        setAppState: setAppStateStub,
      },
      '../../src/db/queries/managed-bots.js': {
        savePollingOffset: savePollingOffsetStub,
        findManagedBotByBotId: findManagedBotByBotIdStub,
      },
    });
    BotRegistry = module.BotRegistry;
  });

  afterEach(async () => {
    // Only reset call history — do NOT restore() stubs that are still referenced
    // by the esmock module. sinon.restore() would un-stub the functions that
    // esmock captured by reference, breaking subsequent tests in the same file.
    sinon.resetHistory();
    await esmock.purge();
  });

  describe('registerBot', () => {
    it('registers a bot and stores it internally', () => {
      const registry = new BotRegistry(mockTelegram, 100);
      const handler = sinon.stub().resolves();
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: ['message'], handler, webhookUrl: 'http://x', webhookSecret: 'sec' });
      // no error thrown = success
    });
  });

  describe('start() — webhook mode', () => {
    it('calls setWebhook for each webhook-mode bot', async () => {
      mockTelegram.whenSetWebhook(true);
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({
        botId: 'manager',
        token: 'tok',
        updateMode: 'webhook',
        allowedUpdates: ['message'],
        handler: sinon.stub().resolves(),
        webhookUrl: 'http://example.com/webhook',
        webhookSecret: 'mysecret',
      });
      await registry.start();
      expect(mockTelegram.setWebhook.calledOnce).to.be.true;
      expect(mockTelegram.setWebhook.firstCall.args[1]).to.equal('http://example.com/webhook');
    });

    it('is idempotent — calling start() twice only wires bots once', async () => {
      mockTelegram.whenSetWebhook(true);
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler: sinon.stub().resolves(), webhookUrl: 'http://x', webhookSecret: 's' });
      await registry.start();
      await registry.start();
      expect(mockTelegram.setWebhook.callCount).to.equal(1);
    });

    it('logs error and continues if setWebhook throws', async () => {
      mockTelegram.setWebhook.rejects(new Error('network'));
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler: sinon.stub().resolves(), webhookUrl: 'http://x', webhookSecret: 's' });
      // Should not throw — just log the error
      let threw = false;
      try {
        await registry.start();
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
    });

    it('logs error if webhookUrl is missing in webhook mode', async () => {
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler: sinon.stub().resolves() });
      let threw = false;
      try {
        await registry.start();
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
      expect(mockTelegram.setWebhook.called).to.be.false;
    });
  });

  describe('start() — polling mode', () => {
    it('calls deleteWebhook before polling', async () => {
      // getUpdates resolves empty immediately, then hangs
      let callCount = 0;
      mockTelegram.getUpdates.callsFake(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([]);
        return new Promise(() => {});
      });

      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 'manager', token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler: sinon.stub().resolves() });
      await registry.start();
      // Give loop time to start
      await new Promise(r => setTimeout(r, 50));
      expect(mockTelegram.deleteWebhook.calledOnce).to.be.true;
      await registry.stop();
    });

    it('loads persisted offset from appState for manager bot', async () => {
      getAppStateStub.resolves('42');
      mockTelegram.getUpdates.returns(new Promise(() => {})); // hang

      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 'manager', token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler: sinon.stub().resolves() });
      await registry.start();
      await new Promise(r => setTimeout(r, 50));
      expect(getAppStateStub.calledWith('manager_polling_offset')).to.be.true;
      await registry.stop();
    });

    it('Fix-10: loads persisted offset from DB for hot-registered child bot', async () => {
      findManagedBotByBotIdStub.resolves({ polling_offset: 500 });
      mockTelegram.getUpdates.returns(new Promise(() => {})); // hang

      const registry = new BotRegistry(mockTelegram, 100);
      await registry.start(); // start with no bots registered
      registry.registerBot({ botId: 99, token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler: sinon.stub().resolves() });
      await new Promise(r => setTimeout(r, 100)); // let wireBot complete

      expect(findManagedBotByBotIdStub.calledWith(99)).to.be.true;
      // getUpdates should have been called with offset=500
      expect(mockTelegram.getUpdates.calledOnce).to.be.true;
      expect(mockTelegram.getUpdates.firstCall.args[1]).to.equal(500);
      await registry.stop();
    });
  });

  describe('dispatch()', () => {
    it('calls the registered handler with the update', async () => {
      const handler = sinon.stub().resolves();
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler, webhookUrl: 'http://x', webhookSecret: 's' });
      const update: Update = { update_id: 100, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 } };
      await registry.dispatch(1, update);
      expect(handler.calledOnce).to.be.true;
      expect(handler.firstCall.args[0]).to.deep.equal(update);
    });

    it('does nothing (no throw) when no handler is registered for botId', async () => {
      const registry = new BotRegistry(mockTelegram, 100);
      const update: Update = { update_id: 1 };
      let threw = false;
      try {
        await registry.dispatch(999, update);
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
    });

    it('swallows handler errors (does not propagate)', async () => {
      const handler = sinon.stub().rejects(new Error('handler error'));
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler, webhookUrl: 'http://x', webhookSecret: 's' });
      const update: Update = { update_id: 1 };
      let threw = false;
      try {
        await registry.dispatch(1, update);
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
    });
  });

  describe('stop()', () => {
    it('resolves cleanly when no polling bots are running', async () => {
      const registry = new BotRegistry(mockTelegram, 100);
      let threw = false;
      try {
        await registry.stop();
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
    });

    it('stops polling loops and pollingActive becomes false', async () => {
      // Make getUpdates hang indefinitely until aborted
      mockTelegram.getUpdates.callsFake((_tok: string, _off: number, _timeout: number, _allowed: string[], signal: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
        });
      });

      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 'manager', token: 'tok', updateMode: 'polling', allowedUpdates: [], handler: sinon.stub().resolves() });
      await registry.start();
      await new Promise(r => setTimeout(r, 50)); // let loop start
      await registry.stop();
      // Should complete without hanging
    });
  });

  describe('hot registration after start()', () => {
    it('immediately wires a bot registered after start()', async () => {
      mockTelegram.whenSetWebhook(true);
      const registry = new BotRegistry(mockTelegram, 100);
      await registry.start();
      registry.registerBot({ botId: 5, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler: sinon.stub().resolves(), webhookUrl: 'http://x', webhookSecret: 's' });
      await new Promise(r => setTimeout(r, 50));
      expect(mockTelegram.setWebhook.calledOnce).to.be.true;
    });
  });

  describe('polling — offset persistence', () => {
    it('persists offset to appState after processing manager update', async () => {
      const update: Update = { update_id: 10, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 } };
      let callCount = 0;
      mockTelegram.getUpdates.callsFake(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([update]);
        return new Promise(() => {}); // hang after first batch
      });

      const handler = sinon.stub().resolves();
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 'manager', token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler });
      await registry.start();
      await new Promise(r => setTimeout(r, 100));
      expect(setAppStateStub.calledWith('manager_polling_offset', '11')).to.be.true;
      await registry.stop();
    });

    it('persists offset to managed_bots table for child bots', async () => {
      const update: Update = { update_id: 55 };
      let callCount = 0;
      mockTelegram.getUpdates.callsFake(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([update]);
        return new Promise(() => {});
      });

      const handler = sinon.stub().resolves();
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 42, token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler });
      await registry.start();
      await new Promise(r => setTimeout(r, 100));
      expect(savePollingOffsetStub.calledWith(42, 56)).to.be.true;
      await registry.stop();
    });

    it('M-04: savePollingOffset called exactly ONCE per batch regardless of batch size', async () => {
      // Return a batch of 3 updates in the first call, then hang
      const updates: Update[] = [
        { update_id: 10 },
        { update_id: 11 },
        { update_id: 12 },
      ];
      let callCount = 0;
      mockTelegram.getUpdates.callsFake(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(updates);
        return new Promise(() => {}); // hang after first batch
      });

      const handler = sinon.stub().resolves();
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 77, token: 'tok', updateMode: 'polling', allowedUpdates: ['message'], handler });
      await registry.start();
      await new Promise(r => setTimeout(r, 100));

      // Should be called exactly once after the batch, with the final offset (12 + 1 = 13)
      expect(savePollingOffsetStub.callCount).to.equal(1);
      expect(savePollingOffsetStub.firstCall.args).to.deep.equal([77, 13]);
      await registry.stop();
    });

    it('M-04: savePollingOffset not called when batch is empty', async () => {
      let callCount = 0;
      mockTelegram.getUpdates.callsFake(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([]); // empty batch
        return new Promise(() => {});
      });

      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 88, token: 'tok', updateMode: 'polling', allowedUpdates: [], handler: sinon.stub().resolves() });
      await registry.start();
      await new Promise(r => setTimeout(r, 100));
      expect(savePollingOffsetStub.called).to.be.false;
      await registry.stop();
    });
  });

  describe('MI-07: Promise-based stop()', () => {
    it('stop() resolves after polling loop exits (does not busy-wait)', async () => {
      // Hang getUpdates until aborted
      mockTelegram.getUpdates.callsFake((_tok: string, _off: number, _timeout: number, _allowed: string[], signal: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));
        });
      });

      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 'manager', token: 'tok', updateMode: 'polling', allowedUpdates: [], handler: sinon.stub().resolves() });
      await registry.start();
      await new Promise(r => setTimeout(r, 30));

      const t0 = Date.now();
      await registry.stop();
      const elapsed = Date.now() - t0;

      // stop() should resolve quickly after abort — not wait 2000ms (old busy-wait max)
      expect(elapsed).to.be.lessThan(500);
    });

    it('stop() resolves cleanly with no polling bots', async () => {
      mockTelegram.whenSetWebhook(true);
      const registry = new BotRegistry(mockTelegram, 100);
      registry.registerBot({ botId: 1, token: 'tok', updateMode: 'webhook', allowedUpdates: [], handler: sinon.stub().resolves(), webhookUrl: 'http://x', webhookSecret: 's' });
      await registry.start();
      // No polling bots — should resolve immediately
      await registry.stop();
    });
  });
});
