import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createWebsearchTool } from '../../../src/services/tools/websearch.js';

describe('createWebsearchTool', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns formatted string with results on success', async () => {
    const mockResponse = {
      ok: true,
      json: sinon.stub().resolves({
        results: [
          { title: 'Result 1', url: 'https://example.com/1', text: 'Snippet one.' },
          { title: 'Result 2', url: 'https://example.com/2', text: 'Snippet two.' },
        ],
      }),
    };
    fetchStub.resolves(mockResponse);

    const tool = createWebsearchTool('test-exa-key');
    const result = await tool.invoke({ query: 'test query', numResults: 2 });

    expect(result).to.include('Title: Result 1');
    expect(result).to.include('URL: https://example.com/1');
    expect(result).to.include('Snippet: Snippet one.');
    expect(result).to.include('Title: Result 2');
    expect(result).to.include('---');

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.equal('https://api.exa.ai/search');
    expect(options.headers['x-api-key']).to.equal('test-exa-key');
    const body = JSON.parse(options.body);
    expect(body.query).to.equal('test query');
    expect(body.numResults).to.equal(2);
  });

  it('returns error message string on fetch error, does not throw', async () => {
    fetchStub.rejects(new Error('Network failure'));
    const tool = createWebsearchTool('test-exa-key');
    const result = await tool.invoke({ query: 'test query', numResults: 5 });
    expect(result).to.equal('Network failure');
  });

  it('returns Search failed message on non-ok response', async () => {
    fetchStub.resolves({ ok: false, statusText: '429 Too Many Requests', json: async () => ({}) });
    const tool = createWebsearchTool('test-exa-key');
    const result = await tool.invoke({ query: 'test query', numResults: 5 });
    expect(result).to.equal('Search failed: 429 Too Many Requests');
  });

  it('returns No results found when results array is empty', async () => {
    fetchStub.resolves({ ok: true, json: async () => ({ results: [] }) });
    const tool = createWebsearchTool('test-exa-key');
    const result = await tool.invoke({ query: 'empty query', numResults: 5 });
    expect(result).to.equal('No results found.');
  });
});
