import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../../src/db/client.js';
import { getAppState, setAppState } from '../../../src/db/queries/app-state.js';

describe('app-state queries', () => {
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    queryStub = sinon.stub(pool, 'query');
  });

  afterEach(() => sinon.restore());

  describe('getAppState', () => {
    it('returns the stored value when key exists', async () => {
      queryStub.resolves({ rows: [{ value: 'hello' }] });
      const result = await getAppState('my_key');
      expect(result).to.equal('hello');
    });

    it('returns null when key does not exist', async () => {
      queryStub.resolves({ rows: [] });
      const result = await getAppState('missing_key');
      expect(result).to.be.null;
    });
  });

  describe('setAppState', () => {
    it('executes an upsert query', async () => {
      queryStub.resolves({ rows: [] });
      await setAppState('offset', '42');
      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.firstCall.args;
      expect(sql).to.include('INSERT INTO app_state');
      expect(params).to.include('offset');
      expect(params).to.include('42');
    });
  });
});
