import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderRaw, parseXmlToolCalls, stripXmlToolCalls } from '../src/provider-parse.js';
import { generateReplyWithTools, textToolCallsToOpenAi } from '../src/llm-router.js';
import { selectTopKTools } from '../src/tool-selector.js';
import { createSpotifyTools } from '../src/spotify-skill.js';
import { toolToOpenAi } from '../src/tool-registry.js';

const XML = '<tool_call>\n<function=spotify.search>\n<parameter=query>\nCartoon Jéja dubstep future bass\n</parameter>\n<parameter=type>\ntrack\n</parameter>\n<parameter=limit>\n5\n</parameter>\n</function>\n</tool_call>';

test('xml tool call: remove o bloco inteiro, inclusive </tool_call> e no meio do texto', () => {
  assert.equal(stripXmlToolCalls(XML), '');
  assert.equal(stripXmlToolCalls(`Vou buscar! ${XML}`), 'Vou buscar!');
});

test('xml tool call: não vaza dentro do campo reply do JSON', () => {
  const parsed = parseProviderRaw(JSON.stringify({ reply: `Vou buscar! ${XML}`, gesture: 'nod' }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reply, 'Vou buscar!');
});

test('xml tool call: resposta que é só a chamada não vira fala', () => {
  assert.equal(parseProviderRaw(XML).ok, false);
});

test('xml tool call: extrai nome e argumentos (XML e JSON Hermes)', () => {
  assert.deepEqual(parseXmlToolCalls(XML), [{ name: 'spotify.search', args: { query: 'Cartoon Jéja dubstep future bass', type: 'track', limit: 5 } }]);
  assert.deepEqual(
    parseXmlToolCalls('<tool_call>{"name":"spotify_control","arguments":{"action":"play"}}</tool_call>'),
    [{ name: 'spotify_control', args: { action: 'play' } }],
  );
});

test('xml tool call: só converte ferramentas oferecidas no turno', () => {
  const tools = createSpotifyTools({ spotifyAuth: {} }).map(toolToOpenAi);
  const calls = textToolCallsToOpenAi(`${XML}<tool_call><function=shell.exec></function></tool_call>`, tools, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'spotify_search');
});

test('generateReplyWithTools: executa a chamada escrita em texto e devolve a fala final', async () => {
  const prev = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'test';
  try {
    const tools = createSpotifyTools({ spotifyAuth: {} }).map(toolToOpenAi);
    const replies = [
      { choices: [{ message: { content: XML } }] },
      { choices: [{ message: { content: '{"reply":"Achei umas faixas!","gesture":"nod","actions":[]}' } }] },
    ];
    const executed = [];
    const res = await generateReplyWithTools('sys', 'coloca algo parecido', {
      tools,
      client: { chatCompletions: async () => replies.shift() },
      executeTool: async (name, args) => { executed.push({ name, args }); return { ok: true, items: [] }; },
    });
    assert.equal(res.ok, true);
    assert.equal(res.reply, 'Achei umas faixas!');
    assert.deepEqual(executed, [{ name: 'spotify_search', args: { query: 'Cartoon Jéja dubstep future bass', type: 'track', limit: 5 } }]);
  } finally {
    if (prev === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = prev;
  }
});

const catalog = [
  ...createSpotifyTools({ spotifyAuth: {} }),
  { name: 'code.inspect', description: 'Lê trecho e símbolos exportados de arquivo na allowlist.' },
  { name: 'code.search', description: 'Busca texto ou símbolo nos arquivos permitidos.' },
  { name: 'research.search', description: 'Pesquisa na web.' },
];
const pick = q => selectTopKTools(q, catalog, { k: 6, minScore: 0.08 }).map(t => t.name);

test('tool-selector: pedido de playlist traz busca e controle do Spotify', () => {
  const names = pick('[Discord | Ruka]: sim coloca uma playlist com músicas semelhantes a dele');
  assert.ok(names.includes('spotify.search'), names.join(', '));
  assert.ok(names.includes('spotify.control'), names.join(', '));
});

test('tool-selector: revisar função traz as ferramentas de código', () => {
  const names = pick('[Discord | Ruka]: Pode dar uma olhada pra mim nessa função do Spotify?');
  assert.ok(names.includes('code.search'), names.join(', '));
  assert.ok(names.includes('code.inspect'), names.join(', '));
});
