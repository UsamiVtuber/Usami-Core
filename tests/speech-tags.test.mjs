import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSpeechTags, extractSpeechTags, stripSpeechTags } from '../src/speech-tags.js';

test('extrai tags de som em inglês e português, sem deixar rastro no balão', () => {
  assert.deepEqual(
    extractSpeechTags('Pai! Você demorou! <chuckle>'),
    { text: 'Pai! Você demorou!', tags: ['chuckle'] },
  );
  assert.deepEqual(
    extractSpeechTags('Eu esperei... [suspiro] Tudo bem.'),
    { text: 'Eu esperei... Tudo bem.', tags: ['sigh'] },
  );
  assert.deepEqual(
    extractSpeechTags('Hmpf! <short pause> Não fala comigo.'),
    { text: 'Hmpf! Não fala comigo.', tags: ['short pause'] },
  );
});

test('colchetes desconhecidos não viram som e continuam no texto', () => {
  assert.deepEqual(
    extractSpeechTags('Isso é [estranho], mas ok.'),
    { text: 'Isso é [estranho], mas ok.', tags: [] },
  );
  assert.deepEqual(
    extractSpeechTags('[eagerness] Paiii!'),
    { text: '[eagerness] Paiii!', tags: [] },
  );
});

test('deduplica, limita a duas tags e preserva a ordem', () => {
  assert.deepEqual(
    extractSpeechTags('Oi <laugh> <laugh> <sigh> <chuckle>', { maxTags: 2 }),
    { text: 'Oi', tags: ['laugh', 'sigh'] },
  );
});

test('texto que era só tag fica vazio (o parse do chat decide o 502)', () => {
  assert.deepEqual(extractSpeechTags('<laugh>'), { text: '', tags: ['laugh'] });
});

test('stripSpeechTags não altera fala sem tag', () => {
  assert.equal(stripSpeechTags('N-não é que eu me importe...'), 'N-não é que eu me importe...');
  assert.deepEqual(extractSpeechTags(null), { text: '', tags: [] });
});

test('appendSpeechTags só aceita tags canônicas e não duplica', () => {
  assert.equal(appendSpeechTags('Pai!', ['chuckle']), 'Pai! <chuckle>');
  assert.equal(appendSpeechTags('Pai!', ['risada', 'laugh']), 'Pai! <laugh>');
  assert.equal(appendSpeechTags('Pai!', ['tag-inventada']), 'Pai!');
});

test('extrai os 9 SFX canônicos do OpenAmika em colchetes fullwidth 【...】 e normais', () => {
  assert.deepEqual(
    extractSpeechTags('Haha! 【Can_t_help_laughing】 Essa foi boa 【Soft_hmph】'),
    { text: 'Haha! Essa foi boa', tags: ['laugh', 'chuckle'] },
  );
  assert.deepEqual(
    extractSpeechTags('Calma... 【Deep_breath】 agora vai 【Yawn】'),
    { text: 'Calma... agora vai', tags: ['breath', 'short pause'] },
  );
  assert.deepEqual(
    extractSpeechTags('Cof [light_cough] [throat_clear]'),
    { text: 'Cof', tags: ['short pause'] },
  );
});
