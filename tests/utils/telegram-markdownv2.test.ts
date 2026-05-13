import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toTelegramMarkdownV2 } from '../../src/utils/telegram-markdownv2.js';

describe('toTelegramMarkdownV2', () => {
  it('passes plain alphabetic text through unchanged', () => {
    expect(toTelegramMarkdownV2('hello world')).to.equal('hello world');
  });

  it('escapes a dot in plain text', () => {
    expect(toTelegramMarkdownV2('hello.world')).to.equal('hello\\.world');
  });

  it('converts **bold** to *bold*', () => {
    expect(toTelegramMarkdownV2('**bold**')).to.equal('*bold*');
  });

  it('converts _italic_ to _italic_', () => {
    expect(toTelegramMarkdownV2('_italic_')).to.equal('_italic_');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(toTelegramMarkdownV2('~~strike~~')).to.equal('~strike~');
  });

  it('preserves inline code unchanged (no special chars inside)', () => {
    expect(toTelegramMarkdownV2('`code`')).to.equal('`code`');
  });

  it('converts # Heading to *Heading*', () => {
    expect(toTelegramMarkdownV2('# Heading')).to.equal('*Heading*');
  });

  it('escapes dot inside bold content', () => {
    expect(toTelegramMarkdownV2('**bold with . dot**')).to.equal('*bold with \\. dot*');
  });

  it('escapes backtick inside fenced code block', () => {
    const input = '```\nlet x = `hello`;\n```';
    const output = toTelegramMarkdownV2(input);
    // outer ``` preserved, inner backtick escaped
    expect(output).to.include('```');
    expect(output).to.include('\\`');
  });

  it('handles mixed bold + plain text + inline code', () => {
    const input = '**hello** world `code`';
    const output = toTelegramMarkdownV2(input);
    expect(output).to.include('*hello*');
    expect(output).to.include('world');
    expect(output).to.include('`code`');
  });

  it('returns empty string unchanged', () => {
    expect(toTelegramMarkdownV2('')).to.equal('');
  });

  it('escapes all MarkdownV2 special chars in plain text', () => {
    const input = 'price: 1.00 (usd) [link] {key} | test! #tag +1 -1 =x';
    const output = toTelegramMarkdownV2(input);
    // None of the special chars should appear unescaped
    // Check a few representative ones
    expect(output).to.include('1\\.00');
    expect(output).to.include('\\(usd\\)');
    expect(output).to.include('\\[link\\]');
    expect(output).to.include('\\|');
    expect(output).to.include('\\!');
  });

  it('converts ## heading to *heading*', () => {
    expect(toTelegramMarkdownV2('## Section')).to.equal('*Section*');
  });

  it('converts ### heading to *heading*', () => {
    expect(toTelegramMarkdownV2('### Sub')).to.equal('*Sub*');
  });

  it('converts [text](url) link', () => {
    const output = toTelegramMarkdownV2('[click here](https://example.com)');
    expect(output).to.equal('[click here](https://example.com)');
  });

  it('escapes special chars inside link text but not URL', () => {
    const output = toTelegramMarkdownV2('[hello.world](https://example.com/path)');
    expect(output).to.equal('[hello\\.world](https://example.com/path)');
  });
});
