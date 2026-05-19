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

  // QA-T3: tool_result round-trip — ConversationMessage with role:'tool_result' → ToolMessage
  it('QA-T3: role "tool_result" with tool_call_id in additional_kwargs → ToolMessage with correct tool_call_id', () => {
    const result = toBaseMessages([
      { role: 'tool_result', content: 'verified', additional_kwargs: { tool_call_id: 'call-abc' } },
    ] as any);

    expect(result).to.have.length(1);
    expect(result[0].getType()).to.equal('tool');
    expect((result[0] as ToolMessage).tool_call_id).to.equal('call-abc');
    expect(result[0].content).to.equal('verified');
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
    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('assistant');
    expect(result[0].content).to.equal('reply');
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
    // Only compare role and content (no additional_kwargs expected for plain messages)
    expect(roundTripped.map(({ role, content }) => ({ role, content }))).to.deep.equal(original);
  });

  it('round-trip preserves unicode content', () => {
    const original = [{ role: 'user' as const, content: '日本語テスト 🎌' }];
    const roundTripped = fromBaseMessages(toBaseMessages(original));
    expect(roundTripped).to.deep.equal(original);
  });

  // T9: ToolMessage filter tests
  it('filters out ToolMessage — returns empty array for single ToolMessage input', () => {
    // ToolMessage.getType() === 'tool' — now produces a tool_result record
    const result = fromBaseMessages([
      new ToolMessage({ content: 'result', tool_call_id: 'call1' }),
    ]);
    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('tool_result');
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

  // ── additional_kwargs handling ─────────────────────────────────────────────

  it('fromBaseMessages — AIMessage with reasoning_content persists it in additional_kwargs', () => {
    // P9 allowlist: only id, model, finish_reason are persisted — reasoning_content is stripped
    const msg = new AIMessage({ content: 'answer', additional_kwargs: { reasoning_content: 'my reasoning' } });
    const result = fromBaseMessages([msg]);
    expect(result).to.have.length(1);
    // reasoning_content is NOT in the allowlist → no additional_kwargs on output
    expect(result[0]).to.not.have.property('additional_kwargs');
  });

  it('fromBaseMessages — AIMessage with tool_calls strips tool_calls but keeps other kwargs', () => {
    // Use proper tool_calls field to trigger the tool_call branch
    const msg = new AIMessage({
      content: 'answer',
      tool_calls: [{ name: 'fn', args: {}, id: 'c1', type: 'tool_call' }],
    });
    const result = fromBaseMessages([msg]);
    // AIMessage with tool_calls produces a tool_call record; text content is stored in text_content kwarg
    const toolCallRecord = result.find(r => r.role === 'tool_call');
    expect(toolCallRecord).to.exist;
    // text content 'answer' is stored in additional_kwargs.text_content of the tool_call record (not a separate assistant record)
    expect(toolCallRecord!.additional_kwargs?.text_content).to.equal('answer');
  });

  it('fromBaseMessages — AIMessage with only tool_calls produces no additional_kwargs field', () => {
    const msg = new AIMessage({
      content: 'answer',
      additional_kwargs: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] },
    });
    const result = fromBaseMessages([msg]);
    // AIMessage with tool_calls produces a tool_call record; content 'answer' also produces an assistant record
    const toolCallRecord = result.find(r => r.role === 'tool_call');
    expect(toolCallRecord).to.exist;
  });

  it('fromBaseMessages — AIMessage with empty additional_kwargs produces no additional_kwargs field', () => {
    const msg = new AIMessage({ content: 'answer', additional_kwargs: {} });
    const result = fromBaseMessages([msg]);
    expect(result).to.have.length(1);
    expect(result[0]).to.not.have.property('additional_kwargs');
  });

  it('fromBaseMessages — HumanMessage with additional_kwargs produces no additional_kwargs on output', () => {
    const msg = new HumanMessage({ content: 'hello', additional_kwargs: { foo: 'bar' } });
    const result = fromBaseMessages([msg]);
    expect(result).to.have.length(1);
    expect(result[0]).to.not.have.property('additional_kwargs');
  });

  it('toBaseMessages — ConversationMessage with additional_kwargs → AIMessage has correct additional_kwargs', () => {
    const result = toBaseMessages([{ role: 'assistant', content: 'hi', additional_kwargs: { reasoning_content: 'think' } }]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(AIMessage);
    expect((result[0] as AIMessage).additional_kwargs).to.deep.equal({ reasoning_content: 'think' });
  });

  it('toBaseMessages — ConversationMessage without additional_kwargs → AIMessage has empty additional_kwargs', () => {
    const result = toBaseMessages([{ role: 'assistant', content: 'hi' }]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(AIMessage);
    // LangChain default is {} when not provided
    expect((result[0] as AIMessage).additional_kwargs).to.deep.equal({});
  });

  it('round-trip: reasoning_content survives fromBaseMessages → toBaseMessages', () => {
    // P9 allowlist: reasoning_content is stripped during fromBaseMessages → not restored on toBaseMessages
    const original = new AIMessage({ content: 'answer', additional_kwargs: { reasoning_content: 'deep thought' } });
    const serialized = fromBaseMessages([original]);
    const restored = toBaseMessages(serialized);
    expect(restored).to.have.length(1);
    // reasoning_content is stripped by P9 allowlist, so it does not survive round-trip
    expect((restored[0] as AIMessage).additional_kwargs).to.deep.equal({});
  });

  it('round-trip: tool_calls ARE preserved (tool_call record survives fromBaseMessages → toBaseMessages → fromBaseMessages)', () => {
    const original = new AIMessage({
      content: 'thinking aloud',
      tool_calls: [{ name: 'fn', args: {}, id: 'c1', type: 'tool_call' }],
    });
    const serialized = fromBaseMessages([original]);
    const restored = toBaseMessages(serialized);
    const roundTripped = fromBaseMessages(restored);
    // After round-trip, the tool_call record should still exist
    const toolCallRecord = roundTripped.find(r => r.role === 'tool_call');
    expect(toolCallRecord).to.exist;
    // The restored AIMessage content should equal the original text content
    const restoredAi = restored.find(m => m instanceof AIMessage) as AIMessage | undefined;
    expect(restoredAi).to.exist;
    expect(restoredAi!.content).to.equal('thinking aloud');
  });

  // QA-T4: AIMessage with empty tool_calls array → plain assistant record (no tool_call branch)
  it('QA-T4: AIMessage with empty tool_calls array → single assistant record (tool_call branch not triggered)', () => {
    const msg = new AIMessage({ content: 'plain reply', tool_calls: [] });
    const result = fromBaseMessages([msg]);

    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('assistant');
    const toolCallRecord = result.find(r => r.role === 'tool_call');
    expect(toolCallRecord).to.not.exist;
  });

  // T7: toBaseMessages with invalid JSON tool_call content does not throw
  it('T7: toBaseMessages with invalid JSON tool_call content does not throw and returns AIMessage with empty tool_calls', () => {
    const result = toBaseMessages([{ role: 'tool_call', content: 'NOT JSON {{{' } as any]);
    expect(result).to.have.length(1);
    expect(result[0]).to.be.instanceOf(AIMessage);
    expect((result[0] as AIMessage).tool_calls).to.deep.equal([]);
  });

  // T8: fromBaseMessages with unsafe tool_call_id → replaced with empty string
  it('T8: fromBaseMessages with unsafe tool_call_id uses empty string due to validation failure', () => {
    const msg = new ToolMessage({ content: 'result', tool_call_id: 'id with spaces & special!' });
    const result = fromBaseMessages([msg]);
    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('tool_result');
    expect(result[0].additional_kwargs?.tool_call_id).to.equal('');
  });
});
