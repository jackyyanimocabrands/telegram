// ── Telegram Bot API 9.6 Type Definitions ──

/** Core Telegram User object */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  can_manage_bots?: boolean;
}

/** Chat object */
export interface Chat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** Message object (simplified) */
export interface Message {
  message_id: number;
  from?: TelegramUser;
  chat: Chat;
  date: number;
  text?: string;
  managed_bot_created?: ManagedBotCreated;
}

/** Callback query (simplified) */
export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: Message;
  data?: string;
}

// ── Managed Bots (Bot API 9.6) ──

export interface ManagedBotCreated {
  bot: TelegramUser;
}

export interface ManagedBotUpdated {
  /** The user who created or owns the bot */
  user: TelegramUser;
  /** The managed bot (created, token-rotated, or owner-changed) */
  bot: TelegramUser;
}

export interface KeyboardButtonRequestManagedBot {
  request_id: number;
  suggested_name?: string;
  suggested_username?: string;
}

export interface PreparedKeyboardButton {
  id: string;
}

// ── Update ──

export interface Update {
  update_id: number;
  message?: Message;
  managed_bot?: ManagedBotUpdated;
  callback_query?: CallbackQuery;
}

// ── Login Widget Auth Data ──

export interface TelegramAuthData {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

// ── Bot API Response wrappers ──

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}
