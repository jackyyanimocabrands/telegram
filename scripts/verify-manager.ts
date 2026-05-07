import { env } from '../src/config/env.js';
import { HttpTelegramClient } from '../src/services/telegram-api.js';

async function main(): Promise<void> {
  const telegram = HttpTelegramClient.getInstance();
  try {
    const me = await telegram.getMe(env.BOT_TOKEN);
    console.log('Bot info:');
    console.log(`  ID: ${me.id}`);
    console.log(`  Name: ${me.first_name}`);
    console.log(`  Username: @${me.username}`);
    console.log(`  can_manage_bots: ${me.can_manage_bots ?? false}`);

    if (!me.can_manage_bots) {
      console.error('');
      console.error('This bot does NOT have can_manage_bots capability.');
      console.error('Enable "Bot Management Mode" via BotFather Mini App: https://t.me/Botfather?startapp');
      process.exit(1);
    }

    console.log('');
    console.log('Bot has manager capability');
  } catch (err) {
    console.error('Failed to verify bot:', err);
    process.exit(1);
  }
}

main();
