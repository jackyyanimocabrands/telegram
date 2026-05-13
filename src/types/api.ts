// ── Express augmentation ──

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// ── Auth types ──

export type ManagedBotStatus = 'PENDING' | 'PROVISIONING' | 'ACTIVE' | 'TOKEN_ROTATED' | 'DEACTIVATED';

export type WebhookEventStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

export interface AuthenticatedUser {
  id: string;        // UUID
  telegramId: number;
  firstName: string;
  username?: string;
}

// ── API Request / Response types ──

export interface TelegramLoginRequest {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

export interface AuthResponse {
  ok: true;
  user: {
    id: string;      // UUID
    telegramId: number;
    firstName: string;
    lastName?: string;
    username?: string;
    photoUrl?: string;
  };
  accessToken: string;
  refreshToken: string;
  deepLink: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  ok: true;
  accessToken: string;
}

export interface BotStatusResponse {
  ok: true;
  bot: {
    botId: number;
    botUsername?: string;
    status: string;
    webhookSet: boolean;
    profileSet: boolean;
    commandsSet: boolean;
    createdAt: string;
  } | null;
}

// ── Internal DB row types ──

export interface ManagedBotRow {
  id: string;            // UUID
  bot_id: number;
  bot_username: string | null;
  owner_telegram_id: number;
  owner_user_id: string; // UUID stored as TEXT, no FK
  encrypted_token: Buffer;
  token_iv: Buffer;
  token_key_version: number;
  status: ManagedBotStatus;
  webhook_set: boolean;
  profile_set: boolean;
  commands_set: boolean;
  update_mode: 'polling' | 'webhook' | null;
  polling_offset: number;
  webhook_secret: Buffer | null;
  webhook_secret_iv: Buffer | null;
  webhook_secret_key_version: number | null;
  last_token_rotated: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserRow {
  id: string;            // UUID
  telegram_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  photo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AppStateRow {
  key: string;
  value: string;
  updated_at: Date;
}

export interface WebhookEventLogRow {
  id: string;            // UUID
  bot_id: number;
  update_id: number;
  event_type: string;
  payload: unknown;
  status: WebhookEventStatus;
  error: string | null;
  created_at: Date;
}
