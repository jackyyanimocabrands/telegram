import { env } from '../src/config/env.js';
import { HttpTelegramClient } from '../src/services/telegram-api.js';
import { MANAGER_BOT_COMMANDS } from '../src/config/bot-commands.js';

async function main(): Promise<void> {
  const telegram = HttpTelegramClient.getInstance();
  console.log('Registering manager bot commands:');
  for (const cmd of MANAGER_BOT_COMMANDS) {
    console.log(`  /${cmd.command} – ${cmd.description}`);
  }

  try {
    const result = await telegram.setMyCommands(env.BOT_TOKEN, MANAGER_BOT_COMMANDS, { type: 'all_private_chats' });
    console.log('Commands set:', result);
  } catch (err) {
    console.error('Failed to set commands:', err);
    process.exit(1);
  }
}

main();
