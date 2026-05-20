import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createClearEmailVerificationTool', () => {
  let createClearEmailVerificationTool: any;
  let deleteTokensForUserStub: sinon.SinonStub;
  let updateToolsetStateStub: sinon.SinonStub;
  let mod: any;

  // Mock pg PoolClient
  function makeMockClient(queryOverride?: sinon.SinonStub) {
    return {
      query: queryOverride ?? sinon.stub().resolves({ rows: [], rowCount: 0 }),
      release: sinon.stub(),
    };
  }

  // Mock pg Pool
  function makeMockPool(client: ReturnType<typeof makeMockClient>) {
    return {
      connect: sinon.stub().resolves(client),
    };
  }

  beforeEach(async () => {
    deleteTokensForUserStub = sinon.stub().resolves();
    updateToolsetStateStub = sinon.stub().resolves(1);

    mod = await esmock('../../../src/services/tools/clear-email-verification.ts', {
      '../../../src/db/queries/email-verification-tokens.js': {
        deleteTokensForUser: deleteTokensForUserStub,
      },
      '../../../src/db/queries/conversations.js': {
        updateToolsetState: updateToolsetStateStub,
      },
      '../../../src/db/client.js': {
        pool: { connect: sinon.stub().resolves(makeMockClient()) },
      },
    });

    createClearEmailVerificationTool = mod.createClearEmailVerificationTool;
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────

  it('1. happy path: deleteTokensForUser called, updateToolsetState called, returns success string', async () => {
    const mockClient = makeMockClient();
    const mockPool = makeMockPool(mockClient);

    const tool = createClearEmailVerificationTool('bot-1', '42', mockPool as any);
    const result = await tool.invoke({});

    expect(typeof result).to.equal('string');
    expect(result).to.include('cleared');

    expect(deleteTokensForUserStub.calledOnce).to.be.true;
    expect(updateToolsetStateStub.calledOnce).to.be.true;

    // Verify args: botId, userIdNum, patch
    const [botId, uid, patch] = updateToolsetStateStub.firstCall.args;
    expect(botId).to.equal('bot-1');
    expect(uid).to.equal(42);
    expect(patch).to.deep.include({ email: null, email_verified: false });
  });

  // ── 2. Transaction: BEGIN/COMMIT, pool.connect, client.release in finally ──

  it('2. wraps in transaction: pool.connect called, BEGIN then COMMIT executed, client.release called', async () => {
    const clientQueryStub = sinon.stub().resolves({ rows: [], rowCount: 0 });
    const mockClient = { query: clientQueryStub, release: sinon.stub() };
    const mockPool = makeMockPool(mockClient);

    const tool = createClearEmailVerificationTool('bot-1', '42', mockPool as any);
    await tool.invoke({});

    expect(mockPool.connect.calledOnce).to.be.true;

    const queryCalls = clientQueryStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    expect(queryCalls).to.include('BEGIN');
    expect(queryCalls).to.include('COMMIT');
    expect(mockClient.release.calledOnce).to.be.true;
  });

  // ── 3. deleteTokensForUser throws → ROLLBACK called, error re-thrown, release called ──

  it('3. deleteTokensForUser throws → ROLLBACK called, error re-thrown, client.release still called', async () => {
    deleteTokensForUserStub.rejects(new Error('delete failed'));

    const clientQueryStub = sinon.stub().resolves({ rows: [], rowCount: 0 });
    const mockClient = { query: clientQueryStub, release: sinon.stub() };
    const mockPool = makeMockPool(mockClient);

    const tool = createClearEmailVerificationTool('bot-1', '42', mockPool as any);

    let threw = false;
    try {
      await tool.invoke({});
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.include('delete failed');
    }
    expect(threw).to.be.true;

    const queryCalls = clientQueryStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    expect(queryCalls).to.include('ROLLBACK');
    expect(queryCalls).to.not.include('COMMIT');
    expect(mockClient.release.calledOnce).to.be.true;
  });

  // ── 4. updateToolsetState throws → ROLLBACK called, error re-thrown, release called ──

  it('4. updateToolsetState throws → ROLLBACK called, error re-thrown, client.release still called', async () => {
    updateToolsetStateStub.rejects(new Error('update failed'));

    const clientQueryStub = sinon.stub().resolves({ rows: [], rowCount: 0 });
    const mockClient = { query: clientQueryStub, release: sinon.stub() };
    const mockPool = makeMockPool(mockClient);

    const tool = createClearEmailVerificationTool('bot-1', '42', mockPool as any);

    let threw = false;
    try {
      await tool.invoke({});
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.include('update failed');
    }
    expect(threw).to.be.true;

    const queryCalls = clientQueryStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    expect(queryCalls).to.include('ROLLBACK');
    expect(queryCalls).to.not.include('COMMIT');
    expect(mockClient.release.calledOnce).to.be.true;
  });
});
