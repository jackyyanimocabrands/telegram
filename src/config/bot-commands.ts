import type { BotCommand } from '../types/telegram.js';

export const MANAGER_BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Start or restart the conversation' },
  { command: 'new',   description: 'Start a fresh conversation' },
  { command: 'help',  description: 'Show available commands' },
] as const;
