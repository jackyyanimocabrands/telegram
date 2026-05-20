import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('processManagedBotUpdated', () => {
  let processManagedBotUpdated: any;
  let getManagedBotTokenStub: sinon.SinonStub;
  let getToolsetStateStub: sinon.SinonStub;
  let createBotStub: sinon.SinonStub;
  let loggerStub: { info: sinon.SinonStub; debug: sinon.SinonStub; warn: sinon.SinonStub; error: sinon.SinonStub };
  let mod: any;

  const MANAGER_TOKEN = 'manager-token-abc';
  const MANAGER_BOT_ID = 'manager';

  const makeUpdate = (overrides: { botUsername?: string | undefined; omitUsername?: boolean } = {}) => ({
    user: { id: 42, is_bot: false, first_name: 'Alice' },
    bot: {
      id: 999,
      is_bot: true,
      first_name: 'AliceBot',
      ...(overrides.omitUsername ? {} : { username: overrides.botUsername ?? 'alicebot' }),
    },
  });

  const makeTelegram = () => ({
    getManagedBotToken: getManagedBotTokenStub,
  });

  const loadModule = async () => {
    mod = await esmock('../../src/services/managed-bot.ts', {
      '../../src/services/telegram-api.js': {},
      '../../src/db/queries/conversations.js': {
        getToolsetState: getToolsetStateStub,
      },
      '../../src/services/bot-management-api.js': {
        botManagementApi: { createBot: createBotStub },
      },
      '../../src/utils/logger.js': {
        logger: loggerStub,
      },
    });
    return mod.processManagedBotUpdated;
  };

  beforeEach(async () => {
    getManagedBotTokenStub = sinon.stub().resolves('child-bot-token-xyz');
    getToolsetStateStub = sinon.stub().resolves({ email: 'alice@example.com' });
    createBotStub = sinon.stub().resolves({ id: 'bot-123', name: 'AliceBot' });
    loggerStub = {
      info: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
    processManagedBotUpdated = await loadModule();
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  it('happy path: logs success and does not throw', async () => {
    const update = makeUpdate();
    await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);

    expect(getManagedBotTokenStub.calledOnce).to.be.true;
    expect(getManagedBotTokenStub.firstCall.args).to.deep.equal([MANAGER_TOKEN, 999]);
    expect(getToolsetStateStub.calledOnce).to.be.true;
    expect(createBotStub.calledOnce).to.be.true;
    expect(createBotStub.firstCall.args[0]).to.equal('alice@example.com');
    expect(createBotStub.firstCall.args[1]).to.include({ name: 'AliceBot', botToken: 'child-bot-token-xyz' });
    expect(loggerStub.info.called).to.be.true;
    expect(loggerStub.error.called).to.be.false;
  });

  it('getManagedBotToken fails: logs error and returns early — createBot NOT called', async () => {
    getManagedBotTokenStub.rejects(new Error('Telegram API error'));
    const update = makeUpdate();

    await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);

    expect(loggerStub.error.calledOnce).to.be.true;
    expect(createBotStub.called).to.be.false;
  });

  it('no email in toolset state: logs error and returns early — createBot NOT called', async () => {
    getToolsetStateStub.resolves({});
    const update = makeUpdate();

    await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);

    expect(createBotStub.called).to.be.false;
    // Should log an error about missing email
    expect(loggerStub.error.called).to.be.true;
  });

  it('getToolsetState throws: logs warning, falls back to no email → returns early without calling createBot', async () => {
    getToolsetStateStub.rejects(new Error('DB connection failed'));
    const update = makeUpdate();

    await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);

    expect(loggerStub.warn.calledOnce).to.be.true;
    expect(createBotStub.called).to.be.false;
    // After warn, the missing email check logs an error too
    expect(loggerStub.error.called).to.be.true;
  });

  it('createBot fails: logs error but does NOT re-throw (non-fatal)', async () => {
    createBotStub.rejects(new Error('Bot management API down'));
    const update = makeUpdate();

    let thrown = false;
    try {
      await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);
    } catch {
      thrown = true;
    }

    expect(thrown).to.be.false;
    expect(loggerStub.error.called).to.be.true;
  });

  it('bot.username is undefined: still calls createBot with username undefined (optional param)', async () => {
    const update = makeUpdate({ omitUsername: true });
    await processManagedBotUpdated(update, makeTelegram(), MANAGER_TOKEN, MANAGER_BOT_ID);

    expect(createBotStub.calledOnce).to.be.true;
    const params = createBotStub.firstCall.args[1];
    expect(params.username).to.be.undefined;
    expect(params.name).to.equal('AliceBot');
  });
});
