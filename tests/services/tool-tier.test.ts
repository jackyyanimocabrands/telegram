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
let createVerifyEmailToolStub: sinon.SinonStub;
let createClearEmailVerificationToolStub: sinon.SinonStub;
let createCheckBotUsernameToolStub: sinon.SinonStub;
let createSaveMindContextToolStub: sinon.SinonStub;
let lastMod: any;

async function buildModule() {
  lastMod = await esmock('../../src/services/tool-tier.ts', {
    '../../src/services/tools/index.js': {
      createCreateBotTool: createCreateBotToolStub,
      createConfigureBotTool: createConfigureBotToolStub,
      createWebsearchTool: createWebsearchToolStub,
      createWebfetchTool: createWebfetchToolStub,
      createVerifyEmailTool: createVerifyEmailToolStub,
      createClearEmailVerificationTool: createClearEmailVerificationToolStub,
      createCheckBotUsernameTool: createCheckBotUsernameToolStub,
      createSaveMindContextTool: createSaveMindContextToolStub,
    },
  });
  return lastMod;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tool-tier', () => {
  beforeEach(() => {
    createCreateBotToolStub = sinon.stub().returns(makeTool('create_bot'));
    createConfigureBotToolStub = sinon.stub().returns(makeTool('configure_bot'));
    createWebsearchToolStub = sinon.stub().returns(makeTool('web_search'));
    createWebfetchToolStub = sinon.stub().returns(makeTool('web_fetch'));
    createVerifyEmailToolStub = sinon.stub().returns(makeTool('verify_email'));
    createClearEmailVerificationToolStub = sinon.stub().returns(makeTool('clear_email_verification'));
    createCheckBotUsernameToolStub = sinon.stub().returns(makeTool('check_bot_username'));
    createSaveMindContextToolStub = sinon.stub().returns(makeTool('save_mind_context'));
  });

  afterEach(async () => {
    if (lastMod) {
      await esmock.purge(lastMod);
      lastMod = undefined;
    }
    sinon.restore();
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

    it('returns array of length 5 for "base" tier (verify_email, save_mind_context, check_bot_username, web_fetch, web_search)', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('base', deps);
      expect(tools).to.be.an('array').with.length(5);
      const names = tools.map((t: StructuredTool) => t.name);
      expect(names).to.include('verify_email');
      expect(names).to.include('save_mind_context');
      expect(names).to.include('check_bot_username');
      expect(names).to.include('web_fetch');
      expect(names).to.include('web_search');
    });

    it('returns exactly 4 tools for "authenticated" tier', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('authenticated', deps);
      expect(tools).to.be.an('array').with.length(4);
    });

    it('authenticated tools include clear_email_verification, check_bot_username, web_fetch, web_search but NOT create_bot or configure_bot', async () => {
      const { getToolsForTier } = await buildModule();
      const tools = getToolsForTier('authenticated', deps);
      const names = tools.map((t: StructuredTool) => t.name);
      expect(names).to.include('clear_email_verification');
      expect(names).to.include('check_bot_username');
      expect(names).to.include('web_fetch');
      expect(names).to.include('web_search');
      // create_bot and configure_bot must NOT be in authenticated tier
      expect(names).to.not.include('create_bot');
      expect(names).to.not.include('configure_bot');
      // save_mind_context must NOT be in authenticated tier
      expect(names).to.not.include('save_mind_context');
    });

    it('does not call bot management tool factories for "base" tier', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('base', deps);
      expect(createCreateBotToolStub.called).to.be.false;
      expect(createConfigureBotToolStub.called).to.be.false;
      expect(createClearEmailVerificationToolStub.called).to.be.false;
      expect(createWebsearchToolStub.called).to.be.true;
      expect(createWebfetchToolStub.called).to.be.true;
    });

    it('calls createVerifyEmailTool for "base" tier', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('base', deps);
      expect(createVerifyEmailToolStub.called).to.be.true;
    });

    it('calls createClearEmailVerificationTool for "authenticated" tier', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('authenticated', deps);
      expect(createClearEmailVerificationToolStub.called).to.be.true;
    });

    it('does not call createCreateBotTool or createConfigureBotTool for "authenticated" tier', async () => {
      const { getToolsForTier } = await buildModule();
      getToolsForTier('authenticated', deps);
      expect(createCreateBotToolStub.called).to.be.false;
      expect(createConfigureBotToolStub.called).to.be.false;
    });
  });
});
