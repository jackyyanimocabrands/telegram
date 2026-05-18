import { logger } from '../../../utils/logger.js';
import type { EphemeralContextPlugin } from '../types.js';

/**
 * Locale/timezone plugin.
 * Reads toolsetState.locale (BCP-47 tag from Telegram language_code) and
 * toolsetState.timezone (IANA timezone string, optional).
 *
 * Behaviour:
 *  - locale present → outputs "User's language: <display name> (<code>)"
 *  - locale + timezone present → also outputs "User's local date and time: <formatted>"
 *  - neither present → returns null
 *
 * Validates both values before use:
 *  - locale: validated via Intl.getCanonicalLocales() — invalid BCP-47 tags are skipped
 *  - timezone: must be in Intl.supportedValuesOf('timeZone') or UTC/GMT
 *
 * Uses Intl.DateTimeFormat / Intl.DisplayNames — no external dependency.
 */
export const localePlugin: EphemeralContextPlugin = {
  name: 'locale',
  enabled: (env) => env.EPHEMERAL_CONTEXT_LOCALE_ENABLED,
  build: ({ toolsetState, getNow }) => {
    const rawLocale = typeof toolsetState.locale === 'string' && toolsetState.locale.trim()
      ? toolsetState.locale.trim()
      : null;
    const rawTimezone = typeof toolsetState.timezone === 'string' && toolsetState.timezone.trim()
      ? toolsetState.timezone.trim()
      : null;

    // Nothing to output if both are absent
    if (rawLocale === null && rawTimezone === null) return null;

    const lines: string[] = [];

    // ── Locale → language line ───────────────────────────────────────────────
    let validLocale: string | undefined;
    if (rawLocale !== null) {
      try {
        const canonicals = Intl.getCanonicalLocales([rawLocale]);
        const canonical = canonicals[0];
        if (!canonical) throw new RangeError('empty canonical');
        validLocale = canonical;
        try {
          const displayNames = new Intl.DisplayNames([canonical], { type: 'language' });
          const languageName = displayNames.of(canonical) ?? canonical;
          lines.push(`User's language: ${languageName} (${canonical})`);
        } catch {
          // Intl.DisplayNames unavailable — fall back to raw code
          lines.push(`User's language: ${canonical}`);
        }
      } catch {
        // Invalid BCP-47 tag — skip locale entirely
      }
    }

    // ── Timezone → local datetime line ───────────────────────────────────────
    if (rawTimezone !== null) {
      // Validate timezone against the IANA allowlist — prevents adversarial inputs.
      // UTC and GMT are valid but not always returned by Intl.supportedValuesOf.
      let timezoneValid = rawTimezone === 'UTC' || rawTimezone === 'GMT';
      if (!timezoneValid) {
        try {
          timezoneValid = Intl.supportedValuesOf('timeZone').includes(rawTimezone);
        } catch {
          // Minimal ICU build — skip timezone output
        }
      }

      if (timezoneValid) {
        try {
          const formatter = new Intl.DateTimeFormat(validLocale, {
            timeZone: rawTimezone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            timeZoneName: 'short',
          });
          const formatted = formatter.format(getNow());
          // Strip BIDI control characters and other control sequences
          const sanitized = formatted.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, '');
          lines.push(`User's local date and time: ${sanitized}`);
        } catch {
          logger.warn({ pluginName: 'locale' }, 'locale plugin: Intl.DateTimeFormat threw after validation, skipping datetime line');
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : null;
  },
};
