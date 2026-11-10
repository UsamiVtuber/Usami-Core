import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAudioDeviceId,
  setAudioDeviceId,
  applyAudioSink,
  listAudioDevices,
} from '../src/audio-devices.js';

test('audio-devices: getAudioDeviceId e setAudioDeviceId com mock de storage', () => {
  const mockStorage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: k => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: k => mockStorage.delete(k),
    },
  };

  try {
    assert.equal(getAudioDeviceId('speaker'), '');
    setAudioDeviceId('speaker', 'device-sink-123');
    assert.equal(getAudioDeviceId('speaker'), 'device-sink-123');

    setAudioDeviceId('speaker', '');
    assert.equal(getAudioDeviceId('speaker'), '');

    setAudioDeviceId('mic', 'mic-device-abc');
    assert.equal(getAudioDeviceId('mic'), 'mic-device-abc');
  } finally {
    delete globalThis.window;
  }
});

test('audio-devices: applyAudioSink chama setSinkId no elemento ou AudioContext', async () => {
  let calledSinkId = null;
  const mockAudio = {
    setSinkId: async id => { calledSinkId = id; },
  };

  const res1 = await applyAudioSink(mockAudio, 'custom-sink-id');
  assert.equal(res1, true);
  assert.equal(calledSinkId, 'custom-sink-id');

  // Elemento sem suporte a setSinkId devolve false sem crash
  const mockUnsupported = {};
  const res2 = await applyAudioSink(mockUnsupported);
  assert.equal(res2, false);

  // Alvo nulo
  const res3 = await applyAudioSink(null);
  assert.equal(res3, false);
});

test('audio-devices: listAudioDevices mapeia audioinput e audiooutput com segurança', async () => {
  const mockMediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Microfone Realtek' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Fone de Ouvido' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam' },
      { kind: 'audiooutput', deviceId: 'spk-2', label: '' },
    ],
  };

  const { mics, speakers } = await listAudioDevices({ mediaDevices: mockMediaDevices });
  assert.equal(mics.length, 1);
  assert.equal(mics[0].id, 'mic-1');
  assert.equal(mics[0].label, 'Microfone Realtek');

  assert.equal(speakers.length, 2);
  assert.equal(speakers[0].id, 'spk-1');
  assert.equal(speakers[0].label, 'Fone de Ouvido');
  assert.equal(speakers[1].id, 'spk-2');
  assert.equal(speakers[1].label, 'Alto-falante (2)');

  const empty = await listAudioDevices({ mediaDevices: {} });
  assert.deepEqual(empty, { mics: [], speakers: [] });
});
