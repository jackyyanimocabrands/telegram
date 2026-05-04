import { env } from '../src/config/env.js';
import { TelegramApiClient } from '../src/services/telegram-api.js';

async function main(): Promise<void> {
  const webhookUrl = `${env.BASE_URL}/webhook/telegram`;
  console.log(`Setting webhook to: ${webhookUrl}`);
  console.log('Allowed updates: message, managed_bot');

  try {
    const result = await TelegramApiClient.setWebhook(env.BOT_TOKEN, webhookUrl, ['message', 'managed_bot'], env.WEBHOOK_SECRET);
    console.log('Webhook set:', result);
    const info = await TelegramApiClient.getWebhookInfo(env.BOT_TOKEN);
    console.log('Webhook info:', JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('Failed to set webhook:', err);
    process.exit(1);
  }
}

main();
