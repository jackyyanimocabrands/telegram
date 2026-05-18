/**
 * Unit tests for localePlugin (plugins/locale.ts)
 */
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { EphemeralContextPlugin } from '../../../../src/services/ephemeral-context/types.js';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    EPHEMERAL_CONTEXT_ENABLED: true,
    EPHEMERAL_CONTEXT_LOCALE_ENABLED: true,
    ...overrides,
  } as any;
}

async function loadLocalePlugin() {
  const module = await esmock('../../../../src/services/ephemeral-context/plugins/locale.js', {
    '../../../../src/utils/logger.js': { logger: { warn: sinon.stub(), info: sinon.stub(), debug: sinon.stub(), error: sinon.stub() } },
  });
  return module.localePlugin as EphemeralContextPlugin;
}

const fixedDate = new Date('2024-06-15T12:30:00.000Z');
const getNow = () => fixedDate;

describe('localePlugin', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── enabled() ─────────────────────────────────────────────────────────────
  // NOTE: The registry enforces EPHEMERAL_CONTEXT_ENABLED; plugins only check their own flag.

  it('enabled() returns true when EPHEMERAL_CONTEXT_LOCALE_ENABLED is true', async () => {
    const localePlugin = await loadLocalePlugin();
    expect(localePlugin.enabled(makeEnv())).to.be.true;
  });

  it('enabled() returns false when EPHEMERAL_CONTEXT_LOCALE_ENABLED is false', async () => {
    const localePlugin = await loadLocalePlugin();
    expect(localePlugin.enabled(makeEnv({ EPHEMERAL_CONTEXT_LOCALE_ENABLED: false }))).to.be.false;
  });

  it('enabled() returns true even when EPHEMERAL_CONTEXT_ENABLED is false (registry owns that check)', async () => {
    const localePlugin = await loadLocalePlugin();
    // The plugin's own enabled() only checks EPHEMERAL_CONTEXT_LOCALE_ENABLED
    expect(localePlugin.enabled(makeEnv({ EPHEMERAL_CONTEXT_ENABLED: false }))).to.be.true;
  });

  // ── build() — both timezone and locale ───────────────────────────────────

  it('build() with both timezone and locale returns output containing prefix', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: 'America/New_York', locale: 'en-US' },
      getNow,
    });
    expect(result).to.be.a('string');
    expect(result as string).to.include("User's local date and time:");
  });

  // ── build() — timezone only (no locale) ───────────────────────────────────

  it('build() with only timezone (no locale) produces output starting with prefix and containing a year', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: 'Europe/London' },
      getNow,
    });
    // Must start with the documented prefix (proves formatting worked)
    expect(result).to.be.a('string');
    expect(result as string).to.include("User's local date and time:");
    // Must contain the year from fixedDate (2024) — proves the formatter ran
    expect(result as string).to.match(/2024/);
  });

  // ── build() — locale only (no timezone) ───────────────────────────────────
  // Per spec: timezone is required. Without it, return null regardless of locale.

  it('build() with only locale (no timezone) returns null (timezone required for meaningful output)', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { locale: 'fr-FR' },
      getNow,
    });
    expect(result).to.be.null;
  });

  // ── build() — neither ─────────────────────────────────────────────────────

  it('build() with neither timezone nor locale returns null', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: {},
      getNow,
    });
    expect(result).to.be.null;
  });

  it('build() with empty toolsetState returns null', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow });
    expect(result).to.be.null;
  });

  // ── build() — invalid timezone ────────────────────────────────────────────

  it('build() with invalid timezone returns null (does not throw)', async () => {
    const localePlugin = await loadLocalePlugin();
    let result: string | null | undefined;
    expect(() => {
      result = localePlugin.build({
        botId: 'b', userId: '1',
        toolsetState: { timezone: 'Not/A/Valid/Timezone' },
        getNow,
      });
    }).to.not.throw();
    // Promise or null — resolve if needed
    if (result instanceof Promise) {
      result = await result;
    }
    expect(result).to.be.null;
  });

  // ── build() — invalid locale string (B8) ─────────────────────────────────

  it('build() with invalid BCP-47 locale "!@@##invalid" returns null without throwing', async () => {
    const localePlugin = await loadLocalePlugin();
    let result: string | null | undefined;
    expect(() => {
      result = localePlugin.build({
        botId: 'b', userId: '1',
        toolsetState: { timezone: 'America/New_York', locale: '!@@##invalid' },
        getNow,
      });
    }).to.not.throw();
    if (result instanceof Promise) result = await result;
    expect(result).to.be.null;
  });

  it('build() with invalid BCP-47 locale "!invalid!" returns null without throwing', async () => {
    const localePlugin = await loadLocalePlugin();
    let result: string | null | undefined;
    expect(() => {
      result = localePlugin.build({
        botId: 'b', userId: '1',
        toolsetState: { timezone: 'America/New_York', locale: '!invalid!' },
        getNow,
      });
    }).to.not.throw();
    if (result instanceof Promise) result = await result;
    expect(result).to.be.null;
  });

  // ── build() — non-string timezone ─────────────────────────────────────────

  it('build() with non-string timezone returns null', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: 12345 },
      getNow,
    });
    expect(result).to.be.null;
  });

  it('build() with null timezone and no locale returns null', async () => {
    const localePlugin = await loadLocalePlugin();
    const result = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: null },
      getNow,
    });
    expect(result).to.be.null;
  });

  // ── getNow controls the date ───────────────────────────────────────────────

  it('getNow stub controls the date in the output', async () => {
    const localePlugin = await loadLocalePlugin();
    const date1 = new Date('2024-01-15T00:00:00.000Z');
    const date2 = new Date('2025-07-04T00:00:00.000Z');

    const r1 = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: 'UTC', locale: 'en-US' },
      getNow: () => date1,
    }) as string;

    const r2 = localePlugin.build({
      botId: 'b', userId: '1',
      toolsetState: { timezone: 'UTC', locale: 'en-US' },
      getNow: () => date2,
    }) as string;

    expect(r1).to.not.equal(r2);
    expect(r1).to.include('2024');
    expect(r2).to.include('2025');
  });

  // ── plugin name ───────────────────────────────────────────────────────────

  it('plugin name is "locale"', async () => {
    const localePlugin = await loadLocalePlugin();
    expect(localePlugin.name).to.equal('locale');
  });
});
