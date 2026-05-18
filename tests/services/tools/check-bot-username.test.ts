import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createCheckBotUsernameTool', () => {
  let createCheckBotUsernameTool: (botId?: string, userId?: string) => ReturnType<typeof import('../../../src/services/tools/check-bot-username.js')['createCheckBotUsernameTool']>;

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  async function buildModule() {
    const mod = await esmock('../../../src/services/tools/check-bot-username.ts', {
      '../../../src/utils/logger.js': {
        logger: { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      },
    });
    createCheckBotUsernameTool = mod.createCheckBotUsernameTool;
  }

  it('tool name is "check_bot_username"', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool('bot-1', 'user-1');
    expect(t.name).to.equal('check_bot_username');
  });

  it('returns available:true for a valid username ending in _bot', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool('bot-1', 'user-1');
    const result = JSON.parse(await t.invoke({ username: 'alice_bot' }));
    expect(result.available).to.be.true;
    expect(result.username).to.equal('alice_bot');
    expect(result.reason).to.be.undefined;
  });

  it('returns available:false when username does not end in _bot', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    const result = JSON.parse(await t.invoke({ username: 'alice_helper' }));
    expect(result.available).to.be.false;
    expect(result.username).to.equal('alice_helper');
    expect(result.reason).to.include('_bot');
  });

  it('returns available:false when username is too short (< 5 chars)', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    // "ab" ends in nothing valid anyway but length check fires first
    const result = JSON.parse(await t.invoke({ username: 'a_bt' }));
    expect(result.available).to.be.false;
    expect(result.reason).to.include('5');
  });

  it('returns available:false when username is too long (> 32 chars)', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    const longUsername = 'a'.repeat(30) + '_bot'; // 34 chars
    const result = JSON.parse(await t.invoke({ username: longUsername }));
    expect(result.available).to.be.false;
    expect(result.reason).to.include('32');
  });

  it('returns available:false when username contains invalid characters', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    const result = JSON.parse(await t.invoke({ username: 'alice-bot' }));
    expect(result.available).to.be.false;
    expect(result.reason).to.include('letters, numbers, and underscores');
  });

  it('works without botId and userId arguments', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    const result = JSON.parse(await t.invoke({ username: 'myminds_bot' }));
    expect(result.available).to.be.true;
  });

  it('username case-insensitively must end with _bot (mixed case passes)', async () => {
    await buildModule();
    const t = createCheckBotUsernameTool();
    const result = JSON.parse(await t.invoke({ username: 'Alice_Bot' }));
    expect(result.available).to.be.true;
  });
});
