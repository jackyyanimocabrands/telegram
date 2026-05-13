/**
 * Splits a text string into chunks that each fit within `limit` characters,
 * preferring to break at sentence boundaries (`. `, `! `, `? `, double newline)
 * rather than mid-sentence.
 *
 * If no sentence boundary exists within the limit window, falls back to a hard
 * split at exactly `limit` characters.
 *
 * Used to comply with Telegram's 4096-character sendMessage limit.
 *
 * @param text   The full text to split.
 * @param limit  Maximum characters per chunk. Defaults to 4096.
 * @returns      Array of non-empty trimmed chunks. Returns `['']` for empty input.
 */
export function splitAtSentenceBoundary(text: string, limit = 4096): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const SENTENCE_ENDERS = ['\n\n', '. ', '! ', '? ', '.\n', '!\n', '?\n'];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Find the last sentence boundary within the window
    let splitIdx = -1;
    for (const ender of SENTENCE_ENDERS) {
      const idx = window.lastIndexOf(ender);
      if (idx !== -1) {
        const candidate = idx + ender.length;
        if (candidate > splitIdx) {
          splitIdx = candidate;
        }
      }
    }

    // No sentence boundary found — hard split at limit
    if (splitIdx <= 0) {
      splitIdx = limit;
    }

    const chunk = remaining.slice(0, splitIdx).trimEnd();
    if (chunk.length > 0) {
      parts.push(chunk);
    }
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  // Guard: always return at least one element
  return parts.length > 0 ? parts : [''];
}
