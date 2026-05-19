import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createCreateBotTool', () => {
  let createCreateBotTool: any;
  let mockClient: { createBot: sinon.SinonStub };
  let loggerErrorStub: sinon.SinonStub;

  beforeEach(async () => {
    mockClient = { createBot: sinon.stub() };
    loggerErrorStub = sinon.stub();
    const module = await esmock('../../../src/services/tools/create-bot.ts', {
      '../../../src/services/bot-management-api.js': {
        botManagementApi: mockClient,
        BotManagementApiClient: class {},
      },
      '../../../src/utils/logger.js': {
        logger: { debug: sinon.stub(), error: loggerErrorStub },
      },
    });
    createCreateBotTool = module.createCreateBotTool;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('returns JSON string with id and name on success', async () => {
    mockClient.createBot.resolves({ id: 'bot-123', name: 'My Bot' });
    const tool = createCreateBotTool('user@example.com', mockClient);
    const result = await tool.invoke({ name: 'My Bot', description: 'A test bot' });
    expect(result).to.equal(JSON.stringify({ id: 'bot-123', name: 'My Bot' }));
    expect(mockClient.createBot.calledOnce).to.be.true;
    expect(mockClient.createBot.firstCall.args[0]).to.equal('user@example.com');
    expect(mockClient.createBot.firstCall.args[1]).to.deep.equal({
      name: 'My Bot',
      username: undefined,
      botToken: undefined,
      description: 'A test bot',
      systemPrompt: undefined,
    });
  });

  it('returns fixed error string on API error, does not throw', async () => {
    const err = new Error('Unauthorized');
    mockClient.createBot.rejects(err);
    const tool = createCreateBotTool('user@example.com', mockClient, 'bot-1', 'user-1');
    const result = await tool.invoke({ name: 'My Bot' });
    expect(result).to.equal('ERROR: Failed to create Mind. Please try again later.');
    expect(loggerErrorStub.calledOnce).to.be.true;
    expect(loggerErrorStub.firstCall.args[0]).to.include({ err });
  });
});
