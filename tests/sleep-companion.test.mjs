import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SLEEP_DURATION_MINUTES,
  DEFAULT_SLEEP_PLAYBACK_RATE,
  DEFAULT_SLEEP_VOLUME,
  DEFAULT_SLEEP_EMOTION,
  isSleepCompanionTrigger,
  isWakeUpTrigger,
  adaptProsodyForSleep,
  createSleepCompanionService,
} from '../src/sleep-companion.js';

test('sleep-companion: detecta frases de ativação do modo sono', () => {
  const triggers = [
    'vamos dormir, Usami',
    'vamos mimir',
    'Usami, ativa o modo sono',
    'ativa o modo de dormir',
    'hora de dormir',
    'hora de mimir',
    'me ajuda a dormir por favor',
    'modo sono',
    'modo dormir',
    'quero dormir agora',
    'vou dormir, fica aqui comigo',
    'iniciar companion de sono',
  ];

  for (const phrase of triggers) {
    assert.equal(isSleepCompanionTrigger(phrase), true, `Deveria reconhecer: "${phrase}"`);
  }

  assert.equal(isSleepCompanionTrigger('olá Usami, como vai?'), false);
  assert.equal(isSleepCompanionTrigger('o que tem na agenda?'), false);
  assert.equal(isSleepCompanionTrigger(null), false);
  assert.equal(isSleepCompanionTrigger(''), false);
});

test('sleep-companion: detecta frases de acordar e desativação', () => {
  const wakeTriggers = [
    'acorda Usami',
    'Usami acorda',
    'desativa o modo sono',
    'já acordei',
    'bom dia Usami',
    'cancelar modo sono',
    'sair do modo dormir',
  ];

  for (const phrase of wakeTriggers) {
    assert.equal(isWakeUpTrigger(phrase), true, `Deveria reconhecer saída: "${phrase}"`);
  }

  assert.equal(isWakeUpTrigger('boa tarde'), false);
  assert.equal(isWakeUpTrigger('vamos programar'), false);
});

test('sleep-companion: adaptProsodyForSleep transforma instrução para ritmo lento e voz aconchegante', () => {
  const baseInstruction = 'em português do Brasil, voz de personagem de anime, muito aguda e brilhante, timbre leve e expressivo, dicção rápida e nítida, saltitante, sorriso na voz';

  // Para whisper e estilos de sono
  const adaptedWhisper = adaptProsodyForSleep(baseInstruction, 'whisper');
  assert.ok(adaptedWhisper.includes('dicção lenta, calma, suave e pausada'));
  assert.ok(adaptedWhisper.includes('voz suave, aconchegante, baixa e aveludada'));
  assert.ok(adaptedWhisper.includes('timbre doce, íntimo e baixinho'));
  assert.ok(adaptedWhisper.includes('serena e tranquila'));
  assert.ok(adaptedWhisper.includes('tom sereno e acolhedor'));
  assert.ok(!adaptedWhisper.includes('dicção rápida e nítida'));
  assert.ok(!adaptedWhisper.includes('muito aguda e brilhante'));
  assert.ok(!adaptedWhisper.includes('saltitante'));

  // Para whisper_caring e whisper_sleepy
  const adaptedSleepy = adaptProsodyForSleep(baseInstruction, 'whisper_sleepy');
  assert.ok(adaptedSleepy.includes('dicção lenta, calma, suave e pausada'));

  // Para estilo neutro ou feliz, não altera marcadores base
  const normal = adaptProsodyForSleep(baseInstruction, 'casual_happy');
  assert.equal(normal, baseInstruction);
});

test('sleep-companion: ciclo de vida do serviço com contagem regressiva e expiração', () => {
  let currentTime = 1000000;
  const service = createSleepCompanionService({
    defaultDurationMinutes: 30,
    now: () => currentTime,
  });

  assert.equal(service.isActive(), false);
  let status = service.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.playbackRate, 1.0);
  assert.equal(status.volume, 1.0);

  // Inicia
  status = service.start({ minutes: 30 });
  assert.equal(status.active, true);
  assert.equal(status.minutesLeft, 30);
  assert.equal(status.playbackRate, DEFAULT_SLEEP_PLAYBACK_RATE);
  assert.equal(status.volume, DEFAULT_SLEEP_VOLUME);
  assert.equal(status.defaultEmotion, DEFAULT_SLEEP_EMOTION);
  assert.equal(service.isActive(), true);

  // Passam 10 minutos (600.000 ms)
  currentTime += 10 * 60 * 1000;
  status = service.getStatus();
  assert.equal(status.active, true);
  assert.equal(status.minutesLeft, 20);

  // Passam mais 20 minutos (total 30 minutos - expira)
  currentTime += 20 * 60 * 1000;
  assert.equal(service.isActive(), false);
  status = service.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.minutesLeft, 0);
  assert.equal(status.playbackRate, 1.0);
  assert.equal(status.volume, 1.0);

  // Reinicia e para manualmente
  service.start();
  assert.equal(service.isActive(), true);
  service.stop();
  assert.equal(service.isActive(), false);
});
