/**
 * Unit tests for createDatetimePlugin (plugins/datetime.ts)
 */
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { EphemeralContextPlugin } from '../../../../src/services/ephemeral-context/types.js';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    EPHEMERAL_CONTEXT_ENABLED: true,
    EPHEMERAL_CONTEXT_DATETIME_ENABLED: true,
    DATETIME_FORMAT: 'iso',
    ...overrides,
  } as any;
}

async function loadDatetimePlugin() {
  const module = await esmock('../../../../src/services/ephemeral-context/plugins/datetime.js', {});
  return module.createDatetimePlugin as (env: any) => EphemeralContextPlugin;
}

describe('createDatetimePlugin', () => {
  let lastMod: any;

  afterEach(async () => {
    if (lastMod) {
      await esmock.purge(lastMod);
      lastMod = undefined;
    }
    sinon.restore();
  });

  async function loadPlugin() {
    lastMod = await esmock('../../../../src/services/ephemeral-context/plugins/datetime.js', {});
    return lastMod.createDatetimePlugin as (env: any) => EphemeralContextPlugin;
  }

  // ── enabled() ────────────────────────────────────────────────────────────
  // NOTE: The registry enforces EPHEMERAL_CONTEXT_ENABLED; plugins only check their own flag.

  it('enabled() returns true when EPHEMERAL_CONTEXT_DATETIME_ENABLED is true', async () => {
    const createDatetimePlugin = await loadPlugin();
    const plugin = createDatetimePlugin(makeEnv());
    expect(plugin.enabled(makeEnv())).to.be.true;
  });

  it('enabled() returns true even when EPHEMERAL_CONTEXT_ENABLED is false (registry owns that check)', async () => {
    const createDatetimePlugin = await loadPlugin();
    const plugin = createDatetimePlugin(makeEnv());
    expect(plugin.enabled(makeEnv({ EPHEMERAL_CONTEXT_ENABLED: false }))).to.be.true;
  });

  it('enabled() returns false when EPHEMERAL_CONTEXT_DATETIME_ENABLED is false', async () => {
    const createDatetimePlugin = await loadPlugin();
    const plugin = createDatetimePlugin(makeEnv());
    expect(plugin.enabled(makeEnv({ EPHEMERAL_CONTEXT_DATETIME_ENABLED: false }))).to.be.false;
  });

  // ── build() — format: iso ─────────────────────────────────────────────────

  it('build() with format "iso" returns ISO string', async () => {
    const createDatetimePlugin = await loadPlugin();
    const fixedDate = new Date('2024-06-15T12:30:00.000Z');
    const plugin = createDatetimePlugin(makeEnv({ DATETIME_FORMAT: 'iso' }));
    const result = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => fixedDate });
    expect(result).to.equal('Current UTC date and time: 2024-06-15T12:30:00.000Z');
  });

  // ── build() — format: rfc2822 ─────────────────────────────────────────────

  it('build() with format "rfc2822" returns toUTCString() result', async () => {
    const createDatetimePlugin = await loadPlugin();
    const fixedDate = new Date('2024-06-15T12:30:00.000Z');
    const plugin = createDatetimePlugin(makeEnv({ DATETIME_FORMAT: 'rfc2822' }));
    const result = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => fixedDate });
    expect(result).to.equal(`Current UTC date and time: ${fixedDate.toUTCString()}`);
  });

  // ── build() — format: unix ────────────────────────────────────────────────

  it('build() with format "unix" returns integer epoch seconds string (no decimal)', async () => {
    const createDatetimePlugin = await loadPlugin();
    const fixedDate = new Date('2024-06-15T12:30:00.000Z');
    const expectedEpoch = String(Math.floor(fixedDate.getTime() / 1000));
    const plugin = createDatetimePlugin(makeEnv({ DATETIME_FORMAT: 'unix' }));
    const result = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => fixedDate });
    expect(result).to.equal(`Current UTC date and time: ${expectedEpoch}`);
    // Must be an integer — no decimal point
    expect(result).to.not.include('.');
  });

  it('unix format result does not contain decimal point for any whole-second timestamp', async () => {
    const createDatetimePlugin = await loadPlugin();
    const fixedDate = new Date('2000-01-01T00:00:00.500Z'); // 500ms offset
    const plugin = createDatetimePlugin(makeEnv({ DATETIME_FORMAT: 'unix' }));
    const result = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => fixedDate }) as string;
    const numStr = result.replace('Current UTC date and time: ', '');
    expect(numStr).to.match(/^\d+$/); // digits only — no decimal
  });

  // ── getNow stub controls output ────────────────────────────────────────────

  it('uses getNow() to get the current time (stub controls output)', async () => {
    const createDatetimePlugin = await loadPlugin();
    const date1 = new Date('2024-01-01T00:00:00.000Z');
    const date2 = new Date('2025-12-31T23:59:59.000Z');
    const plugin = createDatetimePlugin(makeEnv({ DATETIME_FORMAT: 'iso' }));

    const result1 = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => date1 });
    const result2 = plugin.build({ botId: 'b', userId: '1', toolsetState: {}, getNow: () => date2 });

    expect(result1).to.include('2024-01-01');
    expect(result2).to.include('2025-12-31');
  });

  // ── plugin name ───────────────────────────────────────────────────────────

  it('plugin name is "datetime"', async () => {
    const createDatetimePlugin = await loadPlugin();
    const plugin = createDatetimePlugin(makeEnv());
    expect(plugin.name).to.equal('datetime');
  });
});
