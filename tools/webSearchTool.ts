/**
 * Real web search tool via Serper API.
 */
import type { AgentTool } from '../core/toolRegistryV2.js';

export const webSearchTool: AgentTool = {
  name: 'web_search',
  description:
    'Use to perform live web queries for online information or general web answers. DO NOT use for opening local applications, launching desktop apps, reading local files, or executing system commands. Required parameter: query (string search query). Returns text summary of web search results.',
  riskLevel: 'low',
  inputSchema: {
    query: { type: 'string', description: 'Search query', required: true }
  },
  fallbacks: [],
  async execute(args, signal) {
    const query = String(args['query'] ?? '');
    if (!query.trim()) {
      return 'Error: web_search requires a query argument.';
    }

    if (signal?.aborted) throw new Error('ABORTED');

    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      return 'Error: SERPER_API_KEY is not set in the environment.';
    }

    try {
      // Chain the external abort signal with an 8s internal timeout.
      // Serper cold-start can be slow; we fail fast rather than blocking the orchestrator.
      const internalAc = new AbortController();
      const timeoutId = setTimeout(() => internalAc.abort(), 8000);
      if (signal) {
        if (signal.aborted) {
          internalAc.abort();
        } else {
          signal.addEventListener('abort', () => internalAc.abort(), { once: true });
        }
      }

      let response: Response;
      try {
        response = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: query, num: 5 }),
          signal: internalAc.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`Serper API error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      let resultsText = '';
      if (data.answerBox) {
        resultsText += `Answer: ${data.answerBox.snippet || data.answerBox.answer}\n\n`;
      }
      
      if (data.knowledgeGraph) {
        resultsText += `Knowledge: ${data.knowledgeGraph.title} - ${data.knowledgeGraph.description}\n\n`;
      }

      if (data.organic && data.organic.length > 0) {
        resultsText += 'Web Results:\n' + data.organic.map((r: any, i: number) => 
          `${i + 1}. ${r.title}\n${r.link}\n${r.snippet}`
        ).join('\n\n');
      }

      if (!resultsText.trim()) {
        return 'No results found for query.';
      }

      return resultsText;
    } catch (err) {
      throw new Error(`web_search failed: ${String(err)}`);
    }
  }
};
