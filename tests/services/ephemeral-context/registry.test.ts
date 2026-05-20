/**
 * Unit tests for buildEphemeralContext (registry.ts)
 */
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { SystemMessage } from '@langchain/core/messages';
import type { EphemeralContextPlugin, EphemeralContextInput } from '../../../src/services/ephemeral-context/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    EPHEMERAL_CONTEXT_ENABLED: true,
    EPHEMERAL_CONTEXT_DATETIME_ENABLED: true,
    EPHEMERAL_CONTEXT_LOCALE_ENABLED: true,
    DATETIME_FORMAT: 'iso',
    ...overrides,
  } as any;
}

function makeInput(overrides: Partial<EphemeralContextInput> = {}): EphemeralContextInput {
  return {
    botId: 'bot-1',
    userId: '42',
    toolsetState: {},
    getNow: () => new Date('2024-01-15T10:00:00.000Z'),
    ...overrides,
  };
}

function makePlugin(
  name: string,
  result: string | null,
  enabled = true,
): EphemeralContextPlugin {
  return {
    name,
    enabled: () => enabled,
    build: sinon.stub().resolves(result),
  };
}

// ---------------------------------------------------------------------------
// Load registry under test via esmock (to stub logger)
// ---------------------------------------------------------------------------

describe('buildEphemeralContext', () => {
  let lastMod: any;

  afterEach(async () => {
    if (lastMod) {
      await esmock.purge(lastMod);
      lastMod = undefined;
    }
    sinon.restore();
  });

  async function loadRegistry() {
    const warnStub = sinon.stub();
    lastMod = await esmock('../../../src/services/ephemeral-context/registry.js', {
      '../../../src/utils/logger.js': {
        logger: { warn: warnStub, debug: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      },
    });
    return {
      buildEphemeralContext: lastMod.buildEphemeralContext as (
        plugins: EphemeralContextPlugin[],
        input: EphemeralContextInput,
        env: any,
      ) => Promise<SystemMessage | null>,
      warnStub,
    };
  }

  it('returns null when EPHEMERAL_CONTEXT_ENABLED is false', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const plugin = makePlugin('p1', 'some context');
    const result = await buildEphemeralContext([plugin], makeInput(), makeEnv({ EPHEMERAL_CONTEXT_ENABLED: false }));
    expect(result).to.be.null;
  });

  it('returns null when no plugins are provided', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const result = await buildEphemeralContext([], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('returns null when all plugins are disabled', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', 'content', false);
    const p2 = makePlugin('p2', 'content', false);
    const result = await buildEphemeralContext([p1, p2], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('returns a SystemMessage with [Context] wrapper for single plugin returning string', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const plugin = makePlugin('datetime', 'Current UTC date and time: 2024-01-15T10:00:00.000Z');
    const result = await buildEphemeralContext([plugin], makeInput(), makeEnv());
    expect(result).to.be.instanceOf(SystemMessage);
    expect(result!.content).to.equal('[Context]\nCurrent UTC date and time: 2024-01-15T10:00:00.000Z');
  });

  it('returns null when single plugin returns null', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const plugin = makePlugin('locale', null);
    const result = await buildEphemeralContext([plugin], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('filters out null plugin results but keeps non-null', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', 'line one');
    const p2 = makePlugin('p2', null);
    const p3 = makePlugin('p3', 'line three');
    const result = await buildEphemeralContext([p1, p2, p3], makeInput(), makeEnv());
    expect(result).to.be.instanceOf(SystemMessage);
    expect(result!.content).to.equal('[Context]\nline one\nline three');
  });

  it('filters out empty-string plugin results', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', '');
    const p2 = makePlugin('p2', 'valid line');
    const result = await buildEphemeralContext([p1, p2], makeInput(), makeEnv());
    expect(result).to.be.instanceOf(SystemMessage);
    expect(result!.content).to.equal('[Context]\nvalid line');
  });

  it('filters out whitespace-only plugin results', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', '   ');
    const result = await buildEphemeralContext([p1], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('trims whitespace from plugin results before joining', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', '  padded line  ');
    const result = await buildEphemeralContext([p1], makeInput(), makeEnv());
    expect(result!.content).to.equal('[Context]\npadded line');
  });

  it('returns null when all plugins return null', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', null);
    const p2 = makePlugin('p2', null);
    const result = await buildEphemeralContext([p1, p2], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('logs warn and omits rejected plugin, still runs others', async () => {
    const { buildEphemeralContext, warnStub } = await loadRegistry();
    const rejecting: EphemeralContextPlugin = {
      name: 'bad-plugin',
      enabled: () => true,
      build: sinon.stub().rejects(new Error('plugin boom')),
    };
    const good = makePlugin('good-plugin', 'good output');
    const result = await buildEphemeralContext([rejecting, good], makeInput(), makeEnv());
    expect(result).to.be.instanceOf(SystemMessage);
    expect(result!.content).to.equal('[Context]\ngood output');
    expect(warnStub.calledOnce).to.be.true;
    expect(warnStub.firstCall.args[0]).to.include({ pluginName: 'bad-plugin' });
  });

  it('returns null when all plugins reject', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1: EphemeralContextPlugin = {
      name: 'p1',
      enabled: () => true,
      build: sinon.stub().rejects(new Error('fail')),
    };
    const p2: EphemeralContextPlugin = {
      name: 'p2',
      enabled: () => true,
      build: sinon.stub().rejects(new Error('fail')),
    };
    const result = await buildEphemeralContext([p1, p2], makeInput(), makeEnv());
    expect(result).to.be.null;
  });

  it('preserves plugin output ordering in the joined result', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('p1', 'first');
    const p2 = makePlugin('p2', 'second');
    const p3 = makePlugin('p3', 'third');
    const result = await buildEphemeralContext([p1, p2, p3], makeInput(), makeEnv());
    expect(result!.content).to.equal('[Context]\nfirst\nsecond\nthird');
  });

  it('two plugins produce two lines joined with newline', async () => {
    const { buildEphemeralContext } = await loadRegistry();
    const p1 = makePlugin('datetime', 'Current UTC date and time: 2024-01-15T10:00:00.000Z');
    const p2 = makePlugin('locale', "User's local date and time: Monday, January 15, 2024 at 10:00 AM EST");
    const result = await buildEphemeralContext([p1, p2], makeInput(), makeEnv());
    expect(result!.content).to.include('[Context]\n');
    const lines = (result!.content as string).split('\n');
    expect(lines).to.have.length(3); // [Context] + 2 plugin lines
  });

  it('skips plugin whose enabled() throws and still runs remaining plugins', async () => {
    const { buildEphemeralContext, warnStub } = await loadRegistry();
    const throwingPlugin: EphemeralContextPlugin = {
      name: 'throwing-enabled',
      enabled: () => { throw new Error('enabled() boom'); },
      build: sinon.stub().resolves('should never run'),
    };
    const goodPlugin = makePlugin('good-after-throw', 'Plugin B output');
    const result = await buildEphemeralContext([throwingPlugin, goodPlugin], makeInput(), makeEnv());
    expect(result).to.be.instanceOf(SystemMessage);
    expect(result!.content).to.equal('[Context]\nPlugin B output');
    expect(warnStub.calledOnce).to.be.true;
    expect(warnStub.firstCall.args[0]).to.include({ pluginName: 'throwing-enabled' });
  });
});
