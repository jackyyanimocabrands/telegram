/**
 * Converts plain text / Markdown to Telegram MarkdownV2 format.
 *
 * Uses a save-replace-restore approach so already-formatted segments
 * are never touched by the plain-text escaping pass.
 */
export function toTelegramMarkdownV2(text: string): string {
  const saved: string[] = [];
  const save = (s: string): string => {
    saved.push(s);
    return `\x01${saved.length - 1}\x01`;
  };

  // Step 1: fenced code blocks — escape only ` and \ inside
  text = text.replace(/```(?:[^\n`]*)?\n([\s\S]*?)```/g, (_: string, code: string) =>
    save('```\n' + code.trimEnd().replace(/[`\\]/g, '\\$&') + '\n```'),
  );

  // Step 2: inline code — escape only ` and \ inside
  text = text.replace(/`([^`\n]+)`/g, (_: string, code: string) =>
    save('`' + code.replace(/[`\\]/g, '\\$&') + '`'),
  );

  // Step 3: formatting — escape inner content, save result

  // Bold links: **[text](url)** → *[escapedText](escapedUrl)* (must precede both bold and link handlers)
  text = text.replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/gs, (_: string, t: string, u: string) =>
    save(`*[${escMdV2(t)}](${escUrlMdV2(u)})*`),
  );

  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/gs, (_: string, inner: string) =>
    save('*' + escMdV2(inner) + '*'),
  );

  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/gs, (_: string, inner: string) =>
    save('~' + escMdV2(inner) + '~'),
  );

  // Italic: _text_ (word boundary guard avoids matching snake_case)
  text = text.replace(/\b_(.+?)_\b/gs, (_: string, inner: string) =>
    save('_' + escMdV2(inner) + '_'),
  );

  // Headings: # Heading → *Heading*
  text = text.replace(/^#{1,3} +(.+)$/gm, (_: string, inner: string) =>
    save('*' + escMdV2(inner) + '*'),
  );

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, t: string, u: string) =>
    save(`[${escMdV2(t)}](${escUrlMdV2(u)})`),
  );

  // Step 4: escape remaining plain text
  text = escMdV2(text);

  // Step 5: restore saved segments
  // \x01N\x01 is not in the MarkdownV2 special-char set so it survives step 4 unmodified
  text = text.replace(/\x01(\d+)\x01/g, (_: string, i: string) => saved[Number(i)] ?? '');

  return text;
}

/** Escapes all 18 Telegram MarkdownV2 special characters in plain text. */
function escMdV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Escapes only the characters that must be escaped inside a MarkdownV2 URL part: ) and \. */
function escUrlMdV2(url: string): string {
  return url.replace(/[)\\]/g, '\\$&');
}
