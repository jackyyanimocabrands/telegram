import { describe, it } from 'mocha';
import { expect } from 'chai';
import crypto from 'node:crypto';
import { verifyTelegramAuth } from '../../src/services/telegram-auth.js';
import type { TelegramAuthData } from '../../src/types/telegram.js';

const BOT_TOKEN = '123456:ABC-DEF_test_token';

function makeValidAuthData(overrides: Partial<TelegramAuthData> = {}): TelegramAuthData {
  const base: Omit<TelegramAuthData, 'hash'> = {
    id: '99887766',
    first_name: 'Test',
    username: 'testuser',
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
  const dataCheckString = Object.keys(base)
    .sort()
    .map(k => `${k}=${base[k as keyof typeof base]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...base, hash, ...('hash' in overrides ? { hash: overrides.hash! } : {}) } as TelegramAuthData;
}

describe('verifyTelegramAuth', () => {
  it('returns true for valid auth data', () => {
    expect(verifyTelegramAuth(makeValidAuthData(), BOT_TOKEN)).to.be.true;
  });

  it('returns false when hash is missing', () => {
    const data = makeValidAuthData();
    (data as any).hash = '';
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when hash is wrong', () => {
    const data = makeValidAuthData();
    data.hash = 'a'.repeat(64);
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when hash has wrong length', () => {
    const data = makeValidAuthData();
    data.hash = 'abc123';
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when auth_date is too old (> 24h)', () => {
    const oldDate = String(Math.floor(Date.now() / 1000) - 90000);
    const data = makeValidAuthData({ auth_date: oldDate });
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when auth_date is in the future', () => {
    const futureDate = String(Math.floor(Date.now() / 1000) + 60);
    const data = makeValidAuthData({ auth_date: futureDate });
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when auth_date is NaN', () => {
    const data = makeValidAuthData({ auth_date: 'notanumber' });
    expect(verifyTelegramAuth(data, BOT_TOKEN)).to.be.false;
  });

  it('returns false when wrong bot token used for verification', () => {
    const data = makeValidAuthData();
    expect(verifyTelegramAuth(data, 'wrong:token')).to.be.false;
  });
});
