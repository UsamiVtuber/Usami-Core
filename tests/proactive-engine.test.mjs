import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuietHours,
  shouldTriggerProactive,
  parseOpenAmikaTag,
  buildProactivePrompt,
  generateProactiveSpeech,
  createProactiveEngine,
} from '../src/proactive-engine.js';
import { queueAvatarCommand } from '../server.mjs';

test('isQuietHours identifica corretamente a janela Não Perturbe (23:30 - 08:30)', () => {
  const atMidnight = new Date('2026-11-06T00:30:00');
  const at3am = new Date('2026-11-06T03:00:00');
  const at8am = new Date('2026-11-06T08:00:00');
  const at845am = new Date('2026-11-06T08:45:00');
  const at2pm = new Date('2026-11-06T14:00:00');
  const at2345 = new Date('2026-11-06T23:45:00');

  assert.equal(isQuietHours(atMidnight), true);
  assert.equal(isQuietHours(at3am), true);
  assert.equal(isQuietHours(at8am), true);
  assert.equal(isQuietHours(at845am), false);
  assert.equal(isQuietHours(at2pm), false);
  assert.equal(isQuietHours(at2345), true);
});

test('shouldTriggerProactive valida todas as condições de guarda', () => {
  const now = new Date('2026-11-06T15:00:00').getTime(); // 15:00 (fora de DND)

  // 1. Bloqueia se ocupado
  const r1 = shouldTriggerProactive({
    lastUserActivityMs: now - 300000,
    now,
    isBusy: true,
    affinity: 30,
  });
  assert.equal(r1.allowed, false);
  assert.equal(r1.reason, 'busy');

  // 2. Bloqueia se afinidade < 20
  const r2 = shouldTriggerProactive({
    lastUserActivityMs: now - 300000,
    now,
    affinity: 15,
  });
  assert.equal(r2.allowed, false);
  assert.equal(r2.reason, 'low_affinity');

  // 3. Bloqueia se já tem 1 tentativa não respondida
  const r3 = shouldTriggerProactive({
    lastUserActivityMs: now - 300000,
    now,
    affinity: 50,
    unansweredCount: 1,
  });
  assert.equal(r3.allowed, false);
  assert.equal(r3.reason, 'max_unanswered');

  // 4. Bloqueia se ainda não atingiu o limiar de ócio
  const r4 = shouldTriggerProactive({
    lastUserActivityMs: now - 60000, // 1 min atrás (padrão é 3 min)
    now,
    affinity: 50,
    idleThresholdMs: 180000,
  });
  assert.equal(r4.allowed, false);
  assert.equal(r4.reason, 'not_idle');

  // 5. Sucesso quando todas as condições são satisfeitas
  const r5 = shouldTriggerProactive({
    lastUserActivityMs: now - 200000, // > 3 min
    now,
    affinity: 35,
    unansweredCount: 0,
    isBusy: false,
    idleThresholdMs: 180000,
  });
  assert.equal(r5.allowed, true);
});

test('parseOpenAmikaTag extrai o texto interno de <开口> ou devolve o texto limpo', () => {
  const t1 = '<开口>[casual_playful] Ei, você tá muito quieto aí!</开口>';
  assert.equal(parseOpenAmikaTag(t1), '[casual_playful] Ei, você tá muito quieto aí!');

  const t2 = 'Alguma coisa antes [开口]Pausa pro café?[/开口] depois';
  assert.equal(parseOpenAmikaTag(t2), 'Pausa pro café?');

  const t3 = '[polite_smile] Olá, tudo bem?';
  assert.equal(parseOpenAmikaTag(t3), '[polite_smile] Olá, tudo bem?');
});

test('generateProactiveSpeech usa o router ou cai no fallback determinístico da cena', async () => {
  const date = new Date('2026-11-06T15:00:00');

  // Com router nulo: retorna fallback determinístico
  const resFallback = await generateProactiveSpeech({
    affinity: 40,
    username: 'Amari',
    date,
    router: null,
  });
  assert.equal(resFallback.source, 'fallback');
  assert.ok(resFallback.message.length > 5);

  // Com mock router: processa e extrai <开口>
  const mockRouter = {
    generateReplyWithActions: async () => ({
      reply: 'Pensamento aqui... <开口>[casual_happy] Ei Amari, já tomou água hoje?</开口>',
    }),
  };
  const resRouter = await generateProactiveSpeech({
    affinity: 40,
    username: 'Amari',
    date,
    router: mockRouter,
  });
  assert.equal(resRouter.source, 'router');
  assert.equal(resRouter.message, '[casual_happy] Ei Amari, já tomou água hoje?');
});

test('createProactiveEngine gerencia ciclo de atividade e disparo', async () => {
  const events = [];
  const engine = createProactiveEngine({
    affinityProvider: () => 40,
    usernameProvider: () => 'Amari',
    idleThresholdMs: 50, // 50ms para teste
    enforceQuietHours: false,
    onProactiveSay: (cmd) => events.push(cmd),
  });

  // Imediato: não deve disparar (idle < 50ms)
  const c1 = await engine.checkAndTrigger();
  assert.equal(c1.triggered, false);
  assert.equal(c1.reason, 'not_idle');

  // Espera passar o threshold
  await new Promise(r => setTimeout(r, 60));

  // Disparo 1: deve funcionar e incrementar unansweredCount
  const c2 = await engine.checkAndTrigger();
  assert.equal(c2.triggered, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'proactive_say');
  assert.equal(engine.getState().unansweredCount, 1);

  // Disparo 2 imediato: deve ser bloqueado por max_unanswered
  const c3 = await engine.checkAndTrigger();
  assert.equal(c3.triggered, false);
  assert.equal(c3.reason, 'max_unanswered');

  // Usuário interage: reseta contadores
  engine.markUserActivity();
  assert.equal(engine.getState().unansweredCount, 0);

  // Novamente após idle: pode disparar de novo
  await new Promise(r => setTimeout(r, 60));
  const c4 = await engine.checkAndTrigger();
  assert.equal(c4.triggered, true);
  assert.equal(events.length, 2);
});

test('queueAvatarCommand aceita comando proactive_say no server', () => {
  const entry = queueAvatarCommand({
    type: 'proactive_say',
    message: '[casual_playful] Ei, tá por aí?',
  });
  assert.ok(entry);
  assert.equal(entry.type, 'proactive_say');
  assert.equal(entry.message, '[casual_playful] Ei, tá por aí?');
});
