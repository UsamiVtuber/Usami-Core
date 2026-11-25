import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FL_STUDIO_SCHEMA,
  STEP_PRESETS,
  SYSEX_HEADER,
  buildMidiScoreEvents,
  buildProgressionChords,
  decodeSysexMessage,
  encodeSysexMessage,
  expandChordName,
  parseNoteName,
  validateEqArgs,
  validateListenArgs,
  validateMidiArgs,
  validateMixerArgs,
  validatePluginArgs,
  validateRoutingArgs,
  validateStepsArgs,
  validateTransportArgs,
  validateUndoArgs,
} from '../fl-core.mjs';
import { buildMidiFileBytes, inspectMidiFileBytes } from '../fl-midi-writer.mjs';
import {
  queryGenreKnowledge,
  validateGuideArgs,
  validateLearnArgs,
  validateSerumArgs,
  validateUiArgs,
} from '../fl-knowledge.mjs';
import {
  VOCAL_STYLES,
  buildUstText,
  buildUstxYaml,
  buildVocalMelodyScore,
  inspectUstxText,
  syllabifyLyricsToCv,
  validateVocalArgs,
} from '../fl-utau.mjs';

test('fl-core: SysEx roundtrip preserva payload com acentos em 7-bit', () => {
  assert.equal(FL_STUDIO_SCHEMA, 'usami.skill.fl_studio.v1');
  const payload = { id: 'req-1', cmd: 'mixer', args: { name: 'Bateria — São Paulo' } };
  const encoded = encodeSysexMessage(payload);
  assert.equal(encoded[0], SYSEX_HEADER[0]);
  assert.equal(encoded[encoded.length - 1], 0xF7);
  for (let i = 1; i < encoded.length - 1; i += 1) {
    assert.ok(encoded[i] < 0x80, `byte >= 0x80 no indice ${i}: ${encoded[i]}`);
  }
  const decoded = decodeSysexMessage(encoded);
  assert.deepEqual(decoded, payload);
});

test('fl-core: parseNoteName, acordes estendidos, voicings e progressoes de genero', () => {
  assert.equal(parseNoteName('C4'), 60);
  assert.equal(parseNoteName('A4'), 69);
  assert.equal(parseNoteName('F#3'), 54);
  assert.equal(parseNoteName('Bb3'), 58);
  assert.equal(parseNoteName(72), 72);
  assert.throws(() => parseNoteName('H9'));
  assert.throws(() => parseNoteName(200));

  assert.deepEqual(expandChordName('C', 4), [60, 64, 67]);
  assert.deepEqual(expandChordName('Am', 4), [69, 72, 76]);
  assert.deepEqual(expandChordName('Fmaj7', 3), [53, 57, 60, 64]);
  assert.deepEqual(expandChordName('G7', 3), [55, 59, 62, 65]);
  assert.deepEqual(expandChordName('Dm11', 4), [62, 65, 69, 72, 76, 79]);
  assert.deepEqual(expandChordName('G7sus4', 3), [55, 60, 62, 65]);
  assert.deepEqual(expandChordName('C69', 4), [60, 64, 67, 69, 74]);

  const supersaw = expandChordName('Fmaj9', 4, { voicing: 'supersaw' });
  assert.ok(supersaw[0] <= 41, 'supersaw inclui grave/sub');
  assert.ok(supersaw.length >= 6, 'supersaw empilha oitavas');

  const colour = expandChordName('Cm11', 4, { voicing: 'colour_bass' });
  assert.ok(colour[0] <= 36, 'colour_bass inclui fundamental sub');
  assert.ok(colour[colour.length - 1] >= 72, 'colour_bass abre extensoes no agudo');

  // Royal Road em F: Bbmaj7 (A#maj7) - C7 - Am7 - Dm9
  assert.deepEqual(buildProgressionChords('kawaii_royal_road', 'F'), ['A#maj7', 'C7', 'Am7', 'Dm9']);
  assert.equal(buildProgressionChords('colour_bass_prism', 'Fm').length, 4);
  assert.equal(buildProgressionChords('riddim_dark', 'D#m')[2], 'E5');
  assert.throws(() => expandChordName('Xyz'));
});

