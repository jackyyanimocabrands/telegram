import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { env } from '../../config/env.js';

interface ExaSearchResult {
  title?: string;
  url?: string;
  text?: string;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
}

export function createWebsearchTool(apiKey: string = env.EXA_API_KEY ?? '') {
  return tool(
    async (input) => {
      if (!apiKey) return 'Search is not configured. EXA_API_KEY is missing.';
      try {
        const response = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            query: input.query,
            numResults: input.numResults,
            type: 'auto',
            contents: { text: { maxCharacters: 2000 } },
          }),
        });

        if (!response.ok) {
          return `Search failed: ${response.statusText}`;
        }

        const data = (await response.json()) as ExaSearchResponse;
        const results = data.results ?? [];

        if (results.length === 0) {
          return 'No results found.';
        }

        return results
          .map(
            (r) =>
              `Title: ${r.title ?? 'N/A'}\nURL: ${r.url ?? 'N/A'}\nSnippet: ${r.text ?? 'N/A'}\n---`,
          )
          .join('\n');
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    {
      name: 'web_search',
      description: 'Search the web for current information using Exa.',
      schema: z.object({
        query: z.string(),
        numResults: z.number().int().min(1).max(10).default(5),
      }),
    },
  );
}
