import { decrypt } from './encryption.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import { logger } from '../utils/logger.js';

/**
 * Decrypt and return the bot token for a managed child bot.
 * Shared between managed-bot.ts and child-bot.ts — avoids circular dependency.
 */
export async function getDecryptedBotToken(botId: number): Promise<string> {
  logger.debug({ botId }, 'getDecryptedBotToken: looking up bot');
  const bot = await managedBotQueries.findManagedBotByBotId(botId);
  if (!bot) {
    logger.warn({ botId }, 'getDecryptedBotToken: managed bot not found');
    throw new Error(`Managed bot not found: ${botId}`);
  }
  const token = decrypt(bot.encrypted_token, bot.token_iv, bot.token_key_version);
  logger.debug({ botId }, 'getDecryptedBotToken: decrypted successfully');
  return token;
}
