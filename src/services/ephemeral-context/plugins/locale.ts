import { logger } from '../../../utils/logger.js';
import type { EphemeralContextPlugin } from '../types.js';

/**
 * Locale/timezone plugin.
 * Reads toolsetState.timezone and toolsetState.locale.
 *
 * Requires `timezone` to produce output — without a timezone we cannot produce
 * a meaningful local date/time string. `locale` only controls formatting.
 * Returns null gracefully if timezone is absent, invalid, or not in
 * Intl.supportedValuesOf('timeZone').
 *
 * Validates both values before use:
 *  - timezone: must be in Intl.supportedValuesOf('timeZone')
 *  - locale: validated via Intl.getCanonicalLocales() — invalid BCP-47 tags return null
 *
 * Uses Intl.DateTimeFormat — no external dependency.
 */
export const localePlugin: EphemeralContextPlugin = {
  name: 'locale',
  enabled: (env) => env.EPHEMERAL_CONTEXT_LOCALE_ENABLED,
  build: ({ toolsetState, getNow }) => {
    const timezone = typeof toolsetState.timezone === 'string' && toolsetState.timezone.trim()
      ? toolsetState.timezone.trim()
      : null;
    const locale = typeof toolsetState.locale === 'string' && toolsetState.locale.trim()
      ? toolsetState.locale.trim()
      : undefined; // Intl accepts undefined = default locale

    // timezone is required — without it we cannot produce a meaningful local time
    if (timezone === null) return null;

    // Validate timezone against the allowlist — prevents adversarial inputs.
    // UTC and GMT are valid IANA timezones accepted by Intl.DateTimeFormat but are
    // NOT returned by Intl.supportedValuesOf('timeZone') on all Node builds/ICU configs,
    // so they are explicitly allowed here as a safe-listed exception.
    try {
      const supported = Intl.supportedValuesOf('timeZone');
      if (!supported.includes(timezone) && timezone !== 'UTC' && timezone !== 'GMT') return null;
    } catch {
      // Defensive: fails safely to null if Intl.supportedValuesOf is unavailable
      // (e.g., minimal ICU builds). Do not attempt further validation.
      return null;
    }

    // Validate locale — Intl.getCanonicalLocales throws RangeError for invalid BCP-47 tags
    if (locale !== undefined) {
      try {
        Intl.getCanonicalLocales([locale]);
      } catch {
        // Invalid locale tag — return null rather than risk injecting crafted strings
        return null;
      }
    }

    try {
      const formatter = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
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
      // Strip BIDI control characters, non-printable chars, and other control sequences
      // that could interfere with the [Context] block structure in the LLM prompt
      const sanitized = formatted.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, '');
      return `User's local date and time: ${sanitized}`;
    } catch {
      // Intl.DateTimeFormat constructor failed despite validation — log for operator visibility
      // (do NOT log timezone/locale values — they are PII-adjacent)
      logger.warn({ pluginName: 'locale' }, 'locale plugin: Intl.DateTimeFormat threw after validation, returning null');
      return null;
    }
  },
};
