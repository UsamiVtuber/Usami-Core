import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatActivityRegistry } from '../src/chat-activity.js';

test('chat-activity: registra fase e ferramenta por cliente', () => {
  const registry = createChatActivityRegistry();
  registry.set('abc', { phase: 'tool', tool: 'git.log', tools: ['git.log'] });
  const current = registry.get('abc');
  assert.equal(current.phase, 'tool');
  assert.equal(current.tool, 'git.log');
  assert.deepEqual(current.tools, ['git.log']);
  assert.equal(current.active ?? true, true);
});

test('chat-activity: cliente sem atividade devolve null e latest pega o mais recente', () => {
  const registry = createChatActivityRegistry();
  assert.equal(registry.get('abc'), null);
  registry.set('abc', { phase: 'thinking' });
  const latest = registry.latest();
  assert.equal(latest.clientId, 'abc');
  assert.equal(latest.phase, 'thinking');
});

test('chat-activity: clear remove a atividade do cliente', () => {
  const registry = createChatActivityRegistry();
  registry.set('abc', { phase: 'thinking' });
  registry.clear('abc');
  assert.equal(registry.get('abc'), null);
  assert.equal(registry.latest(), null);
});

test('chat-activity: fase desconhecida cai em thinking', () => {
  const registry = createChatActivityRegistry();
  registry.set('abc', { phase: 'lixo' });
  assert.equal(registry.get('abc').phase, 'thinking');
});

test('chat-activity: entrada expira depois do TTL', () => {
  let now = 1000;
  const registry = createChatActivityRegistry({ now: () => now, ttlMs: 500 });
  registry.set('abc', { phase: 'thinking' });
  now = 1600;
  assert.equal(registry.get('abc'), null);
});

test('chat-activity: startedAt é preservado entre atualizações da mesma fase', () => {
  let now = 1000;
  const registry = createChatActivityRegistry({ now: () => now });
  registry.set('abc', { phase: 'tool', tool: 'git.log' });
  now = 1500;
  registry.set('abc', { phase: 'thinking' });
  const current = registry.get('abc');
  assert.equal(current.startedAt, 1000);
  assert.equal(current.updatedAt, 1500);
});
