import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVrmaManager, VRMA_ANIMATIONS } from '../src/vrma-manager.js';

test('createVrmaManager sem vrm ou mixer inicializa fallback inativo com segurança', () => {
  const manager = createVrmaManager();
  assert.equal(manager.isAvailable(), false);
  assert.equal(manager.isVrmaActive(), false);
  assert.equal(manager.play('idle'), false);
  assert.equal(manager.playIdle(), false);
  assert.equal(manager.getCurrentName(), null);
  assert.doesNotThrow(() => manager.stop());
  assert.doesNotThrow(() => manager.dispose());
});

test('VRMA_ANIMATIONS contém catálogo com 11 animações principais mapeadas', () => {
  assert.ok(VRMA_ANIMATIONS.idle);
  assert.ok(VRMA_ANIMATIONS.talking);
  assert.ok(VRMA_ANIMATIONS.sleeping);
  assert.ok(VRMA_ANIMATIONS.nod);
  assert.ok(VRMA_ANIMATIONS.thinking);
  assert.ok(VRMA_ANIMATIONS.wave);
  assert.ok(VRMA_ANIMATIONS.clap);
  assert.ok(VRMA_ANIMATIONS.blush);
  assert.ok(VRMA_ANIMATIONS.angry);
  assert.ok(VRMA_ANIMATIONS.surprised);
  assert.ok(VRMA_ANIMATIONS.sleepy);
  assert.ok(VRMA_ANIMATIONS.sad);
  assert.ok(VRMA_ANIMATIONS.jump);
  assert.ok(VRMA_ANIMATIONS.lookAround);
});

test('createVrmaManager com vrm e mixer permite configuração de arm clearance', () => {
  const fakeNode = { rotation: { x: 0, y: 0, z: 0 } };
  const fakeVrm = {
    humanoid: {
      getNormalizedBoneNode: name => fakeNode,
    },
  };
  const fakeMixer = {
    clipAction: () => ({
      reset: () => {},
      play: () => {},
      stop: () => {},
      setLoop: () => {},
      fadeOut: () => {},
      isRunning: () => true,
    }),
  };

  const manager = createVrmaManager({
    vrm: fakeVrm,
    mixer: fakeMixer,
    defaultArmClearanceDeg: 15,
  });

  assert.equal(manager.isAvailable(), true);
  assert.equal(manager.getArmClearanceDeg(), 15);

  manager.setArmClearanceDeg(22);
  assert.equal(manager.getArmClearanceDeg(), 22);

  // Executa post correction sem quebrar
  assert.doesNotThrow(() => manager.applyPostCorrection());
  assert.doesNotThrow(() => manager.dispose());
});
