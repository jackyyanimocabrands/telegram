import { describe, it, afterEach, beforeEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { StructuredTool } from '@langchain/core/tools';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a minimal StructuredTool-shaped object with a name for assertion
 * purposes. Full StructuredTool implementation is not required for these tests.
 */
function makeTool(name: string): StructuredTool {
  return {
    name,
    description: `stub tool: ${name}`,
    schema: {} as unknown as StructuredTool['schema'],
    invoke: sinon.stub().resolves(`result from ${name}`),
    lc_serializable: false,
    lc_kwargs: {},
    lc_namespace: [],
    getName: () => name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as StructuredTool;
}

// ── Stubs (re-created per test in beforeEach) ────────────────────────────────

let createCreateBotToolStub: sinon.SinonStub;
let createConfigureBotToolStub: sinon.SinonStub;
let createWebsearchToolStub: sinon.SinonStub;
let createWebfetchToolStub: sinon.SinonStub;

async function buildModule() {
  return esmock('../../src/services/tool-tier.ts', {
    '../../src/services/tools/index.js': {
      createCreateBotTool: createCreateBotToolStub,
      createConfigureBotTool: createConfigureBotToolStub,
      createWebsearchTool: createWebsearchToolStub,
      createWebfetchTool: createWebfetchToolStub,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tool-tier', () => {
  beforeEach(() => {
    createCreateBotToolStub = sinon.stub().returns(makeTool('create_bot'));
    createConfigureBotToolStub = sinon.stub().returns(makeTool('configure_bot'));
    createWebsearchToolStub = sinon.stub().returns(makeTool('websearch'));
    createWebfetchToolStub = sinon.stub().returns(makeTool('webfetch'));
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── resolveToolTier ───────────────────────────────────────────────────────

  describe('resolveToolTier()', () => {
    it('returns "authenticated" when email_verified is true', async () => {
      const { resolveToolTier } = await buildModule();
      expect(resolveToolTier({ email: 'user@example.com', email_verified: true })).to.equal('authenticated');
    });

    it('returns "base" when email_verified is false', async () => {
      const { resolveToolTier } = await buildModule();
      expect(resolveToolTier({ email: 'user@example.com', email_verified: false })).to.equal('base');
    });

    it('returns "base" when email_verified is absent', async () => {
      const { resolveToolTier } = await buildModule();
      expect(resolveToolTier({})).to.equal('base');
    });

    it('returns "base" when toolsetState is empty object', async () => {
      const { resolveToolTier } = await buildModule();
      expect(resolveToolTier({})).to.equal('base');
    });

    it('returns "base" when email_verified is a truthy non-boolean (e.g. string "true")', async () => {
      const { resolveToolTier } = await buildModule();
      // email_verified must be strictly true
      expect(resolveToolTier({ email_verified: 'true' as unknown as boolean })).to.equal('base');
    });
  });

  // ── getToolsForTier ───────────────────────────────────────────────────────

  describe('getToolsForTier()', () => {
    const deps = {
      userEmail: 'user@example.com',
      botId: 'bot-1',
      userId: '42',
    };

    it('returns empty array for "base" tier', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('base', deps);
      expect(tools).to.be.an('array').with.length(0);
    });

    it('returns exactly 4 tools for "authenticated" tier', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('authenticated', deps);
      expect(tools).to.be.an('array').with.length(4);
    });

    it('authenticated tools have correct names in order: create_bot, configure_bot, websearch, webfetch', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('authenticated', deps);
      expect(tools.map((t: StructuredTool) => t.name)).to.deep.equal([
        'create_bot',
        'configure_bot',
        'websearch',
        'webfetch',
      ]);
    });

    it('passes userEmail to createCreateBotTool', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('authenticated', deps);
      expect(createCreateBotToolStub.calledWith(deps.userEmail)).to.be.true;
    });

    it('passes userEmail to createConfigureBotTool', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('authenticated', deps);
      expect(createConfigureBotToolStub.calledWith(deps.userEmail)).to.be.true;
    });

    it('does not call any tool factory for "base" tier', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('base', deps);
      expect(createCreateBotToolStub.called).to.be.false;
      expect(createConfigureBotToolStub.called).to.be.false;
      expect(createWebsearchToolStub.called).to.be.false;
      expect(createWebfetchToolStub.called).to.be.false;
    });
  });
});
