import sinon from 'sinon';
import type { TelegramClient } from '../../src/services/telegram-api.js';
import type {
  TelegramUser,
  Update,
  WebhookInfo,
  Message,
  BotCommand,
} from '../../src/types/telegram.js';

/**
 * Sinon-based mock implementing TelegramClient.
 * Use the `when*` helpers in each test to configure return values;
 * call `reset()` in afterEach to clear call history.
 */
export class MockTelegramClient implements TelegramClient {
  getMe = sinon.stub();
  getUpdates = sinon.stub();
  setWebhook = sinon.stub().resolves(true);
  deleteWebhook = sinon.stub().resolves(true);
  getWebhookInfo = sinon.stub();
  sendMessage = sinon.stub();
  sendMessageDraft = sinon.stub().resolves(true);
  setMyName = sinon.stub().resolves(true);
  setMyDescription = sinon.stub().resolves(true);
  setMyShortDescription = sinon.stub().resolves(true);
  setMyCommands = sinon.stub().resolves(true);
  answerCallbackQuery = sinon.stub().resolves(true);
  replaceManagedBotToken = sinon.stub();

  reset(): void {
    sinon.resetHistory();
  }

  whenGetMe(result: TelegramUser): void {
    this.getMe.resolves(result);
  }

  whenGetUpdates(result: Update[]): void {
    this.getUpdates.resolves(result);
  }

  whenSetWebhook(result = true): void {
    this.setWebhook.resolves(result);
  }

  whenDeleteWebhook(result = true): void {
    this.deleteWebhook.resolves(result);
  }

  whenGetWebhookInfo(result: WebhookInfo): void {
    this.getWebhookInfo.resolves(result);
  }

  whenSendMessage(result: Message): void {
    this.sendMessage.resolves(result);
  }

  whenSetMyName(result = true): void {
    this.setMyName.resolves(result);
  }

  whenSetMyDescription(result = true): void {
    this.setMyDescription.resolves(result);
  }

  whenSetMyShortDescription(result = true): void {
    this.setMyShortDescription.resolves(result);
  }

  whenSetMyCommands(result = true): void {
    this.setMyCommands.resolves(result);
  }

  whenAnswerCallbackQuery(result = true): void {
    this.answerCallbackQuery.resolves(result);
  }

  whenReplaceManagedBotToken(result: string): void {
    this.replaceManagedBotToken.resolves(result);
  }
}