test('fl-core: validadores de transport, mixer, steps half-time, plugin, midi e undo', () => {
  assert.deepEqual(validateTransportArgs({ action: 'set_bpm', bpm: 150 }), { action: 'set_bpm', bpm: 150 });
  assert.throws(() => validateTransportArgs({ action: 'set_bpm', bpm: 999 }));
  assert.throws(() => validateTransportArgs({ action: 'destroy' }));

  const mix = validateMixerArgs({ trackName: 'Kick', volumePercent: 100, mute: false });
  assert.equal(mix.trackName, 'Kick');
  assert.equal(mix.volume, 0.8);
  assert.equal(mix.mute, false);
  assert.throws(() => validateMixerArgs({ track: 1 }));

  const stepsPreset = validateStepsArgs({ channelName: 'Kick', preset: 'four_on_the_floor' });
  assert.deepEqual(stepsPreset.steps, [...STEP_PRESETS.four_on_the_floor]);

  const halftime32 = validateStepsArgs({ channelName: 'Snare', preset: 'halftime_snare', length: 32 });
  assert.deepEqual(halftime32.steps, [8, 24]);

  const kawaiiKick = validateStepsArgs({ channelName: 'Kick', preset: 'kawaii_bounce_kick' });
  assert.deepEqual(kawaiiKick.steps, [0, 3, 7, 10, 12, 15]);
  assert.throws(() => validateStepsArgs({ mode: 'replace', steps: [20], length: 16 }));

  const plug = validatePluginArgs({ target: 'mixer', track: 1, slot: 2, action: 'set_param', paramName: 'Mix', value: 0.5 });
  assert.equal(plug.slot, 2);
  assert.equal(plug.value, 0.5);
  assert.throws(() => validatePluginArgs({ target: 'channel', action: 'set_param', value: 2 }));

  const midi = validateMidiArgs({ progression: 'kawaii_royal_road', key: 'F', voicing: 'supersaw', durationMs: 300 });
  assert.equal(midi.events.length, 4);
  assert.ok(midi.events[0].notes.length >= 6);
  assert.throws(() => validateMidiArgs({}));

  assert.deepEqual(validateUndoArgs({}), { direction: 'undo' });
  assert.deepEqual(validateUndoArgs({ direction: 'redo' }), { direction: 'redo' });
  assert.throws(() => validateUndoArgs({ direction: 'nuke' }));

  const sc = validateRoutingArgs({ mode: 'sidechain', sourceTrackName: 'Kick', destTrackNames: ['Supersaw', 'Sub'] });
  assert.equal(sc.mode, 'sidechain');
  assert.deepEqual(sc.destTrackNames, ['Supersaw', 'Sub']);
  assert.throws(() => validateRoutingArgs({ mode: 'sidechain', sourceTrack: 1 }));

  const eqSub = validateEqArgs({ trackName: 'Sub', preset: 'sub_mono_clean' });
  assert.equal(eqSub.preset, 'sub_mono_clean');
  const eqCustom = validateEqArgs({ track: 2, lowGainDb: -6, stereoWidth: 35 });
  assert.equal(eqCustom.lowGainDb, -6);
  assert.equal(eqCustom.stereoWidth, 35);
  assert.throws(() => validateEqArgs({ track: 2 }));

  const listen = validateListenArgs({ durationSec: 2, genre: 'colour_bass' });
  assert.equal(listen.source, 'loopback');
  assert.equal(listen.genre, 'colour_bass');
  assert.throws(() => validateListenArgs({ source: 'file', filePath: 'bad.mp3' }));
});

test('fl-midi-writer: gera SMF Format 0 valido para todos os estilos Bass e Kawaii', () => {
  for (const style of ['sustained', 'future_bass_pump', 'kawaii_arp', 'melodic_dubstep_stack', 'riddim_bass', 'brostep_riff']) {
    const score = buildMidiScoreEvents({ style, key: 'Fm', bpm: 148 });
    assert.ok(score.notes.length > 0, `estilo ${style} gerou notas`);
    const bytes = buildMidiFileBytes({ bpm: score.bpm, trackName: score.fileName, notes: score.notes });
    const inspected = inspectMidiFileBytes(bytes);
    assert.equal(inspected.valid, true, `${style}: ${inspected.reason || ''}`);
    assert.equal(inspected.format, 0);
    assert.equal(inspected.tracks, 1);
    assert.equal(inspected.tpq, 480);
  }
});

