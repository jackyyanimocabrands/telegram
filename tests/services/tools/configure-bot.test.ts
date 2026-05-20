import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createConfigureBotTool', () => {
  let createConfigureBotTool: any;
  let mockClient: { configureBot: sinon.SinonStub };
  let loggerErrorStub: sinon.SinonStub;
  let mod: any;

  beforeEach(async () => {
    mockClient = { configureBot: sinon.stub() };
    loggerErrorStub = sinon.stub();
    mod = await esmock('../../../src/services/tools/configure-bot.ts', {
      '../../../src/services/bot-management-api.js': {
        botManagementApi: mockClient,
        BotManagementApiClient: class {},
      },
      '../../../src/utils/logger.js': {
        logger: { debug: sinon.stub(), error: loggerErrorStub },
      },
    });
    createConfigureBotTool = mod.createConfigureBotTool;
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  it('returns JSON string on success', async () => {
    mockClient.configureBot.resolves({ id: 'bot-456', name: 'Updated Bot' });
    const tool = createConfigureBotTool('admin@example.com', mockClient);
    const result = await tool.invoke({ botId: 'bot-456', name: 'Updated Bot', systemPrompt: 'Be helpful.' });
    expect(result).to.equal(JSON.stringify({ id: 'bot-456', name: 'Updated Bot' }));
    expect(mockClient.configureBot.calledOnce).to.be.true;
    expect(mockClient.configureBot.firstCall.args[0]).to.equal('admin@example.com');
    expect(mockClient.configureBot.firstCall.args[1]).to.equal('bot-456');
    expect(mockClient.configureBot.firstCall.args[2]).to.deep.equal({
      name: 'Updated Bot',
      description: undefined,
      systemPrompt: 'Be helpful.',
    });
  });

  it('returns fixed error string on API error, does not throw', async () => {
    const err = new Error('Bot not found');
    mockClient.configureBot.rejects(err);
    const tool = createConfigureBotTool('admin@example.com', mockClient, 'bot-1', 'user-1');
    const result = await tool.invoke({ botId: 'bot-999' });
    expect(result).to.equal('ERROR: Failed to configure Mind. Please try again later.');
    expect(loggerErrorStub.calledOnce).to.be.true;
    expect(loggerErrorStub.firstCall.args[0]).to.include({ err });
  });
});
