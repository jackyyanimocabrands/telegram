// tests/setup.ts
// Environment bootstrap — must run before any module that reads env

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:ABC-DEF_test_token';
process.env.BOT_USERNAME = 'TestManagerBot';
process.env.WEBHOOK_SECRET = 'test-webhook-secret-32-chars-long!!';
process.env.CHILD_WEBHOOK_SECRET = 'child-webhook-secret-32-chars!!!';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/animocamind_connector_test';
process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
process.env.ENCRYPTION_KEY_VERSION = '1';
process.env.ES256_PRIVATE_KEY = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIHpmvp8xOikd1iVLWaG37QB4gHQloktPFoRIZeXoW3mcoAoGCCqGSM49\nAwEHoUQDQgAEFAQW4ht1WenG7HvBKyJVIW+C/HU8CA5rXWmaLqTnltaOmsGi6l56\nMJQNQEb/5dIJocqm0Fjp9OUX2XuQubjAnw==\n-----END EC PRIVATE KEY-----\n';
process.env.ES256_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFAQW4ht1WenG7HvBKyJVIW+C/HU8\nCA5rXWmaLqTnltaOmsGi6l56MJQNQEb/5dIJocqm0Fjp9OUX2XuQubjAnw==\n-----END PUBLIC KEY-----\n';
process.env.JWT_EXPIRES_IN = '900';
process.env.BASE_URL = 'http://localhost:3000';
process.env.LOG_LEVEL = 'fatal';
process.env.MANAGER_UPDATE_MODE = 'polling';
