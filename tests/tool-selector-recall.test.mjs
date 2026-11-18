import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTopKTools } from '../src/tool-selector.js';
import { createMemorySearchTool } from '../src/memory-search-tool.js';
import { createTimerTools } from '../src/timer-tools.js';

// Registry devolve descritores (sem execute); reproduzimos esse formato.
const memorySearch = createMemorySearchTool({
  memoryStore: { getSections: () => ({}), getRecentFacts: () => [], getSummaries: () => [] },
});
const timerTools = createTimerTools({
  timerService: { startPomodoro: () => ({}), createReminder: () => ({}), getStatus: () => ({}), cancel: () => ({}) },
});

const tools = [
  { name: memorySearch.name, description: memorySearch.description, parameters: memorySearch.parameters },
  ...timerTools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  { name: 'calendar.list', description: 'Lista eventos do Google Calendar em uma janela de datas.', parameters: [] },
  { name: 'calendar.create', description: 'Cria um evento no Google Calendar.', parameters: [] },
  { name: 'research.search', description: 'Pesquisa na web via TinyFish e/ou Firecrawl (com fusão e deduplicação) e opcionalmente no vault local.', parameters: [] },
  { name: 'research.fetch', description: 'Extrai o conteúdo em Markdown de URLs públicas via TinyFish Fetch ou Firecrawl Scrape.', parameters: [] },
  { name: 'spotify.control', description: 'Controla a reprodução no Spotify: play, pause, next, previous, volume ou shuffle.', parameters: [] },
  { name: 'spotify.stats', description: 'Estatísticas de audição do Spotify por período.', parameters: [] },
  { name: 'github.pr', description: 'Abre um pull request no GitHub.', parameters: [] },
  { name: 'briefing.build', description: 'Monta o briefing diário com compromissos, tarefas e execuções.', parameters: [] },
];

const pick = query => selectTopKTools(query, tools, { k: 6, minScore: 0.08 }).map(item => item.name);

test('tool-selector: frase de recall traz memory.search para o Top-K', () => {
  const names = pick('lembra daquele problema de concorrência no Rust que comentei semana passada?');
  assert.ok(names.includes('memory.search'), `memory.search ausente em: ${names.join(', ')}`);
});

test('tool-selector: frase de recall com "lembra" sem verbo de comentário também seleciona', () => {
  const names = pick('lembra daquele restaurante que a gente foi?');
  assert.ok(names.includes('memory.search'), `memory.search ausente em: ${names.join(', ')}`);
});

test('tool-selector: memória não é injetada em turno irrelevante', () => {
  const names = pick('coloca uma playlist lo-fi que eu tô estressado');
  assert.ok(!names.includes('memory.search'), `memory.search apareceu em: ${names.join(', ')}`);
  assert.ok(names.includes('spotify.control'));
});

test('tool-selector: pedido composto mantém agenda e pesquisa juntos', () => {
  const names = pick('Dá uma olhada na minha agenda de amanhã, vê se tenho horário livre à tarde e já pesquisa sobre o restaurante X');
  assert.ok(names.includes('calendar.list'), `sem calendar.list em: ${names.join(', ')}`);
  assert.ok(names.includes('research.search'), `sem research.search em: ${names.join(', ')}`);
});
