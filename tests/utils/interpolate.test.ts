import { describe, it } from 'mocha';
import { expect } from 'chai';
import { interpolate } from '../../src/utils/interpolate.js';

describe('interpolate', () => {
  it('replaces a single placeholder', () => {
    expect(interpolate('Hello {name}!', { name: 'Alice' })).to.equal('Hello Alice!');
  });

  it('replaces multiple distinct placeholders', () => {
    expect(interpolate('{greeting} {name}', { greeting: 'Hi', name: 'Bob' }))
      .to.equal('Hi Bob');
  });

  it('replaces the same placeholder appearing multiple times', () => {
    expect(interpolate('{x} and {x}', { x: 'yes' })).to.equal('yes and yes');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(interpolate('See {link} and {other}', { link: 'https://example.com' }))
      .to.equal('See https://example.com and {other}');
  });

  it('returns the template unchanged when vars is empty', () => {
    expect(interpolate('Hello {name}', {})).to.equal('Hello {name}');
  });

  it('returns an empty string for an empty template', () => {
    expect(interpolate('', { name: 'Alice' })).to.equal('');
  });

  it('handles a template with no placeholders', () => {
    expect(interpolate('No placeholders here.', { name: 'Alice' }))
      .to.equal('No placeholders here.');
  });

  it('replaces with an empty string when the var value is empty', () => {
    expect(interpolate('Hello {name}!', { name: '' })).to.equal('Hello !');
  });
});
