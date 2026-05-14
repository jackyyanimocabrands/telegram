import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createConfigureBotTool', () => {
  let createConfigureBotTool: any;
  let mockClient: { configureBot: sinon.SinonStub };

  beforeEach(async () => {
    mockClient = { configureBot: sinon.stub() };
    const module = await esmock('../../../src/services/tools/configure-bot.ts', {
      '../../../src/services/bot-management-api.js': {
        botManagementApi: mockClient,
        BotManagementApiClient: class {},
      },
    });
    createConfigureBotTool = module.createConfigureBotTool;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
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

  it('returns error message string on API error, does not throw', async () => {
    mockClient.configureBot.rejects(new Error('Bot not found'));
    const tool = createConfigureBotTool('admin@example.com', mockClient);
    const result = await tool.invoke({ botId: 'bot-999' });
    expect(result).to.equal('Bot not found');
  });
});
