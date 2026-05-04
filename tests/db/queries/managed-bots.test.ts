import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../../src/db/client.js';
import {
  findManagedBotByBotId,
  findAllActiveManagedBots,
  savePollingOffset,
  activateManagedBot,
  upsertManagedBot,
  updateManagedBotStatus,
} from '../../../src/db/queries/managed-bots.js';

describe('managed-bots queries', () => {
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    queryStub = sinon.stub(pool, 'query');
  });

  afterEach(() => sinon.restore());

  describe('findManagedBotByBotId', () => {
    it('returns the bot row when found', async () => {
      const row = { bot_id: 42, status: 'ACTIVE' };
      queryStub.resolves({ rows: [row] });
      const result = await findManagedBotByBotId(42);
      expect(result).to.deep.equal(row);
    });

    it('returns null when not found', async () => {
      queryStub.resolves({ rows: [] });
      const result = await findManagedBotByBotId(42);
      expect(result).to.be.null;
    });
  });

  describe('findAllActiveManagedBots', () => {
    it('returns all rows', async () => {
      const rows = [{ bot_id: 1 }, { bot_id: 2 }];
      queryStub.resolves({ rows });
      const result = await findAllActiveManagedBots();
      expect(result).to.deep.equal(rows);
    });

    it('returns empty array when no active bots', async () => {
      queryStub.resolves({ rows: [] });
      const result = await findAllActiveManagedBots();
      expect(result).to.deep.equal([]);
    });
  });

  describe('savePollingOffset', () => {
    it('executes UPDATE with correct botId and offset', async () => {
      queryStub.resolves({ rows: [] });
      await savePollingOffset(42, 100);
      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('UPDATE managed_bots');
      expect(params).to.include(100);
      expect(params).to.include(42);
    });
  });

  describe('activateManagedBot', () => {
    it('executes UPDATE with ACTIVE status', async () => {
      queryStub.resolves({ rows: [] });
      await activateManagedBot(42);
      expect(queryStub.calledOnce).to.be.true;
      const [sql] = queryStub.firstCall.args;
      expect(sql).to.include('ACTIVE');
    });

    it('includes update_mode in query when provided', async () => {
      queryStub.resolves({ rows: [] });
      await activateManagedBot(42, 'polling');
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('update_mode');
      expect(params).to.include('polling');
    });
  });

  describe('updateManagedBotStatus', () => {
    it('executes UPDATE with the given status', async () => {
      queryStub.resolves({ rows: [] });
      await updateManagedBotStatus(42, 'DEACTIVATED');
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('UPDATE managed_bots');
      expect(params).to.include('DEACTIVATED');
    });
  });

  describe('upsertManagedBot', () => {
    it('returns the upserted row', async () => {
      const row = { bot_id: 42, status: 'PENDING' };
      queryStub.resolves({ rows: [row] });
      const result = await upsertManagedBot({
        botId: 42,
        ownerTelegramId: 1,
        ownerUserId: 1,
        encryptedToken: Buffer.alloc(0),
        tokenIv: Buffer.alloc(0),
        tokenKeyVersion: 1,
        status: 'PENDING',
      });
      expect(result).to.deep.equal(row);
    });
  });
});
