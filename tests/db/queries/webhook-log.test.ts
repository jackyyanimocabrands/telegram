import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../../src/db/client.js';
import { tryAcquireUpdate, markProcessed, markFailed } from '../../../src/db/queries/webhook-log.js';

describe('webhook-log queries', () => {
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    queryStub = sinon.stub(pool, 'query');
  });

  afterEach(() => sinon.restore());

  describe('tryAcquireUpdate', () => {
    it('returns the inserted row when acquired', async () => {
      const row = { id: 1, bot_id: 10, update_id: 5, event_type: 'managed_bot_updated', payload: {}, processed: false, error: null, created_at: new Date() };
      queryStub.resolves({ rows: [row] });
      const result = await tryAcquireUpdate(10, 5, 'managed_bot_updated', {});
      expect(result).to.deep.equal(row);
    });

    it('returns null when row already exists (duplicate)', async () => {
      queryStub.resolves({ rows: [] });
      const result = await tryAcquireUpdate(10, 5, 'managed_bot_updated', {});
      expect(result).to.be.null;
    });

    it('uses ON CONFLICT DO NOTHING in the SQL', async () => {
      queryStub.resolves({ rows: [] });
      await tryAcquireUpdate(10, 5, 'type', {});
      const [sql] = queryStub.firstCall.args;
      expect(sql).to.include('ON CONFLICT');
      expect(sql).to.include('DO NOTHING');
    });
  });

  describe('markProcessed', () => {
    it('sets processed=true and clears error', async () => {
      queryStub.resolves({ rows: [] });
      await markProcessed(1);
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('processed = true');
      expect(params).to.include(1);
    });
  });

  describe('markFailed', () => {
    it('sets processed=false and stores error message', async () => {
      queryStub.resolves({ rows: [] });
      await markFailed(1, 'something went wrong');
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('processed = false');
      expect(params).to.include('something went wrong');
    });
  });
});
