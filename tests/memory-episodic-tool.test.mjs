import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySearchTool } from '../src/memory-search-tool.js';

function storeWithFacts(facts = []) {
  return {
    getSections: () => ({ preferences: facts }),
    getRecentFacts: () => [],
    getSummaries: () => [],
  };
}

test('memory.search: mistura fato lexical e episódio semântico', async () => {
  const tool = createMemorySearchTool({
    memoryStore: storeWithFacts(['gosta de café gelado']),
    episodicStore: {
      search: async () => [{
        text: 'Usuário: problema de concorrência no Rust\nUsami: era o Arc<Mutex>',
        isoDate: '2026-11-03T10:00:00.000Z',
        score: 0.81,
      }],
    },
  });

  const result = await tool.execute({ query: 'café' });
  assert.equal(result.count, 2);
  assert.equal(result.results[0].source, 'section');
  assert.equal(result.results[1].source, 'episode');
  assert.equal(result.results[1].date, '2026-11-03');
  assert.ok(tool.verify(result));
});

test('memory.search: respeita o limite global ao completar com episódios', async () => {
  let requested = null;
  const tool = createMemorySearchTool({
    memoryStore: storeWithFacts(['gosta de café gelado']),
    episodicStore: {
      search: async ({ limit }) => {
        requested = limit;
        return Array.from({ length: 10 }, (_, i) => ({ text: `episódio ${i}`, isoDate: '2026-11-03', score: 0.5 }));
      },
    },
  });

  const result = await tool.execute({ query: 'café', limit: 3 });
  assert.equal(requested, 2);
  assert.equal(result.count, 3);
});

test('memory.search: episódio indisponível não derruba a busca lexical', async () => {
  const tool = createMemorySearchTool({
    memoryStore: storeWithFacts(['gosta de café gelado']),
    episodicStore: { search: async () => { throw new Error('lancedb fora'); } },
  });

  const result = await tool.execute({ query: 'café' });
  assert.equal(result.count, 1);
  assert.equal(result.results[0].source, 'section');
});

test('memory.search: sem store episódico mantém o comportamento anterior', async () => {
  const tool = createMemorySearchTool({ memoryStore: storeWithFacts(['gosta de café gelado']) });
  const result = await tool.execute({ query: 'café' });
  assert.deepEqual(result.results, [{ source: 'section', section: 'preferences', text: 'gosta de café gelado' }]);
});
