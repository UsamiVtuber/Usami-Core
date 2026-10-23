import test from 'node:test';
import assert from 'node:assert/strict';

import { curateExpressions } from '../src/expressions-catalog.js';

test('filtra lixo e dedupe case-insensitive mantendo a primeira forma original', () => {
  const result = curateExpressions([
    '---------',
    'x'.repeat(50),
    '',
    42,
    'Happy',
    'happy',
    'HAPPY',
    '01-prefab_happy01',
  ]);

  assert.deepEqual(result, {
    curated: [
      { name: 'Happy', tag: 'happy' },
      { name: '01-prefab_happy01', tag: 'happy' },
    ],
    dropped: 6,
  });
});

test('taggeia por keyword e ordena emoções, other e speak/blink', () => {
  const result = curateExpressions(['a', 'Blink', 'smile', 'desconhecido_sem_tag_no_vrm', '???']);

  assert.deepEqual(result.curated, [
    { name: 'smile', tag: 'happy' },
    { name: 'desconhecido_sem_tag_no_vrm', tag: 'other' },
    { name: 'a', tag: 'speak' },
    { name: 'Blink', tag: 'blink' },
  ]);
  assert.equal(result.dropped, 1);
});

test('lista vazia (ou não-array) retorna catálogo vazio sem drops', () => {
  assert.deepEqual(curateExpressions([]), { curated: [], dropped: 0 });
  assert.deepEqual(curateExpressions(null), { curated: [], dropped: 0 });
  assert.deepEqual(curateExpressions(undefined), { curated: [], dropped: 0 });
});

test('limit trunca o catálogo e soma os truncados em dropped', () => {
  const result = curateExpressions(['happy', '###', 'sad', 'angry', 'blink'], { limit: 2 });

  assert.deepEqual(result.curated, [
    { name: 'happy', tag: 'happy' },
    { name: 'sad', tag: 'sad' },
  ]);
  assert.equal(result.dropped, 3);
});

test('limite padrão é 12', () => {
  const names = Array.from({ length: 15 }, (_, index) => `expr_${String(index).padStart(2, '0')}`);
  const result = curateExpressions(names);

  assert.equal(result.curated.length, 12);
  assert.equal(result.curated[0].name, 'expr_00');
  assert.equal(result.curated[11].name, 'expr_11');
  assert.equal(result.dropped, 3);
});

test('tags por keyword são case-insensitive e a primeira regra que casa vence', () => {
  const names = [
    'JOY', 'tears_02', 'MAD', 'amazed', 'SleepyFace', 'viseme_aa', 'Talk',
    'mouth_open', 'voice_low', 'wink_left', 'eyeClosed', 'zzz', 'sad_blink', 'happy_talk',
  ];
  // 14 nomes: limit maior que o padrão para nada ser truncado neste teste.
  const tags = new Map(curateExpressions(names, { limit: 20 }).curated.map(entry => [entry.name, entry.tag]));

  assert.equal(tags.get('JOY'), 'happy');
  assert.equal(tags.get('tears_02'), 'sad');
  assert.equal(tags.get('MAD'), 'angry');
  assert.equal(tags.get('amazed'), 'surprised');
  assert.equal(tags.get('SleepyFace'), 'relaxed');
  assert.equal(tags.get('viseme_aa'), 'speak');
  assert.equal(tags.get('Talk'), 'speak');
  assert.equal(tags.get('mouth_open'), 'speak');
  assert.equal(tags.get('voice_low'), 'speak');
  assert.equal(tags.get('wink_left'), 'blink');
  assert.equal(tags.get('eyeClosed'), 'blink');
  assert.equal(tags.get('zzz'), 'other');
  // Regras anteriores vencem mesmo quando regras posteriores também casam.
  assert.equal(tags.get('sad_blink'), 'sad');
  assert.equal(tags.get('happy_talk'), 'happy');
});

test('visemas de letra única casam exatamente, mesmo em maiúscula', () => {
  const names = ['A', 'I', 'u', 'E', 'o', 'aa', 'oh'];
  const tags = new Map(curateExpressions(names).curated.map(entry => [entry.name, entry.tag]));

  assert.equal(tags.get('A'), 'speak');
  assert.equal(tags.get('I'), 'speak');
  assert.equal(tags.get('u'), 'speak');
  assert.equal(tags.get('E'), 'speak');
  assert.equal(tags.get('o'), 'speak');
  // 'aa' e 'oh' contêm letras de visema, mas não são nomes exatos.
  assert.equal(tags.get('aa'), 'other');
  assert.equal(tags.get('oh'), 'other');
});

test('dentro de cada grupo de prioridade a ordem original é mantida', () => {
  const { curated } = curateExpressions(['sad', 'happy', 'zzz', 'unknown2', 'blink', 'a']);

  assert.deepEqual(curated.map(entry => entry.name), ['sad', 'happy', 'zzz', 'unknown2', 'blink', 'a']);
});

test('nomes com até 40 caracteres passam; 41 são descartados', () => {
  const long40 = 'b'.repeat(40);
  const long41 = 'a'.repeat(41);
  const { curated, dropped } = curateExpressions([long41, long40]);

  assert.deepEqual(curated, [{ name: long40, tag: 'other' }]);
  assert.equal(dropped, 1);
});

test('lista no estilo shiro: presets e nomes autorais priorizados sobre separadores', () => {
  const shiroLike = [
    '---------prefab---------',
    '01-prefab_happy01',
    '02-prefab_sad',
    '03-prefab_angry',
    '04-prefab_relaxed',
    '05-prefab_surprised',
    '06-prefab_blink',
    'blink',
    'happy',
    'sad',
    'angry',
    'relaxed',
    'surprised',
    'a',
    'i',
    'u',
    'e',
    'o',
    'neutral',
    'custom_shy_smile',
    'custom_tears',
    'custom_rage_fists',
    'custom_wow_face',
    'custom_sleepy_eyes',
    'custom_talk_loop',
    'custom_wink',
    'custom_giggle',
    '-------',
  ];

  const { curated, dropped } = curateExpressions(shiroLike);

  // 28 entradas: 1 lixo ('-------') e 27 válidas. As 15 emoções lotam o
  // limite padrão de 12; separador prefab, visemas e blinks ficam fora.
  assert.deepEqual(curated.map(entry => entry.name), [
    '01-prefab_happy01',
    '02-prefab_sad',
    '03-prefab_angry',
    '04-prefab_relaxed',
    '05-prefab_surprised',
    'happy',
    'sad',
    'angry',
    'relaxed',
    'surprised',
    'custom_shy_smile',
    'custom_tears',
  ]);
  assert.equal(dropped, 16);
});
