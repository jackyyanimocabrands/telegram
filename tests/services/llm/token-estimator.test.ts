import { describe, it } from 'mocha';
import { expect } from 'chai';
import { estimateTokens } from '../../../src/services/llm/token-estimator.js';
import type { LlmMessage } from '../../../src/services/llm/provider.js';

describe('token-estimator', () => {
  describe('estimateTokens', () => {
    const cases: Array<{ label: string; messages: LlmMessage[]; expected: number }> = [
      {
        label: 'empty array → 0',
        messages: [],
        expected: 0,
      },
      {
        label: 'single message with 8 chars → 2',
        messages: [{ role: 'user', content: '12345678' }],
        expected: 2,
      },
      {
        label: 'single message with empty content → 0',
        messages: [{ role: 'user', content: '' }],
        expected: 0,
      },
      {
        label: 'multiple messages sum lengths then divide by 4',
        messages: [
          { role: 'system', content: '1234' },    // 4 chars
          { role: 'user', content: '12345678' },  // 8 chars
          { role: 'assistant', content: '1234' }, // 4 chars
          // total: 16 chars → floor(16/4) = 4
        ],
        expected: 4,
      },
      {
        label: 'floor rounding — 9 chars → floor(9/4) = 2',
        messages: [{ role: 'user', content: '123456789' }],
        expected: 2,
      },
      {
        label: 'message with empty content in multi-message array',
        messages: [
          { role: 'system', content: '' },
          { role: 'user', content: '12345678' }, // 8 chars → floor(8/4) = 2
        ],
        expected: 2,
      },
    ];

    for (const { label, messages, expected } of cases) {
      it(label, () => {
        expect(estimateTokens(messages)).to.equal(expected);
      });
    }

    it('never throws on any input', () => {
      expect(() => estimateTokens([])).to.not.throw();
      expect(() => estimateTokens([{ role: 'user', content: '' }])).to.not.throw();
    });
  });
});
