import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createSaveMindContextTool', () => {
  let createSaveMindContextTool: any;
  let SAVE_MIND_CONTEXT_SUCCESS_MSG: string;
  let SAVE_MIND_CONTEXT_ERROR_MSG: string;
  let updateToolsetStateStub: sinon.SinonStub;
  let loggerErrorStub: sinon.SinonStub;
  let mod: any;

  const BOT_ID = 'bot-1';
  const USER_ID = '42';
  const USER_ID_NUM = 42;

  function makeMockPool() {
    return { query: sinon.stub().resolves({ rows: [], rowCount: 0 }) };
  }

  beforeEach(async () => {
    updateToolsetStateStub = sinon.stub().resolves(1);
    loggerErrorStub = sinon.stub();

    mod = await esmock('../../../src/services/tools/save-mind-context.ts', {
      '../../../src/db/queries/conversations.js': {
        updateToolsetState: updateToolsetStateStub,
      },
      '../../../src/db/client.js': {
        pool: makeMockPool(),
      },
      '../../../src/utils/logger.js': {
        logger: {
          debug: sinon.stub(),
          error: loggerErrorStub,
        },
      },
    });

    createSaveMindContextTool = mod.createSaveMindContextTool;
    SAVE_MIND_CONTEXT_SUCCESS_MSG = mod.SAVE_MIND_CONTEXT_SUCCESS_MSG;
    SAVE_MIND_CONTEXT_ERROR_MSG = mod.SAVE_MIND_CONTEXT_ERROR_MSG;
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  // ── T1-01: success path calls updateToolsetState with exact args ────────────

  it('T1-01: updateToolsetState called with exact args and returns SAVE_MIND_CONTEXT_SUCCESS_MSG', async () => {
    const mockPool = makeMockPool();
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, mockPool);
    const result = await tool.invoke({ use_case: 'Research' });

    expect(result).to.equal(SAVE_MIND_CONTEXT_SUCCESS_MSG);
    expect(updateToolsetStateStub.calledOnce).to.be.true;
    const [botId, uid, patch, poolArg] = updateToolsetStateStub.firstCall.args;
    expect(botId).to.equal(BOT_ID);
    expect(uid).to.equal(USER_ID_NUM);
    expect(patch).to.deep.equal({ pending_use_case: 'Research' });
    expect(poolArg).to.equal(mockPool);
  });

  // ── T1-02: updateToolsetState rejects → returns SAVE_MIND_CONTEXT_ERROR_MSG ─

  it('T1-02: updateToolsetState rejects → returns SAVE_MIND_CONTEXT_ERROR_MSG exactly', async () => {
    updateToolsetStateStub.rejects(new Error('DB connection failed'));
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    const result = await tool.invoke({ use_case: 'Research' });

    expect(result).to.equal(SAVE_MIND_CONTEXT_ERROR_MSG);
  });

  // ── T1-03: rejects with sensitive error → return string does not contain error message ─

  it('T1-03: updateToolsetState rejects with sensitive error → return string does NOT contain error message', async () => {
    const sensitiveMsg = 'password=supersecret123 connection refused';
    updateToolsetStateStub.rejects(new Error(sensitiveMsg));
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    const result = await tool.invoke({ use_case: 'Research' });

    expect(result).to.be.a('string');
    expect(result).to.not.include('supersecret123');
    expect(result).to.not.include('password');
    expect(result).to.not.include('connection refused');
  });

  // ── T1-04: updateToolsetState rejects → logger.error called with { err } ────

  it('T1-04: updateToolsetState rejects → logger.error called with { err: actualError }', async () => {
    const actualError = new Error('DB timeout');
    updateToolsetStateStub.rejects(actualError);
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    await tool.invoke({ use_case: 'Research' });

    expect(loggerErrorStub.calledOnce).to.be.true;
    const firstArg = loggerErrorStub.firstCall.args[0];
    expect(firstArg).to.have.property('err', actualError);
  });

  // ── T1-05: success path → logger.error NOT called ─────────────────────────

  it('T1-05: success path → logger.error NOT called', async () => {
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    await tool.invoke({ use_case: 'Research' });

    expect(loggerErrorStub.called).to.be.false;
  });

  // ── T2-03/T2-04/T2-05: Zod schema validation ─────────────────────────────

  it('T2-03: schema accepts { use_case: "Research" }', async () => {
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    // If schema rejects, invoke will throw
    let threw = false;
    try {
      await tool.invoke({ use_case: 'Research' });
    } catch {
      threw = true;
    }
    expect(threw).to.be.false;
  });

  it('T2-04: schema rejects {} (missing use_case)', async () => {
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    let threw = false;
    try {
      await tool.invoke({} as any);
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });

  it('T2-05: schema rejects { use_case: 42 } (wrong type)', async () => {
    const tool = createSaveMindContextTool(BOT_ID, USER_ID, makeMockPool());
    let threw = false;
    try {
      await tool.invoke({ use_case: 42 } as any);
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });

  it('T2-08: createSaveMindContextTool is a function (named export smoke)', async () => {
    expect(typeof createSaveMindContextTool).to.equal('function');
  });
});
