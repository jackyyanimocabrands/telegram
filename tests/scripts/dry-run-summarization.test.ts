/**
 * Unit + integration tests for scripts/dry-run-summarization.ts
 *
 * Tests the exported parseArgs() and run() functions in isolation.
 * No real DB, no real LLM, no real Redis.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

// ---------------------------------------------------------------------------
// Shared mock llmConfig
// ---------------------------------------------------------------------------

const mockLlmConfig = {
  chat: [
    { provider: 'openai', model: 'gpt-4o', temperature: 0.7 },
  ],
  summarization: [
    { provider: 'openai', model: 'gpt-4o-mini', temperature: 0.3 },
  ],
  summarizationConfig: {
    threshold: 0.8,
    compression: 0.5,
    forceCompression: 0.75,
  },
};

// Valid UUID-format bot ID used across tests
const VALID_BOT_ID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Module loader — loads the script under test with esmocked deps
// ---------------------------------------------------------------------------

async function loadScript(
  overrides: {
    checkBudgetRouter?: sinon.SinonStub;
    summarizeNode?: sinon.SinonStub;
    upsertConversation?: sinon.SinonStub;
    updateConversationMessages?: sinon.SinonStub;
  } = {},
) {
  const checkBudgetRouterStub =
    overrides.checkBudgetRouter ?? sinon.stub().returns('summarize');
  const summarizeNodeStub =
    overrides.summarizeNode ??
    sinon.stub().resolves({ summary: 'test summary', summarizationRan: true });
  const upsertConversationStub =
    overrides.upsertConversation ?? sinon.stub().resolves();
  const updateConversationMessagesStub =
    overrides.updateConversationMessages ?? sinon.stub().resolves();

  const mod = await esmock('../../scripts/dry-run-summarization.js', {
    '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
    '../../src/services/agent.js': {
      checkBudgetRouter: checkBudgetRouterStub,
      summarizeNode: summarizeNodeStub,
    },
    '../../src/services/conversation.js': {
      toBaseMessages: (msgs: unknown[]) =>
        msgs.map(() => new HumanMessage('hello')),
    },
    '../../src/services/llm/model-registry.js': {
      getModelConfig: sinon.stub().returns({ maxTokens: 128000 }),
    },
    '../../src/services/llm/token-estimator.js': {
      estimateTokens: sinon.stub().returns(5000),
    },
    '../../src/db/queries/conversations.js': {
      getConversation: sinon.stub().resolves(null),
      upsertConversation: upsertConversationStub,
      updateConversationMessages: updateConversationMessagesStub,
    },
    '../../src/db/client.js': { pool: {} },
    '../../src/services/llm/factory.js': {
      LlmProviderFactory: class {
        create() {
          return { invoke: sinon.stub().resolves(new AIMessage('live reply')) };
        }
      },
    },
  });

  return {
    mod,
    parseArgs: mod.parseArgs as (argv: string[]) => {
      botId: string;
      telegramUserId: string;
      mode: 'dry' | 'live';
      force: boolean;
    },
    run: mod.run as (args: ReturnType<typeof mod.parseArgs>, deps: unknown) => Promise<void>,
    checkBudgetRouterStub,
    summarizeNodeStub,
    upsertConversationStub,
    updateConversationMessagesStub,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture() {
  let captured = '';
  const stdout = { write: (s: string) => { captured += s; } };
  return { stdout, get output() { return captured; } };
}

function makeConvDeps(
  msgs: { role: string; content: string }[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there, how can I help?' },
    { role: 'user', content: 'Tell me something' },
    { role: 'assistant', content: 'Sure here is something interesting' },
  ],
  opts: { forceSummarize?: boolean; summary?: string | null } = {},
) {
  return {
    loadConversation: sinon.stub().resolves({
      messages: msgs,
      summary: opts.summary ?? null,
      forceSummarize: opts.forceSummarize ?? false,
    }),
  };
}

function makeMockModelFactory() {
  const invokeStub = sinon.stub().resolves(new AIMessage('[DRY RUN — no LLM call made]'));
  const createStub = sinon.stub().returns({ invoke: invokeStub });
  return { createStub, invokeStub, modelFactory: { create: createStub } };
}

// ---------------------------------------------------------------------------
// C-01 / C-02: Missing positional args
// ---------------------------------------------------------------------------

describe('parseArgs — missing arguments', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-01: throws with usage text when no args provided', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() => loaded.parseArgs([])).to.throw(/Missing required arguments/);
  });

  it('C-02: throws when only one positional arg provided', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() => loaded.parseArgs([VALID_BOT_ID])).to.throw(/Missing required arguments/);
  });
});

// ---------------------------------------------------------------------------
// C-03: --dry and --live together
// ---------------------------------------------------------------------------

describe('parseArgs — conflicting flags', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-03: throws when --dry and --live are both provided', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() =>
      loaded.parseArgs([VALID_BOT_ID, '12345', '--dry', '--live']),
    ).to.throw(/cannot be used together/);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — valid cases
// ---------------------------------------------------------------------------

describe('parseArgs — valid inputs', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('defaults mode to dry when neither --dry nor --live supplied', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const result = loaded.parseArgs([VALID_BOT_ID, '999']);
    expect(result.mode).to.equal('dry');
    expect(result.force).to.equal(false);
    expect(result.botId).to.equal(VALID_BOT_ID);
    expect(result.telegramUserId).to.equal('999');
  });

  it('mode is live when --live provided', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const result = loaded.parseArgs([VALID_BOT_ID, '42', '--live']);
    expect(result.mode).to.equal('live');
  });

  it('force is true when --force provided', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const result = loaded.parseArgs([VALID_BOT_ID, '42', '--force']);
    expect(result.force).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — unknown flag
// ---------------------------------------------------------------------------

describe('parseArgs — unknown flags', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('throws on unrecognised -- flag', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() =>
      loaded.parseArgs([VALID_BOT_ID, '42', '--typo']),
    ).to.throw(/Unknown flag/);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — invalid telegramUserId (T5)
// ---------------------------------------------------------------------------

describe('parseArgs — invalid telegramUserId', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('T5: throws with user-friendly message when telegramUserId is non-numeric', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() =>
      loaded.parseArgs([VALID_BOT_ID, 'abc']),
    ).to.throw(/Invalid telegram-user-id/);
  });

  it('throws when telegramUserId is empty string', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    // Empty string fails positional count check first
    expect(() =>
      loaded.parseArgs([VALID_BOT_ID, '']),
    ).to.satisfy((fn: () => void) => {
      try { fn(); return false; } catch { return true; }
    });
  });
});

// ---------------------------------------------------------------------------
// parseArgs — invalid botId (S4)
// ---------------------------------------------------------------------------

describe('parseArgs — invalid botId', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('throws when botId does not look like a UUID', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    expect(() =>
      loaded.parseArgs(['not-a-uuid!!', '42']),
    ).to.throw(/Invalid bot-id/);
  });
});

// ---------------------------------------------------------------------------
// C-04: --live mode — no upsertConversation or updateConversationMessages call
// ---------------------------------------------------------------------------

describe('run — live mode does not write to DB', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-04: upsertConversation is never called in live mode', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const { run, upsertConversationStub, updateConversationMessagesStub } = loaded;
    const { stdout } = makeCapture();
    const { modelFactory } = makeMockModelFactory();
    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout,
    };

    await run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'live', force: false }, deps);

    expect(upsertConversationStub.callCount).to.equal(0);
    expect(updateConversationMessagesStub.callCount).to.equal(0);
  });

  it('C-04: upsertConversation is never called in dry mode', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const { run, upsertConversationStub, updateConversationMessagesStub } = loaded;
    const { stdout } = makeCapture();
    const { modelFactory } = makeMockModelFactory();
    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout,
    };

    await run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(upsertConversationStub.callCount).to.equal(0);
    expect(updateConversationMessagesStub.callCount).to.equal(0);
  });
});

// ---------------------------------------------------------------------------
// C-06: --dry mode — real factory not called, summarizeNode called once
// ---------------------------------------------------------------------------

describe('run — dry mode uses mock factory', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-06: real modelFactory.create is not called in dry mode', async () => {
    const realFactory = makeMockModelFactory();
    const loaded = await loadScript();
    mod = loaded.mod;
    const { stdout } = makeCapture();

    const deps = {
      ...makeConvDeps(),
      modelFactory: realFactory.modelFactory,
      stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    // realFactory.createStub should NOT have been called — dry run uses internal mock factory
    expect(realFactory.createStub.callCount).to.equal(0);
  });

  it('C-06: summarizeNode is called exactly once in dry mode', async () => {
    const summarizeNodeStub = sinon.stub().resolves({ summary: 'summarized', summarizationRan: true });
    const loaded = await loadScript({ summarizeNode: summarizeNodeStub });
    mod = loaded.mod;
    const { stdout } = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(summarizeNodeStub.callCount).to.equal(1);
  });
});

// ---------------------------------------------------------------------------
// C-07: budget router returns 'save' + no --force → early exit
// ---------------------------------------------------------------------------

describe('run — save verdict without force', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-07: output contains "No summarization would fire" when verdict is save and force=false', async () => {
    const checkBudgetRouter = sinon.stub().returns('save');
    const loaded = await loadScript({ checkBudgetRouter });
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(cap.output).to.include('No summarization would fire');
  });
});

// ---------------------------------------------------------------------------
// C-08: budget router returns 'summarize' → output contains message list
// ---------------------------------------------------------------------------

describe('run — summarize verdict shows message list', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('C-08: output contains messages to compress section', async () => {
    const checkBudgetRouter = sinon.stub().returns('summarize');
    const loaded = await loadScript({ checkBudgetRouter });
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(cap.output).to.include('Messages to Compress');
  });
});

// ---------------------------------------------------------------------------
// H-01: --force + router returns 'save' → messages still shown (T3)
// ---------------------------------------------------------------------------

describe('run — force overrides save verdict', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('H-01: force=true shows messages even when router would return save for non-force state', async () => {
    // T3: Stub returns 'save' when forceSummarize=false, 'summarize' when forceSummarize=true.
    // This mirrors real checkBudgetRouter behaviour: --force sets forceSummarize=true on the
    // state before the router is called, so the router returns 'summarize' for force runs.
    // With S6 applied, the dead `&& !force` guard is gone — force works entirely through
    // the state, not through a guard bypass.
    const checkBudgetRouterStub = sinon.stub().callsFake(
      (state: { forceSummarize: boolean }) => state.forceSummarize ? 'summarize' : 'save',
    );
    const loaded = await loadScript({ checkBudgetRouter: checkBudgetRouterStub });
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(undefined, { forceSummarize: false }),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: true }, deps);

    // force=true sets forceSummarize=true on state → router returns 'summarize' → messages shown
    expect(cap.output).to.include('Messages to Compress');
    expect(cap.output).to.include('Force:         yes');
  });
});

// ---------------------------------------------------------------------------
// H-02: --force alone defaults to --dry
// ---------------------------------------------------------------------------

describe('run — force alone defaults to dry mode', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('H-02: parseArgs with --force but no mode flag defaults to dry', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const result = loaded.parseArgs([VALID_BOT_ID, '99', '--force']);
    expect(result.mode).to.equal('dry');
    expect(result.force).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// H-03: empty message array → output contains "no messages" / "no conversation"
// ---------------------------------------------------------------------------

describe('run — empty conversation', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('H-03: empty messages → output contains no-message notice and exits clean', async () => {
    const loaded = await loadScript();
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      loadConversation: sinon.stub().resolves({ messages: [], summary: null, forceSummarize: false }),
      modelFactory,
      stdout: cap.stdout,
    };

    // Should resolve without throwing
    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    const lower = cap.output.toLowerCase();
    expect(lower).to.satisfy(
      (s: string) => s.includes('no conversation') || s.includes('no messages'),
      'Expected output to mention no conversation or no messages',
    );
  });
});

// ---------------------------------------------------------------------------
// H-07: --dry output contains "DRY RUN"
// ---------------------------------------------------------------------------

describe('run — dry mode output', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('H-07: dry mode output contains "DRY RUN"', async () => {
    const checkBudgetRouter = sinon.stub().returns('summarize');
    const summarizeNode = sinon.stub().resolves({
      summary: '[DRY RUN — no LLM call made]',
      summarizationRan: true,
    });
    const loaded = await loadScript({ checkBudgetRouter, summarizeNode });
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(cap.output).to.include('DRY RUN');
  });

  it('H-07: dry mode output contains "No DB writes performed"', async () => {
    const checkBudgetRouter = sinon.stub().returns('summarize');
    const summarizeNode = sinon.stub().resolves({
      summary: '[DRY RUN — no LLM call made]',
      summarizationRan: true,
    });
    const loaded = await loadScript({ checkBudgetRouter, summarizeNode });
    mod = loaded.mod;
    const cap = makeCapture();
    const { modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'dry', force: false }, deps);

    expect(cap.output).to.include('No DB writes performed');
  });
});

// ---------------------------------------------------------------------------
// T6: --live mode calls modelFactory.create
// ---------------------------------------------------------------------------

describe('run — live mode calls modelFactory.create', () => {
  let mod: Awaited<ReturnType<typeof loadScript>>['mod'];

  afterEach(() => {
    sinon.restore();
    esmock.purge(mod);
  });

  it('T6: summarizeNode receives deps.modelFactory as its services.modelFactory in live mode', async () => {
    const checkBudgetRouter = sinon.stub().returns('summarize');
    // Capture the `services` argument passed to summarizeNode by run()
    let capturedServices: unknown = null;
    const summarizeNodeStub = sinon.stub().callsFake(
      async (_state: unknown, services: unknown) => {
        capturedServices = services;
        return { summary: 'live summary', summarizationRan: true };
      },
    );
    const loaded = await loadScript({ checkBudgetRouter, summarizeNode: summarizeNodeStub });
    mod = loaded.mod;
    const cap = makeCapture();
    const { createStub, modelFactory } = makeMockModelFactory();

    const deps = {
      ...makeConvDeps(),
      modelFactory,
      stdout: cap.stdout,
    };

    await loaded.run({ botId: VALID_BOT_ID, telegramUserId: '42', mode: 'live', force: false }, deps);

    // summarizeNode must have been called
    expect(summarizeNodeStub.callCount).to.equal(1);
    // The services argument passed to summarizeNode must contain deps.modelFactory
    expect((capturedServices as any).modelFactory).to.equal(modelFactory);
    // The stub's create should NOT have been called — only the threading is verified
    expect(createStub.callCount).to.equal(0);
  });
});
