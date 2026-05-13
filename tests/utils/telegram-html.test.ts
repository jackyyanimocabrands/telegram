import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toTelegramHtml } from '../../src/utils/telegram-html.js';

describe('toTelegramHtml()', () => {
  // 1. Plain text with no markdown — HTML special chars are escaped
  it('returns plain text unchanged (no markdown)', () => {
    expect(toTelegramHtml('Hello world')).to.equal('Hello world');
  });

  it('escapes & in plain text', () => {
    expect(toTelegramHtml('a & b')).to.equal('a &amp; b');
  });

  it('escapes < and > in plain text', () => {
    expect(toTelegramHtml('a < b > c')).to.equal('a &lt; b &gt; c');
  });

  // 2. Bold
  it('converts **bold** to <b>bold</b>', () => {
    expect(toTelegramHtml('**bold**')).to.equal('<b>bold</b>');
  });

  // 3. Italic *text*
  it('converts *italic* to <i>italic</i>', () => {
    expect(toTelegramHtml('*italic*')).to.equal('<i>italic</i>');
  });

  // 4. Italic _text_
  it('converts _italic_ to <i>italic</i>', () => {
    expect(toTelegramHtml('_italic_')).to.equal('<i>italic</i>');
  });

  // 5. Strikethrough
  it('converts ~~strike~~ to <s>strike</s>', () => {
    expect(toTelegramHtml('~~strike~~')).to.equal('<s>strike</s>');
  });

  // 6. Inline code
  it('converts `code` to <code>code</code>', () => {
    expect(toTelegramHtml('`code`')).to.equal('<code>code</code>');
  });

  // 7. Fenced code block
  it('converts fenced code block to <pre><code>...</code></pre>', () => {
    const input = '```\nconst x = 1;\n```';
    expect(toTelegramHtml(input)).to.equal('<pre><code>const x = 1;</code></pre>');
  });

  // 8. Heading level 1
  it('converts # Heading to <b>Heading</b>', () => {
    expect(toTelegramHtml('# Heading')).to.equal('<b>Heading</b>');
  });

  // 9. Heading level 2
  it('converts ## Heading to <b>Heading</b>', () => {
    expect(toTelegramHtml('## Heading')).to.equal('<b>Heading</b>');
  });

  // 10. Raw HTML-special chars in plain text
  it('escapes & to &amp;', () => {
    expect(toTelegramHtml('A&B')).to.equal('A&amp;B');
  });

  it('escapes < to &lt; and > to &gt;', () => {
    expect(toTelegramHtml('<tag>')).to.equal('&lt;tag&gt;');
  });

  // 11. < and > inside fenced code block are escaped within <pre><code>
  it('escapes < and > inside fenced code block', () => {
    const input = '```\n<div>hello</div>\n```';
    expect(toTelegramHtml(input)).to.equal('<pre><code>&lt;div&gt;hello&lt;/div&gt;</code></pre>');
  });

  // 12. Mixed: bold + italic in same string
  it('handles bold and italic together', () => {
    const result = toTelegramHtml('**bold** and *italic*');
    expect(result).to.equal('<b>bold</b> and <i>italic</i>');
  });

  // 13. Empty string
  it('returns empty string unchanged', () => {
    expect(toTelegramHtml('')).to.equal('');
  });
});
