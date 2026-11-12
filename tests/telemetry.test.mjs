import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLangfuseClient,
  startChatTrace,
  recordLlmGeneration,
  recordRetrievalSpan,
  recordToolSpan,
  flushTelemetry,
} from '../src/telemetry.js';

test('telemetry: client opera em no-op gracioso sem variáveis de ambiente', async () => {
  // Garantir que ambiente de teste não quebre sem credenciais
  const client = getLangfuseClient();
  assert.equal(client, null);

  const trace = startChatTrace({
    input: 'Olá Usami',
    metadata: { test: true },
  });

  assert.ok(trace);
  assert.equal(trace.trace, null);

  // Não deve lançar erro
  const span = trace.span({ name: 'test_span' });
  span.update({ output: 'ok' });
  span.end();

  recordLlmGeneration(trace, {
    model: 'nemotron-70b',
    prompt: 'oi',
    output: 'olá!',
    latencyMs: 120,
  });

  recordRetrievalSpan(trace, {
    query: 'músicas',
    results: [{ file: 'test.md', score: 0.9 }],
    latencyMs: 15,
  });

  recordToolSpan(trace, {
    toolName: 'read_memory',
    parameters: {},
    result: { status: 'ok' },
    latencyMs: 5,
  });

  trace.update({ output: 'resposta' });
  trace.end();

  await flushTelemetry();
});

