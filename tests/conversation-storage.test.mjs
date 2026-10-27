import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_STORAGE_KEY,
  MAX_STORED_TURNS,
  clearStoredConversation,
  latestTurnId,
  loadConversation,
  saveConversation,
} from '../src/conversation-storage.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    get size() { return data.size; },
  };
}

test('loadConversation: vazio, ausente, inválido ou corrompido vira lista vazia', () => {
  assert.deepEqual(loadConversation(fakeStorage()), []);
  assert.deepEqual(loadConversation(fakeStorage({ [CONVERSATION_STORAGE_KEY]: '{' })), []);
  assert.deepEqual(loadConversation(fakeStorage({ [CONVERSATION_STORAGE_KEY]: '{"role":"user"}' })), []);
  assert.deepEqual(loadConversation(null), []);
});

test('loadConversation: normaliza o turno e descarta mensagem vazia', () => {
  const turns = loadConversation(fakeStorage({
    [CONVERSATION_STORAGE_KEY]: JSON.stringify([
      { id: '7', role: 'assistant', content: '  oi  ', mode: 'voice' },
      { id: 8, role: 'user', content: '   ', mode: 'text' },
      { id: 9, role: 'outro', content: 'texto', mode: 'outro' },
      null,
    ]),
  }));
  assert.deepEqual(turns, [
    { id: 7, role: 'assistant', content: 'oi', mode: 'voice' },
    { id: 9, role: 'user', content: 'texto', mode: 'text' },
  ]);
});

test('saveConversation: mantém só as últimas 100 mensagens', () => {
  const storage = fakeStorage();
  const turns = Array.from({ length: MAX_STORED_TURNS + 5 }, (_, index) => ({
    id: index + 1, role: 'user', content: `m${index + 1}`, mode: 'text',
  }));
  const safe = saveConversation(turns, storage);
  assert.equal(safe.length, MAX_STORED_TURNS);
  assert.equal(safe[0].content, 'm6');
  assert.equal(loadConversation(storage).at(-1).content, `m${MAX_STORED_TURNS + 5}`);
});

test('clearStoredConversation remove a chave; latestTurnId parte do maior id salvo', () => {
  const storage = fakeStorage();
  saveConversation([{ id: 3, role: 'user', content: 'a' }, { id: 11, role: 'assistant', content: 'b' }], storage);
  assert.equal(latestTurnId(loadConversation(storage)), 11);
  clearStoredConversation(storage);
  assert.deepEqual(loadConversation(storage), []);
});

test('storage que lança não derruba o chat', () => {
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(loadConversation(broken), []);
  assert.deepEqual(saveConversation([{ id: 1, role: 'user', content: 'oi' }], broken), [
    { id: 1, role: 'user', content: 'oi', mode: 'text' },
  ]);
  assert.doesNotThrow(() => clearStoredConversation(broken));
});
