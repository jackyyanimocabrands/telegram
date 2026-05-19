import { describe, it } from 'mocha';
import { expect } from 'chai';
import { splitAtSentenceBoundary, trimToLastSentence } from '../../src/utils/split-message.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 4096;

/** Repeat `char` exactly `n` times. */
function repeat(char: string, n: number): string {
  return char.repeat(n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('splitAtSentenceBoundary()', () => {
  // 1. Text ≤ 4096 chars → single-element array with original text
  it('returns single-element array when text is shorter than the limit', () => {
    const text = 'Hello world. This is a short message.';
    const result = splitAtSentenceBoundary(text);
    expect(result).to.deep.equal([text]);
  });

  // 2. Text exactly 4096 chars → single-element array
  it('returns single-element array when text is exactly the limit (4096 chars)', () => {
    const text = repeat('a', DEFAULT_LIMIT);
    const result = splitAtSentenceBoundary(text);
    expect(result).to.have.length(1);
    expect(result[0]).to.equal(text);
  });

  // 3. Empty string → returns ['']
  it("returns [''] for an empty string", () => {
    const result = splitAtSentenceBoundary('');
    expect(result).to.deep.equal(['']);
  });

  // 4. Text > limit with `. ` boundary in the window → splits after period+space
  it('splits at the last ". " boundary within the limit window', () => {
    // Place a `. ` near char 100 inside the first 4096 window, then pad past the limit.
    const firstSentence = repeat('a', 100) + '. ';
    const rest = repeat('b', DEFAULT_LIMIT); // guarantees total > 4096
    const text = firstSentence + rest;

    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.be.greaterThan(1);
    // The first chunk must end with the content before `. ` (trimEnd removes trailing space)
    expect(result[0]).to.match(/^a+\.$/);
  });

  // 5. Text > limit with `! ` boundary → splits after `! `
  it('splits at the last "! " boundary within the limit window', () => {
    const firstSentence = repeat('x', 80) + '! ';
    const rest = repeat('y', DEFAULT_LIMIT);
    const text = firstSentence + rest;

    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.be.greaterThan(1);
    expect(result[0]).to.match(/^x+!$/);
  });

  // 6. Text > limit with `? ` boundary → splits after `? `
  it('splits at the last "? " boundary within the limit window', () => {
    const firstSentence = repeat('q', 90) + '? ';
    const rest = repeat('r', DEFAULT_LIMIT);
    const text = firstSentence + rest;

    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.be.greaterThan(1);
    expect(result[0]).to.match(/^q+\?$/);
  });

  // 7. Text > limit with `\n\n` boundary → splits after double newline
  it('splits at the last "\\n\\n" boundary within the limit window', () => {
    const firstPara = repeat('p', 200) + '\n\n';
    const rest = repeat('s', DEFAULT_LIMIT);
    const text = firstPara + rest;

    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.be.greaterThan(1);
    // After trimEnd the first chunk is just the paragraph text (no trailing newlines)
    expect(result[0]).to.equal(repeat('p', 200));
  });

  // 8. Text > limit with no sentence boundary → hard split at exactly `limit` chars
  it('hard-splits at the limit when there is no sentence boundary', () => {
    // One long run of 'a' with no sentence endings, length = limit + 50
    const text = repeat('a', DEFAULT_LIMIT + 50);
    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.equal(2);
    expect(result[0]).to.equal(repeat('a', DEFAULT_LIMIT));
    expect(result[1]).to.equal(repeat('a', 50));
  });

  // 9. Text requiring multiple splits (> 2× limit) → each part ≤ limit
  it('handles text requiring multiple splits — each part is within the limit', () => {
    // Three times the limit with no sentence boundaries
    const text = repeat('z', DEFAULT_LIMIT * 3 + 10);
    const result = splitAtSentenceBoundary(text);

    expect(result.length).to.be.greaterThan(2);
    for (const part of result) {
      expect(part.length).to.be.at.most(DEFAULT_LIMIT);
    }
  });

  // 10. Custom limit parameter works correctly
  it('respects a custom limit parameter', () => {
    const limit = 10;
    // "Hello world! Bye." — 18 chars, no boundary within first 10 → hard split
    const text = 'Hello world! Bye.';
    const result = splitAtSentenceBoundary(text, limit);

    expect(result.length).to.be.greaterThan(1);
    for (const part of result) {
      expect(part.length).to.be.at.most(limit);
    }
  });

  // 10b. Custom limit with a sentence boundary present
  it('splits at sentence boundary with custom limit', () => {
    const limit = 10;
    // "Hello. World extra words here" — `. ` at index 5, split after it
    const text = 'Hello. World extra words here!';
    const result = splitAtSentenceBoundary(text, limit);

    expect(result[0]).to.equal('Hello.');
    // remainder must also be within limit or split further
    for (const part of result) {
      expect(part.length).to.be.at.most(limit);
    }
  });

  // 11. Parts are trimmed — no leading/trailing whitespace
  it('each part has no leading or trailing whitespace', () => {
    const firstSentence = repeat('a', 50) + '. ';
    const rest = repeat('b', DEFAULT_LIMIT);
    const text = firstSentence + rest;
    const result = splitAtSentenceBoundary(text);

    for (const part of result) {
      expect(part).to.equal(part.trim());
    }
  });

  // 12. Reconstructing all parts accounts for all content (no characters lost, modulo trimming)
  it('joining all parts with " " recovers the original text modulo trimming', () => {
    // Build a text with clear sentence boundaries so no hard splits occur.
    // Each sentence is short enough that many fit within 4096 chars.
    const sentence = repeat('w', 80) + '. ';   // 83 chars
    // ~50 sentences → ~4150 chars → forces at least one split
    const text = sentence.repeat(50).trimEnd();

    const result = splitAtSentenceBoundary(text);

    // Re-assemble: join chunks with a single space (accounts for the trimEnd on each chunk
    // and trimStart on the next token).  All word chars must be present.
    const reassembled = result.join(' ').replace(/\s+/g, ' ').trim();
    const originalNormalised = text.replace(/\s+/g, ' ').trim();

    expect(reassembled).to.equal(originalNormalised);
  });
});

// ---------------------------------------------------------------------------
// trimToLastSentence()
// ---------------------------------------------------------------------------

describe('trimToLastSentence()', () => {
  it('returns text up to last ". " when trailing partial exists', () => {
    expect(trimToLastSentence('Hello world. This is partial')).to.equal('Hello world.');
  });

  it('returns text up to last "? " with multiple sentence enders', () => {
    expect(trimToLastSentence('First! Second? Third partial')).to.equal('First! Second?');
  });

  it('returns empty string when no sentence boundary found', () => {
    expect(trimToLastSentence('No sentence boundary')).to.equal('');
  });

  it('handles ".\\n" sentence boundary', () => {
    expect(trimToLastSentence('Complete sentence.\nAnother partial')).to.equal('Complete sentence.');
  });

  it('handles "\\n\\n" paragraph boundary', () => {
    expect(trimToLastSentence('Para one.\n\nPara two partial')).to.equal('Para one.');
  });

  it('trims trailing whitespace when text ends with sentence and space', () => {
    expect(trimToLastSentence('Ends with sentence. ')).to.equal('Ends with sentence.');
  });

  it('returns empty string for empty input', () => {
    expect(trimToLastSentence('')).to.equal('');
  });

  it('handles single word sentence followed by trailing space', () => {
    expect(trimToLastSentence('Only. ')).to.equal('Only.');
  });
});
