/**
 * Replace `{key}` placeholders in a template string with values from `vars`.
 * Placeholders with no matching key are left unchanged.
 *
 * @example
 *   interpolate('Hello {name}!', { name: 'Alice' }) // → 'Hello Alice!'
 *   interpolate('Hi {name}, see {link}', { name: 'Bob' }) // → 'Hi Bob, see {link}'
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}
