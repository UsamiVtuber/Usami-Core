import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory-store.js';
import {
  buildFallbackSummary,
  buildTranscript,
  listPendingDays,
  summarizePendingDays,
} from '../src/memory-summaries.js';
import { buildPersona } from '../src/persona.js';
import { summarizeDay } from '../src/llm-router.js';

function scratchStore() {
  const dir = mkdtempSync(join(tmpdir(), 'usami-summaries-'));
  const store = createMemoryStore({ dataDir: dir });
  store.load();
  return store;
}

function seed(store, day, messages) {
  const current = store.getAll();
  store.save({
    ...current,
    dailyHistory: {
      ...current.dailyHistory,
      [day]: messages.map((message, index) => ({
        role: message.role,
        content: message.content,
        timestamp: `${day}T12:0${index}:00.000Z`,
      })),
    },
  });
}

test('listPendingDays ignora hoje, dias vazios e dias já resumidos', () => {
  const memory = {
    dailyHistory: {
      '2026-10-23': [{ role: 'user', content: 'oi' }],
      '2026-10-24': [{ role: 'user', content: 'tudo bem?' }],
      '2026-10-25': [],
      '2026-10-26': [{ role: 'user', content: 'bom dia' }],
    },
    summaries: [{ date: '2026-10-24', summary: 'já resumido' }],
  };
  assert.deepEqual(listPendingDays(memory, { today: '2026-10-27' }), ['2026-10-23', '2026-10-26']);
  assert.deepEqual(listPendingDays(memory, { today: '2026-10-27', limit: 1 }), ['2026-10-23']);
});

test('buildFallbackSummary usa só as falas do usuário e trunca o excesso', () => {
  const long = 'a'.repeat(120);
  const summary = buildFallbackSummary([
    { role: 'user', content: '  gosto de café   gelado ' },
    { role: 'assistant', content: 'que bom!' },
    { role: 'user', content: long },
  ]);
  assert.match(summary, /^Conversamos sobre: gosto de café gelado; a+…\.$/);
  assert.equal(summary.includes('que bom!'), false);
  assert.equal(buildFallbackSummary([{ role: 'assistant', content: 'oi' }]), '');
});

test('buildTranscript identifica os papéis e descarta conteúdo vazio', () => {
  const transcript = buildTranscript([
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: 'tudo bem?' },
  ]);
  assert.equal(transcript, 'Usuário: oi\nUsami: tudo bem?');
});

test('summarizePendingDays grava o fallback quando não há LLM', async () => {
  const store = scratchStore();
  seed(store, '2026-10-24', [
    { role: 'user', content: 'meu aniversário é em março' },
    { role: 'assistant', content: 'anotado!' },
  ]);
  seed(store, '2026-10-26', [{ role: 'user', content: 'hoje foi um dia difícil' }]);

  const results = await summarizePendingDays({ store, today: '2026-10-27' });

  assert.deepEqual(results, [
    { date: '2026-10-24', source: 'fallback' },
    { date: '2026-10-26', source: 'fallback' },
  ]);
  const summaries = store.getSummaries();
  assert.equal(summaries.length, 2);
  assert.match(summaries[0].summary, /aniversário é em março/);
  assert.match(summaries[1].summary, /dia difícil/);
});

test('summarizePendingDays prefere o texto do LLM e cai no fallback quando ele falha', async () => {
  const store = scratchStore();
  seed(store, '2026-10-24', [{ role: 'user', content: 'quero aprender violão' }]);
  seed(store, '2026-10-25', [{ role: 'user', content: 'meu gato chama Tofu' }]);

  const seen = [];
  const results = await summarizePendingDays({
    store,
    today: '2026-10-27',
    summarize: async ({ date, transcript }) => {
      seen.push({ date, transcript });
      if (date === '2026-10-25') throw new Error('provedor fora do ar');
      return '  O usuário quer aprender violão.  ';
    },
    logger: { warn: () => {} },
  });

  assert.deepEqual(results, [
    { date: '2026-10-24', source: 'llm' },
    { date: '2026-10-25', source: 'fallback' },
  ]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].date, '2026-10-24');
  assert.match(seen[0].transcript, /Usuário: quero aprender violão/);
  assert.deepEqual(store.getSummaries(), [
    { date: '2026-10-24', summary: 'O usuário quer aprender violão.' },
    { date: '2026-10-25', summary: 'Conversamos sobre: meu gato chama Tofu.' },
  ]);
});

test('summarizePendingDays não repete um dia em voo nem resume duas vezes', async () => {
  const store = scratchStore();
  seed(store, '2026-10-24', [{ role: 'user', content: 'conversa única' }]);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = summarizePendingDays({
    store,
    today: '2026-10-27',
    summarize: async () => {
      await gate;
      return 'resumo da primeira chamada';
    },
  });
  const second = await summarizePendingDays({
    store,
    today: '2026-10-27',
    summarize: async () => 'não deveria rodar',
  });
  release();
  const firstResults = await first;

  assert.deepEqual(second, []);
  assert.deepEqual(firstResults, [{ date: '2026-10-24', source: 'llm' }]);
  assert.equal(store.getSummaries().length, 1);
  assert.equal(store.getSummaries()[0].summary, 'resumo da primeira chamada');
});

test('exclusão durante o resumo não ressuscita o dia esquecido', async () => {
  const store = scratchStore();
  seed(store, '2026-10-24', [{ role: 'user', content: 'algo para esquecer' }]);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = summarizePendingDays({
    store,
    today: '2026-10-27',
    summarize: async () => {
      await gate;
      return 'resumo tardio';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.clearAllHistory();
  release();

  assert.deepEqual(await running, []);
  assert.deepEqual(store.getSummaries(), []);
});

test('buildPersona injeta os resumos dos dias anteriores', () => {
  const prompt = buildPersona({
    affinity: 10,
    summaries: [
      { date: '2026-10-24', summary: 'O usuário contou que tem um gato chamado Tofu.' },
      { date: '2026-10-26', summary: 'Conversa leve sobre música.' },
    ],
    date: '2026-10-27',
    timeOfDay: 'manhã',
  });
  assert.match(prompt, /=== DIAS ANTERIORES ===/);
  assert.match(prompt, /2026-10-24: O usuário contou que tem um gato chamado Tofu\./);
  assert.match(prompt, /2026-10-26: Conversa leve sobre música\./);
});

test('summarizeDay monta o pedido e devolve o texto do provedor', async () => {
  const previous = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'chave-de-teste';
  const calls = [];
  try {
    const text = await summarizeDay(
      { date: '2026-10-26', transcript: 'Usuário: oi\nUsami: oi!' },
      {
        client: {
          chatText: async (payload) => {
            calls.push(payload);
            return '  Resumo do dia.  ';
          },
        },
      },
    );
    assert.equal(text, 'Resumo do dia.');
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[0].content, /memória de longo prazo/);
    assert.match(calls[0].messages[1].content, /2026-10-26/);
    assert.match(calls[0].messages[1].content, /Usami: oi!/);
  } finally {
    if (previous === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previous;
  }
});
