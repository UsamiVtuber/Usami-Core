import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSequence, sampleTrack, SEQUENCE_LIMITS } from '../src/motion-sequence.js';
import { buildSequenceRequest, SHAPE_NAMES, SHAPE_CATALOG } from '../src/sequence-shapes.js';

// Todo shape precisa expandir em uma sequência que passa na validação estrita
// — é o contrato entre o vocabulário do LLM e o runner do avatar.
test('todas as shapes expandem em sequências válidas', () => {
  for (const shape of SHAPE_NAMES) {
    const built = buildSequenceRequest({ shape });
    assert.equal(built.ok, true, `${shape}: ${built.errors?.join('; ')}`);
    const validated = validateSequence(built.sequence);
    assert.equal(validated.ok, true, `${shape}: ${validated.errors?.join('; ')}`);
    assert.equal(validated.sequence.durationMs, built.sequence.durationMs);
    for (const track of validated.sequence.tracks) {
      const keys = track.keys;
      assert.equal(keys[keys.length - 1].t, validated.sequence.durationMs, `${shape}/${track.bone}: último key ≠ durationMs`);
      assert.equal(keys[0].value, 0, `${shape}/${track.bone}: precisa começar em repouso`);
      assert.equal(keys[keys.length - 1].value, 0, `${shape}/${track.bone}: precisa terminar em repouso`);
      for (const key of keys) {
        assert.ok(Math.abs(key.value) <= SEQUENCE_LIMITS.maxOffsetRad, `${shape}/${track.bone}: amplitude ${key.value} acima do limite`);
      }
    }
  }
});

test('parâmetros são normalizados aos limites (defesa contra números do LLM)', () => {
  const built = buildSequenceRequest({ shape: 'wave-arm', amplitude: 99, cycles: 999, durationMs: 999999 });
  assert.equal(built.ok, true);
  assert.equal(built.sequence.durationMs, 8000);
  for (const track of built.sequence.tracks) {
    assert.ok(track.keys.length <= SEQUENCE_LIMITS.maxKeys, 'cycles estourou o teto de keyframes');
    for (const key of track.keys) {
      assert.ok(Math.abs(key.value) <= SEQUENCE_LIMITS.maxOffsetRad, `value ${key.value} acima do limite global`);
    }
  }
  // a faixa oscilatória (mão) respeita o clamp de amplitude; a pose do braço não
  const hand = built.sequence.tracks.find(t => t.bone === 'rightHand');
  for (const key of hand.keys) assert.ok(Math.abs(key.value) <= 0.5 + 1e-9);
  const baixo = buildSequenceRequest({ shape: 'nod', durationMs: 1, amplitude: -5 });
  assert.equal(baixo.ok, true);
  assert.equal(baixo.sequence.durationMs, 600);
  for (const track of baixo.sequence.tracks) {
    for (const key of track.keys) assert.ok(Math.abs(key.value) <= SEQUENCE_LIMITS.maxOffsetRad);
  }
});

test('shape desconhecida ou ausente é rejeitada sem lançar', () => {
  assert.equal(buildSequenceRequest({ shape: 'moonwalk' }).ok, false);
  assert.equal(buildSequenceRequest({}).ok, false);
  assert.equal(buildSequenceRequest(null).ok, false);
  assert.equal(buildSequenceRequest({ shape: 'wave-arm', durationMs: 'abc' }).ok, true); // cai no default
});

test('side escolhe o braço; padrão é right', () => {
  const left = buildSequenceRequest({ shape: 'wave-arm', side: 'left' });
  assert.ok(left.sequence.tracks.some(track => track.bone === 'leftUpperArm'));
  assert.ok(!left.sequence.tracks.some(track => track.bone.startsWith('right')));
  const padrao = buildSequenceRequest({ shape: 'reach' });
  assert.ok(padrao.sequence.tracks.every(track => track.bone.startsWith('right')));
});

test('forma senoidal: envelope liga suave e a oscilação atinge a amplitude', () => {
  const built = buildSequenceRequest({ shape: 'sway-arms', amplitude: 0.3, cycles: 1, durationMs: 2000 });
  const track = built.sequence.tracks.find(t => t.bone === 'leftUpperArm');
  const first = track.keys[0];
  assert.equal(first.value, 0);
  // no meio do primeiro quarto o envelope já passou de 0, senóide > 0
  assert.ok(sampleTrack(track.keys, 250) > 0.1, 'subida no primeiro quarto');
  const peak = Math.max(...track.keys.map(k => Math.abs(k.value)));
  assert.ok(peak > 0.2, `pico ${peak} deveria passar perto de 0.3 com o envelope`);
  assert.ok(peak <= 0.3 + 1e-9, 'pico não excede a amplitude pedida');
  assert.equal(sampleTrack(track.keys, 2000), 0, 'volta ao repouso no fim');
  // os dois braços em antifase
  const right = built.sequence.tracks.find(t => t.bone === 'rightUpperArm');
  const at = (keys, t) => sampleTrack(keys, t);
  assert.ok(at(track.keys, 500) * at(right.keys, 500) < 0, 'braços em fases opostas');
});

test('catálogo do prompt lista todas as shapes', () => {
  for (const shape of SHAPE_NAMES) assert.ok(SHAPE_CATALOG.includes(shape));
});
