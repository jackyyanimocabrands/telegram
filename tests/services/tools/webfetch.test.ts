import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { Redis } from 'ioredis';

function makeFakeRedis(evalResult = 1): Redis {
  return {
    eval: sinon.stub().resolves(evalResult),
    pexpire: sinon.stub().resolves(1),
    set: sinon.stub().resolves('OK'),
  } as unknown as Redis;
}

const BASE_ENV = {
  WEBFETCH_RATE_LIMIT_MAX: 10,
  WEBFETCH_RATE_LIMIT_WINDOW_MS: 60000,
  WEBFETCH_DOMAIN_ALLOWLIST: '',
};

describe('createWebfetchTool', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as any);
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('returns stripped text on successful fetch', async () => {
    const fakeRedis = makeFakeRedis(1);
    fetchStub.resolves({
      ok: true,
      text: sinon.stub().resolves('<html><body><h1>Hello World</h1><p>Some   content.</p></body></html>'),
    });

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://example.com/page' });

    expect(result).to.include('Hello World');
    expect(result).to.include('Some content.');
    expect(result).not.to.include('<html>');
    expect(result).not.to.include('<body>');
  });

  it('returns rate limit message when count exceeds WEBFETCH_RATE_LIMIT_MAX', async () => {
    const fakeRedis = makeFakeRedis(11); // count > 10 (default max)

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://example.com/page' });
    expect(result).to.equal('Rate limit exceeded. Try again later.');
    expect(fetchStub.called).to.be.false;
  });

  it('returns domain not allowed when allowlist is set and domain is not in it', async () => {
    const fakeRedis = makeFakeRedis(1);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV, WEBFETCH_DOMAIN_ALLOWLIST: 'allowed.com,other.com' } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://notallowed.com/page' });
    expect(result).to.equal('Domain not allowed.');
    expect(fetchStub.called).to.be.false;
  });

  it('domain is allowed when allowlist is empty (no restriction)', async () => {
    const fakeRedis = makeFakeRedis(1);
    fetchStub.resolves({
      ok: true,
      text: sinon.stub().resolves('plain content'),
    });

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV, WEBFETCH_DOMAIN_ALLOWLIST: '' } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://anydomain.com/page' });
    expect(result).to.equal('plain content');
  });

  // ── SSRF protection ──────────────────────────────────────────────────────

  it('SSRF — blocks AWS IMDS link-local IP (169.254.x.x)', async () => {
    const fakeRedis = makeFakeRedis(1);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '169.254.169.254', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result).to.equal('URL not allowed: private or reserved address.');
    expect(fetchStub.called).to.be.false;
  });

  it('SSRF — blocks localhost by name', async () => {
    const fakeRedis = makeFakeRedis(1);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '127.0.0.1', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'http://localhost/admin' });
    expect(result).to.equal('URL not allowed: private or reserved address.');
    expect(fetchStub.called).to.be.false;
  });

  it('SSRF — blocks RFC-1918 private address (10.x.x.x)', async () => {
    const fakeRedis = makeFakeRedis(1);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '10.0.0.1', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'http://internal.example.com/secret' });
    expect(result).to.equal('URL not allowed: private or reserved address.');
    expect(fetchStub.called).to.be.false;
  });

  it('SSRF — returns error when hostname cannot be resolved', async () => {
    const fakeRedis = makeFakeRedis(1);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().rejects(new Error('ENOTFOUND')) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://unresolvable.invalid/page' });
    expect(result).to.equal('URL not allowed: hostname could not be resolved.');
    expect(fetchStub.called).to.be.false;
  });

  it('returns Fetch failed message on non-2xx response', async () => {
    const fakeRedis = makeFakeRedis(1);
    fetchStub.resolves({ ok: false, status: 404, text: async () => 'Not Found' });

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://example.com/missing' });
    expect(result).to.equal('Fetch failed: HTTP 404');
  });

  it('returns error message string on fetch timeout, does not throw', async () => {
    const fakeRedis = makeFakeRedis(1);
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    fetchStub.rejects(timeoutErr);

    const { createWebfetchTool } = await esmock('../../../src/services/tools/webfetch.ts', {
      '../../../src/config/env.js': { env: { ...BASE_ENV } },
      '../../../src/services/redis.js': { getRedisClient: () => fakeRedis },
      'dns': { promises: { lookup: sinon.stub().resolves({ address: '1.2.3.4', family: 4 }) } },
    });

    const tool = createWebfetchTool({ redisClient: fakeRedis, botId: 'bot-1', userId: 'user-1' });
    const result = await tool.invoke({ url: 'https://example.com/slow' });
    expect(result).to.be.a('string');
    expect(result.length).to.be.greaterThan(0);
    expect(fetchStub.calledOnce).to.be.true;
  });
});
