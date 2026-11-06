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
