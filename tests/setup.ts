import { beforeAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:ABC-DEF_test_token';
process.env.BOT_USERNAME = 'TestManagerBot';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.CHILD_WEBHOOK_SECRET = 'test-child-webhook-secret';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/animocamind_connector_test';
process.env.ENCRYPTION_MASTER_KEY = '0'.repeat(64);
process.env.ENCRYPTION_KEY_VERSION = '1';
process.env.ES256_PRIVATE_KEY = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIOBXxVGizGGZm4U3Lv+BJkEm+BsJ25lE8NivLj4YEWJMoAcGBSuBBAAi\noWQDYgAESw2mJc5N3I5F3MIVo9J3RPa+9Fo7K5btEJX+K2GDCeGuQRj8zEFn3sY6\ng5N9pL3H6KXk2T5kR2G7f8p1zULjWtLh8bQ0x6cRBmO3jXH6N9BN7K/G3A==\n-----END EC PRIVATE KEY-----';
process.env.ES256_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEjP+LHBaFLg9pMT3oFfLQw3WT7qCm+zxR\nbKebjGBGnNmJ6Td3F4xLJ7yF8dF5+v0T2q2wLH5gK3vlBmPV+V3cjg==\n-----END PUBLIC KEY-----';
process.env.JWT_EXPIRES_IN = '900';
process.env.JWT_REFRESH_EXPIRES_IN = '604800';
process.env.BASE_URL = 'http://localhost:3000';
process.env.LOG_LEVEL = 'error';

beforeAll(() => {
  // Global test setup
});
