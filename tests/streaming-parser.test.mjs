import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UsamiStreamingParser,
  parseReplyBalloons,
} from '../src/streaming-parser.js';

test('streaming-parser: parseReplyBalloons fatiamento básico com emoção inline', () => {
  const reply = '[casual_happy] Olá! Que bom te ver por aqui. [intimate_shy] Estava com saudades.';
  const balloons = parseReplyBalloons(reply);

  assert.ok(balloons.length >= 2);
  assert.equal(balloons[0].emotionKey, 'casual_happy');
  assert.match(balloons[0].display, /Olá! Que bom te ver por aqui\./);

  const lastBalloon = balloons[balloons.length - 1];
  assert.equal(lastBalloon.emotionKey, 'intimate_shy');
  assert.match(lastBalloon.display, /Estava com saudades\./);
  assert.equal(lastBalloon.isFinal, true);
});

test('streaming-parser: processa tags SFX e converte para speechTags Gemini', () => {
  const reply = '[casual_laughing] Haha, essa foi muito boa! 【Laugh】 Não esperava por isso. 【Sigh】';
  const balloons = parseReplyBalloons(reply);

  assert.ok(balloons.length >= 1);
  assert.equal(balloons[0].emotionKey, 'casual_laughing');
  // O SFX Laugh vira <laugh> no ttsText
  const withTts = balloons.find(b => b.speechTags.includes('laugh'));
  assert.ok(withTts, 'Deveria conter a tag laugh');
  assert.ok(withTts.ttsText.includes('<laugh>'));
  // O display não deve conter a tag <laugh>
  assert.ok(!withTts.display.includes('<laugh>'));
  assert.ok(!withTts.display.includes('【Laugh】'));
});

test('streaming-parser: streaming incremental feed() tolera cortes no meio de tags', () => {
  const parser = new UsamiStreamingParser();
  const ready = [];
  parser.onBalloonReady = b => ready.push(b);

  // Chunk 1 corta no meio da tag de emoção
  parser.feed('[casual_');
  assert.equal(ready.length, 0);

  // Chunk 2 completa a emoção e manda parte do texto
  parser.feed('happy] Tudo bem com você? ');
  // Como é o primeiro balão e tem pontuação com ~25 chars, pode emitir
  assert.equal(ready.length, 1);
  assert.equal(ready[0].emotionKey, 'casual_happy');
  assert.equal(ready[0].display, 'Tudo bem com você?');

  // Chunk 3 corta no meio do SFX
  parser.feed('Eu estive estudando 【La');
  // Chunk 4 fecha o SFX e finaliza
  parser.feed('ugh】 a tarde toda.');
  parser.flush();

  assert.ok(ready.length >= 2);
  const second = ready[1];
  assert.ok(second.speechTags.includes('laugh'));
  assert.ok(second.ttsText.includes('<laugh>'));
});

test('streaming-parser: respeita o limite de balões e não descarta texto', () => {
  const longText = 'Frase um bem detalhada. Frase dois com mais texto. Frase três continuando a conversa. Frase quatro explicando algo. Frase cinco com mais detalhes. Frase seis que deve ser absorvida.';
  const balloons = parseReplyBalloons(longText, { maxBalloons: 3, maxBalloonChars: 30 });

  assert.ok(balloons.length <= 3);
  assert.ok(balloons[balloons.length - 1].display.includes('Frase seis'));
});

test('streaming-parser: não entra em loop infinito com colchete solitário ou truncado (RESULT_CODE_HUNG protection)', () => {
  const lone = parseReplyBalloons('[');
  assert.equal(lone.length, 1);
  assert.equal(lone[0].display, '[');

  const unclosed = parseReplyBalloons('Olá [mundo');
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].display, 'Olá [mundo');

  const invalidTag = parseReplyBalloons('[1] teste [❤️]');
  assert.equal(invalidTag.length, 1);
  assert.match(invalidTag[0].display, /\[1\] teste/);
});

test('streaming-parser: nunca vaza [intimate_shy] nem cauda JSON truncada com colchete aberto no fim', () => {
  const leaked = "[casual_frustrated] H-hmph... me usando de cobaia de novo, baka? [intimate_shy]...M-mas se era teste de dormir, devia ter dito antes... fiquei preocupada à toa! ','gesture': 'angry','actions': [{'type':";
  const balloons = parseReplyBalloons(leaked);

  assert.ok(balloons.length >= 2, `esperava >=2 balões, veio ${balloons.length}`);
  const fullDisplay = balloons.map(b => b.display).join(' ');
  const fullTts = balloons.map(b => b.ttsText).join(' ');

  assert.ok(!fullDisplay.includes('[intimate_shy]'), `display vazou [intimate_shy]: ${fullDisplay}`);
  assert.ok(!fullDisplay.includes('gesture'), `display vazou gesture: ${fullDisplay}`);
  assert.ok(!fullDisplay.includes('actions'), `display vazou actions: ${fullDisplay}`);
  assert.ok(!fullTts.includes('[intimate_shy]'), `ttsText vazou [intimate_shy]: ${fullTts}`);
  assert.ok(!fullTts.includes('gesture'), `ttsText vazou gesture: ${fullTts}`);
  assert.equal(balloons[0].emotionKey, 'casual_frustrated');
  assert.equal(balloons[balloons.length - 1].emotionKey, 'intimate_shy');
});

test('streaming-parser: inclui pauseAfterMs por emoção e antecipa 1º balão em cláusula longa', () => {
  const longCompound = '[intimate_shy] Eu estava pensando em falar com você agora mesmo, mas fiquei com um pouquinho de vergonha.';
  const balloons = parseReplyBalloons(longCompound);
  assert.ok(balloons.length >= 2);
  assert.equal(balloons[0].emotionKey, 'intimate_shy');
  assert.equal(balloons[0].pauseAfterMs, 350);
  assert.match(balloons[0].display, /agora mesmo,$/);
});
