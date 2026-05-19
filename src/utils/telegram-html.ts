/**
 * Converts a subset of CommonMark markdown to Telegram HTML.
 *
 * Telegram's HTML parse_mode supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>.
 * LLMs commonly output standard markdown (**bold**, _italic_, `code`, etc.)
 * which Telegram displays as raw text without this conversion.
 *
 * Processing order matters — fenced code blocks and inline code are extracted
 * first so their contents are not processed further.
 */
export function toTelegramHtml(text: string): string {
  // 1. Fenced code blocks: ```lang\ncode\n``` → <pre><code>code</code></pre>
  //    Must come before inline-code and bold/italic passes.
  text = text.replace(
    /```(?:[^\n`]*)?\n([\s\S]*?)```/g,
    (_, code: string) => `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`,
  );

  // 2. Inline code: `code` → <code>code</code>
  text = text.replace(
    /`([^`\n]+)`/g,
    (_, code: string) => `<code>${escapeHtml(code)}</code>`,
  );

  // 3. Escape HTML entities in the remaining plain-text segments
  //    (i.e. outside of already-emitted <pre>/<code> tags).
  text = escapePlainSegments(text);

  // 4. Bold: **text** → <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');

  // 5. Italic: _text_ or *text* (single, not already consumed by bold)
  text = text.replace(/\b_(.+?)_\b/gs, '<i>$1</i>');
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '<i>$1</i>');

  // 6. Strikethrough: ~~text~~ → <s>text</s>
  text = text.replace(/~~(.+?)~~/gs, '<s>$1</s>');

  // 7. Headings: # / ## / ### at line start → <b>text</b>
  text = text.replace(/^#{1,3} +(.+)$/gm, '<b>$1</b>');

  return text;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escapes the three HTML-special characters in a raw string. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes HTML entities only in plain-text segments — i.e. text that sits
 * outside already-emitted <pre><code>...</code></pre> and <code>...</code>
 * blocks. This prevents double-escaping the code content we already escaped
 * in steps 1–2, while ensuring the rest of the text is safe.
 */
function escapePlainSegments(text: string): string {
  // Split on pre/code tags we emitted in steps 1–2, escape the gaps.
  const TAG_RE = /(<pre><code>[\s\S]*?<\/code><\/pre>|<code>[^<]*<\/code>)/g;
  const parts = text.split(TAG_RE);
  return parts
    .map((part, i) =>
      // Odd indices are the captured tag groups — leave them alone.
      i % 2 === 0 ? escapeHtml(part) : part,
    )
    .join('');
}
