import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, SystemMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
import { toBaseMessages, fromBaseMessages } from '../../src/services/conversation.js';

// ---------------------------------------------------------------------------
// toBaseMessages
// ---------------------------------------------------------------------------

describe('toBaseMessages', () => {
  it('converts role "user" → HumanMessage instance', () => {
    const result = toBaseMessages([{ role: 'user', content: 'hello' }]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(HumanMessage);
  });

  it('converts role "assistant" → AIMessage instance', () => {
    const result = toBaseMessages([{ role: 'assistant', content: 'hi there' }]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(AIMessage);
  });

  it('converts role "system" → SystemMessage instance', () => {
    const result = toBaseMessages([{ role: 'system', content: 'You are helpful.' }]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(SystemMessage);
  });

  it('returns empty array for empty input', () => {
    const result = toBaseMessages([]);
    expect(result).to.deep.equal([]);
  });

  it('preserves message order for multiple messages', () => {
    const input = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'system', content: 'third' },
    ] as const;
    const result = toBaseMessages(input as any);
    expect(result).to.have.length(3);
    expect(result[0]).to.be.instanceOf(HumanMessage);
    expect(result[1]).to.be.instanceOf(AIMessage);
    expect(result[2]).to.be.instanceOf(SystemMessage);
  });

  it('preserves content exactly — unicode and special characters', () => {
    const content = '你好世界 🌍 <script>alert("xss")</script>\n\t"quotes"';
    const result = toBaseMessages([{ role: 'user', content }]);
    expect(result[0].content).to.equal(content);
  });

  it('unknown role falls back gracefully without throwing', () => {
    // Cast to any to bypass TypeScript's type guard — runtime fallback matters
    const result = toBaseMessages([{ role: 'function' as any, content: 'tool output' }]);
    expect(result).to.have.length(1);
    // Implementation falls back to HumanMessage for unknown roles
    expect(result[0].content).to.equal('tool output');
    // T11: verify the fallback TYPE is HumanMessage, not just the content
    expect(result[0]).to.be.instanceOf(HumanMessage);
  });
});

// ---------------------------------------------------------------------------
// fromBaseMessages
// ---------------------------------------------------------------------------

describe('fromBaseMessages', () => {
  it('converts HumanMessage → { role: "user", content: "..." }', () => {
    const result = fromBaseMessages([new HumanMessage('hello')]);
    expect(result).to.deep.equal([{ role: 'user', content: 'hello' }]);
  });

  it('converts AIMessage → { role: "assistant", content: "..." }', () => {
    const result = fromBaseMessages([new AIMessage('reply')]);
    expect(result).to.deep.equal([{ role: 'assistant', content: 'reply' }]);
  });

  it('converts SystemMessage → { role: "system", content: "..." }', () => {
    const result = fromBaseMessages([new SystemMessage('You are helpful.')]);
    expect(result).to.deep.equal([{ role: 'system', content: 'You are helpful.' }]);
  });

  it('returns empty array for empty input', () => {
    const result = fromBaseMessages([]);
    expect(result).to.deep.equal([]);
  });

  it('filters out RemoveMessage instances (not included in output)', () => {
    const messages = [
      new HumanMessage('keep me'),
      new RemoveMessage({ id: 'msg-1' }),
      new AIMessage('also keep'),
    ];
    const result = fromBaseMessages(messages);
    expect(result).to.have.length(2);
    expect(result[0]).to.deep.equal({ role: 'user', content: 'keep me' });
    expect(result[1]).to.deep.equal({ role: 'assistant', content: 'also keep' });
  });

  it('JSON-stringifies non-string (array) content safely', () => {
    // Simulate a tool call message with array content
    const toolContent = [{ type: 'text', text: 'result' }];
    const msg = new AIMessage({ content: toolContent as any });
    const result = fromBaseMessages([msg]);
    expect(result).to.have.length(1);
    expect(result[0].content).to.equal(JSON.stringify(toolContent));
  });

  // ── Round-trip ─────────────────────────────────────────────────────────────

  it('round-trip: fromBaseMessages(toBaseMessages(messages)) equals original for user/assistant/system', () => {
    const original = [
      { role: 'user' as const, content: 'Hello!' },
      { role: 'assistant' as const, content: 'Hi there!' },
      { role: 'system' as const, content: 'Be helpful.' },
    ];
    const converted = toBaseMessages(original);
    const roundTripped = fromBaseMessages(converted);
    expect(roundTripped).to.deep.equal(original);
  });

  it('round-trip preserves unicode content', () => {
    const original = [{ role: 'user' as const, content: '日本語テスト 🎌' }];
    const roundTripped = fromBaseMessages(toBaseMessages(original));
    expect(roundTripped).to.deep.equal(original);
  });

  // T9: ToolMessage filter tests
  it('filters out ToolMessage — returns empty array for single ToolMessage input', () => {
    // ToolMessage.getType() === 'tool' which is explicitly filtered by fromBaseMessages
    const result = fromBaseMessages([
      new ToolMessage({ content: 'result', tool_call_id: 'call1' }),
    ]);
    expect(result).to.have.length(0);
  });

  it('mixed array [HumanMessage, ToolMessage, AIMessage] — documents ToolMessage handling', () => {
    const mixed = [
      new HumanMessage('user question'),
      new ToolMessage({ content: 'tool result', tool_call_id: 'call1' }),
      new AIMessage('assistant answer'),
    ];
    const result = fromBaseMessages(mixed);
    // HumanMessage and AIMessage are always included
    const userMsg = result.find(m => m.role === 'user' && m.content === 'user question');
    const assistantMsg = result.find(m => m.role === 'assistant' && m.content === 'assistant answer');
    expect(userMsg).to.exist;
    expect(assistantMsg).to.exist;
  });
});