test('fl-knowledge: playbooks dos 6 subgeneros e busca com notas aprendidas', () => {
  const cb = queryGenreKnowledge({
    genre: 'colour_bass',
    topic: 'fl_tricks',
    customNotes: [{ id: 'fln-1', genre: 'colour_bass', topic: 'fl_tricks', title: 'Vocodex 90 bandas', content: 'Carrier no sidechain 1' }],
  });
  assert.equal(cb.playbooks.length, 1);
  assert.equal(cb.playbooks[0].genre, 'colour_bass');
  assert.ok(cb.playbooks[0].sections.fl_tricks.some(t => /Vocodex/i.test(t)));
  assert.equal(cb.learnedNotes.length, 1);

  const searchRiddim = queryGenreKnowledge({ query: 'comb filter square4 ott' });
  assert.equal(searchRiddim.playbooks[0].genre, 'riddim');

  assert.deepEqual(validateGuideArgs({ genre: 'kawaii', topic: 'sound_design' }), { genre: 'kawaii', topic: 'sound_design' });
  const learnSave = validateLearnArgs({ action: 'save', genre: 'brostep', title: 'Growl FM', content: 'Osc B +2 oitavas em 42%' });
  assert.equal(learnSave.genre, 'brostep');
  assert.throws(() => validateLearnArgs({ action: 'save', title: 'ab', content: 'curto' }));

  // Verifica arsenal do usuario (Serum 2, Harmor, Ogun, Sytrus, Sakura) e validadores fl.serum / fl.ui
  assert.ok(cb.playbooks[0].sections.fl_tricks.some(t => /Serum 2.*Spectral|Harmor/i.test(t)));
  const sArgs = validateSerumArgs({ action: 'search', query: 'growl', category: 'Bass', limit: 10 });
  assert.equal(sArgs.query, 'growl');
  const sCreate = validateSerumArgs({ action: 'create', style: 'growl', presetName: 'Usami Growl', unison: 5, detune: 0.35 });
  assert.equal(sCreate.style, 'growl');
  assert.equal(sCreate.overrides.unison, 5);
  assert.throws(() => validateSerumArgs({ action: 'stage' }));

  const uiPlugin = validateUiArgs({ action: 'add_plugin', pluginName: 'Serum 2' });
  assert.equal(uiPlugin.pluginName, 'Serum 2');
  const uiKnob = validateUiArgs({ action: 'knob_drag', relX: 120, relY: 200, deltaPx: -45 });
  assert.equal(uiKnob.deltaPx, -45);
  assert.throws(() => validateUiArgs({ action: 'mouse_click', relX: -5, relY: 10 }));
});

test('fl-utau: silabifica PT-BR e Japones e gera .ustx / .ust validos nos 5 estilos vocais', () => {
  const ptSyl = syllabifyLyricsToCv('Vem dançar comigo na canção', 'pt');
  assert.ok(ptSyl.includes('ve'));
  assert.ok(ptSyl.includes('n'));
  assert.ok(ptSyl.includes('ko'));
  assert.ok(ptSyl.includes('mi'));

  const jaHira = syllabifyLyricsToCv('きみとみらいへ', 'ja');
  assert.deepEqual(jaHira, ['ki', 'mi', 'to', 'mi', 'ra', 'i', 'he']);

  const jaRomaji = syllabifyLyricsToCv('kimi to mirai', 'auto');
  assert.deepEqual(jaRomaji, ['ki', 'mi', 'to', 'mi', 'ra', 'i']);

  for (const style of VOCAL_STYLES) {
    const score = buildVocalMelodyScore({
      style,
      lyrics: 'vem brilhar comigo no luar',
      key: 'F',
      bpm: 154,
    });
    assert.ok(score.notes.length >= 6, `estilo ${style} gerou notas vocais`);
    for (const n of score.notes) {
      assert.ok(n.pitch >= 62 && n.pitch <= 79, `nota ${n.pitch} na tessitura vocal da Usami`);
    }
    const ustx = buildUstxYaml({
      projectName: `test_${style}`,
      singerName: 'Usami',
      bpm: score.bpm,
      barsTotal: score.barsTotal,
      notes: score.notes,
    });
    assert.equal(inspectUstxText(ustx).valid, true);
    assert.match(ustx, /singer: "Usami"/);
    assert.match(ustx, /renderer: WORLDLINE-R/);

    const ust = buildUstText({ projectName: `test_${style}`, bpm: score.bpm, notes: score.notes });
    assert.match(ust, /UST Version1\.20/);
  }

  const validated = validateVocalArgs({ action: 'compose', style: 'kawaii_hook', lyrics: 'ola mundo', bpm: 158 });
  assert.equal(validated.bpm, 158);
  assert.equal(validated.engine, 'classic');

  const diffValidated = validateVocalArgs({ action: 'compose', engine: 'diffsinger', style: 'kawaii_hook', lyrics: 'vem brilhar' });
  assert.equal(diffValidated.singerName, 'Evelyn DS v110');
  const diffUstx = buildUstxYaml({
    projectName: 'neuro_style',
    engine: 'diffsinger',
    bpm: 156,
    barsTotal: 4,
    notes: [{ startTick: 0, durationTicks: 480, pitch: 65, lyric: 've', vibratoLength: 50 }],
  });
  assert.match(diffUstx, /singer: "Evelyn DS v110"/);
  assert.match(diffUstx, /renderer: DIFFSINGER/);
  assert.match(diffUstx, /OpenUtau\.Core\.DiffSinger\.DiffSingerPhonemizer/);

  const convValidated = validateVocalArgs({ action: 'convert', pitchShift: 2, diffusionSteps: 35 });
  assert.equal(convValidated.pitchShift, 2);
  assert.equal(convValidated.diffusionSteps, 35);
  assert.throws(() => validateVocalArgs({ action: 'invalid' }));
});
