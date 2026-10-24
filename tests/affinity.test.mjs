import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGain, applyGain, getStage, canGainMore, DAILY_CAP, STAGE_LABELS } from '../src/affinity.js';

const NEUTRAL = { userMessage: 'oi', assistantReply: 'oi', currentScore: 0, stage: 'curiosidade_distante', alreadyGainedToday: 0 };

test('calculateGain pontua cada heurística', () => {
  // fato lembrado (core ou recente): +2
  assert.equal(calculateGain({ ...NEUTRAL, rememberFact: 'gosta de café gelado' }).delta, 2);
  // pergunta sobre a Usami: +1
  assert.equal(calculateGain({ ...NEUTRAL, userMessage: 'você gosta de coelhos?' }).delta, 1);
  // elogio: +1
  assert.equal(calculateGain({ ...NEUTRAL, userMessage: 'a Usami é tão fofa' }).delta, 1);
  // compartilha algo pessoal: +1
  assert.equal(calculateGain({ ...NEUTRAL, userMessage: 'hoje eu comecei a jogar Elden Ring' }).delta, 1);
  // rude/grosseiro: -2 (suprime os positivos da mensagem)
  assert.equal(calculateGain({ ...NEUTRAL, userMessage: 'você é uma chata' }).delta, -2);
  // Usami expressa emoção forte no reply: +1
  assert.equal(calculateGain({ ...NEUTRAL, assistantReply: 'Hmph! N-não é que eu me importe!' }).delta, 1);
  // resposta curta que só reconhece o turno: 0
  const short = calculateGain({ ...NEUTRAL, userMessage: 'ok' });
  assert.equal(short.delta, 0);
  assert.equal(short.reason, 'resposta_curta');
  // cap diário: 0 mesmo com fato novo
  const capped = calculateGain({ ...NEUTRAL, rememberFact: 'algo novo', alreadyGainedToday: DAILY_CAP });
  assert.equal(capped.delta, 0);
  assert.equal(capped.reason, 'cap_diario');
});

test('delta por turno é limitado a -3..+3', () => {
  const loaded = {
    userMessage: 'você gosta de coelhos? obrigado por me ouvir, hoje eu adotei um coelho',
    assistantReply: 'Hmph! Q-que fofo!',
    rememberFact: 'adotou um coelho',
    alreadyGainedToday: 0,
  };
  // 2 (fato) + 1 (pergunta) + 1 (elogio) + 1 (pessoal) + 1 (emoção) = 6 → clamp 3
  assert.equal(calculateGain(loaded).delta, 3);
  // nunca abaixo de -3
  assert.ok(calculateGain({ ...NEUTRAL, userMessage: 'você é uma chata, sua idiota' }).delta >= -3);
});

test('applyGain aplica clamp 0–100 e reseta o contador na virada de dia', () => {
  assert.deepEqual(
    applyGain(99, 5, '2026-10-24', '2026-10-24', 0),
    { score: 100, lastDailyGainDate: '2026-10-24', totalDailyGainToday: 5 },
  );
  assert.deepEqual(
    applyGain(1, -5, '2026-10-24', '2026-10-24', 0),
    { score: 0, lastDailyGainDate: '2026-10-24', totalDailyGainToday: 0 },
  );
  // mesmo dia soma no contador
  assert.equal(applyGain(10, 2, '2026-10-24', '2026-10-24', 4).totalDailyGainToday, 6);
  // virada de dia zera antes de somar
  assert.deepEqual(
    applyGain(10, 2, '2026-10-25', '2026-10-24', 4),
    { score: 12, lastDailyGainDate: '2026-10-25', totalDailyGainToday: 2 },
  );
  // delta negativo não consome o cap diário
  assert.equal(applyGain(10, -2, '2026-10-24', '2026-10-24', 4).totalDailyGainToday, 4);
});

test('getStage retorna o rótulo correto nos limites', () => {
  const expected = {
    19: STAGE_LABELS[0],
    20: STAGE_LABELS[1],
    39: STAGE_LABELS[1],
    40: STAGE_LABELS[2],
    59: STAGE_LABELS[2],
    60: STAGE_LABELS[3],
    79: STAGE_LABELS[3],
    80: STAGE_LABELS[4],
    100: STAGE_LABELS[4],
  };
  for (const [score, label] of Object.entries(expected)) {
    assert.equal(getStage(Number(score)), label, 'score ' + score);
  }
  // fora do intervalo cai nos extremos
  assert.equal(getStage(0), STAGE_LABELS[0]);
  assert.equal(getStage(-10), STAGE_LABELS[0]);
  assert.equal(getStage(150), STAGE_LABELS[4]);
  assert.equal(DAILY_CAP, 6);
});

test('canGainMore respeita o DAILY_CAP', () => {
  assert.equal(canGainMore(0), true);
  assert.equal(canGainMore(DAILY_CAP - 1), true);
  assert.equal(canGainMore(DAILY_CAP), false);
  assert.equal(canGainMore(DAILY_CAP + 3), false);
});
