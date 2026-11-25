import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateSkillManifest } from '../src/agent-contracts.js';
import { createToolRegistry } from '../src/tool-registry.js';
import {
  DEFAULT_TOOL_MATCHERS,
  classifyDeterministic,
  formatExecutedTurnFallbackReply,
} from '../src/agent-core.js';
import { selectTopKTools } from '../src/tool-selector.js';
import {
  FL_STUDIO_SKILL_ID,
  FL_STUDIO_TOOLS,
  createFlStudioClient,
  createFlStudioTools,
  publishFlStudioSkill,
} from '../src/fl-studio-skill.js';
import { FL_STUDIO_SCHEMA } from '../skills/fl-studio/fl-core.mjs';
import { inspectMidiFileBytes } from '../skills/fl-studio/fl-midi-writer.mjs';
import { createSerumPresetLibrary, parseSerumPresetHeaderBuffer } from '../src/fl-serum-presets.js';
import { installFlScript } from '../scripts/install-fl-script.mjs';
import { WHISPER_INITIAL_PROMPT } from '../src/stt.js';
import { parseProviderRaw } from '../src/provider-parse.js';

const execFileAsync = promisify(execFile);

function createTestStereoWav(filePath, { sr = 48000, durationSec = 1.0, outOfPhaseSub = true } = {}) {
  const numSamples = Math.floor(sr * durationSec);
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sr;
    const subL = 0.55 * Math.sin(2 * Math.PI * 50 * t);
    const subR = outOfPhaseSub ? -subL : subL;
    const mid = 0.25 * Math.sin(2 * Math.PI * 1000 * t);
    const l = Math.max(-1, Math.min(1, subL + mid));
    const r = Math.max(-1, Math.min(1, subR + mid));
    buf.writeInt16LE(Math.round(l * 32767), offset);
    buf.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }
  writeFileSync(filePath, buf);
}

test('fl-studio-skill: publica manifesto v1.5 valido, faz upgrade preservando state e registra 16 ferramentas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-fl-manifest-'));
  try {
    const legacyDir = join(dir, 'skills', 'fl-studio');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'skill.json'), JSON.stringify({
      schema: 'usami.agent.skill.v1',
      id: 'fl-studio',
      version: '1.3.0',
      state: 'disabled',
      tools: ['fl.state'],
    }), 'utf8');

    const upgraded = publishFlStudioSkill({ dataDir: dir });
    assert.equal(upgraded.upgraded, true);
    const manifestRaw = JSON.parse(readFileSync(join(upgraded.skillDir, 'skill.json'), 'utf8'));
    assert.equal(manifestRaw.version, '1.6.0');
    assert.equal(manifestRaw.state, 'disabled');
    assert.equal(existsSync(join(upgraded.skillDir, 'fl-utau.mjs')), true);
    const checked = validateSkillManifest(manifestRaw);
    assert.equal(checked.ok, true, checked.errors?.join('; '));
    assert.equal(checked.value.id, FL_STUDIO_SKILL_ID);
    assert.deepEqual(checked.value.tools, [...FL_STUDIO_TOOLS]);

    const registry = createToolRegistry();
    const tools = createFlStudioTools({ flClient: createFlStudioClient(), dataDir: dir });
    assert.equal(tools.length, 16);
    for (const tool of tools) {
      const reg = registry.register(tool);
      assert.equal(reg.ok, true, `${tool.name}: ${reg.errors?.join('; ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeSerumPreset(filePath, meta) {
  const header = Buffer.from('XferJson\x00\x10\x00\x00\x00\x00\x00\x00\x00', 'binary');
  const jsonBytes = Buffer.from(JSON.stringify({ fileType: 'SerumPreset', product: 'Serum2', ...meta }), 'utf8');
  const tail = Buffer.alloc(16, 0xAB);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, Buffer.concat([header, jsonBytes, tail]));
}

test('fl-studio-skill: executa e verifica todas as 15 tools (incluindo fl.serum XferJson e fl.ui)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-fl-exec-'));
  try {
    const wavPath = join(dir, 'sub-out-of-phase.wav');
    createTestStereoWav(wavPath, { outOfPhaseSub: true });

    const fakeSerumRoot = join(dir, 'Serum2Presets');
    createFakeSerumPreset(join(fakeSerumRoot, 'Bass', 'BA - Riddim Comb.SerumPreset'), {
      presetName: 'BA - Riddim Comb',
      presetAuthor: 'Usami Lab',
      tags: ['Spectral', 'Mono', 'Bass'],
    });
    createFakeSerumPreset(join(fakeSerumRoot, 'Leads', 'LD - Kawaii Blip.SerumPreset'), {
      presetName: 'LD - Kawaii Blip',
      presetAuthor: 'Usami Lab',
      tags: ['Wavetable', 'Lead'],
    });
    const fakeSerumLib = createSerumPresetLibrary({ presetsRoot: fakeSerumRoot });
    const parsedHdr = parseSerumPresetHeaderBuffer(readFileSync(join(fakeSerumRoot, 'Bass', 'BA - Riddim Comb.SerumPreset')));
    assert.equal(parsedHdr.presetName, 'BA - Riddim Comb');

    const realAnalyzerClient = createFlStudioClient();
    const calls = [];
    const fakeClient = {
      async request(cmd, args) {
        calls.push({ kind: 'request', cmd, args });
        if (cmd === 'state') {
          return {
            transport: { bpm: 150, playing: true, recording: false, loopMode: 'pattern', metronome: false, songTime: '1:01:00' },
            pattern: { index: 1, name: 'Drop 1', length: 16 },
            channelCount: 2,
            channels: [{ index: 0, name: 'Kick', selected: true, muted: false, mixerTrack: 1 }],
            mixerTracks: [{ index: 0, name: 'Master', volume: 0.8, pan: 0, muted: false, solo: false, peakL: 0.5, peakR: 0.5, clipping: false }],
          };
        }
        if (cmd === 'transport') return { action: args.action, bpm: args.bpm || 150, playing: true };
        if (cmd === 'mixer') return { index: 1, name: args.trackName || 'Kick', volume: args.volume ?? 0.8, muted: false, solo: false };
        if (cmd === 'routing') return { mode: args.mode, sourceTrack: 1, sourceName: 'Kick', applied: [{ destTrack: 5, active: true, level: 0 }] };
        if (cmd === 'eq') return { track: 2, trackName: args.trackName || 'Sub', preset: args.preset || null, bands: { lowGainDb: 1 }, stereoWidth: -100 };
        if (cmd === 'steps') return { channel: 0, channelName: args.channelName || 'Snare', pattern: 1, mode: args.mode, length: args.length, activeSteps: args.steps || [] };
        if (cmd === 'plugin') return { target: args.target, index: 0, slot: -1, pluginName: 'Serum 2', totalParams: 12, matchedCount: 1, params: [{ index: 0, name: 'Macro 1', value: 0.5 }] };
        if (cmd === 'undo') return { direction: args.direction, historyLast: 'Knob tweak', historyCount: 3 };
        return {};
      },
      async playMidi(args) {
        calls.push({ kind: 'playMidi', args });
        return { ok: true, port: 'Usami-To-FL', channel: args.channel, notesSent: 24, eventsPlayed: 4 };
      },
      async listenAudio(args) {
        calls.push({ kind: 'listenAudio', args });
        return realAnalyzerClient.listenAudio(args);
      },
      async runUiAction(args) {
        calls.push({ kind: 'runUiAction', args });
        return { ok: true, action: args.action, pluginName: args.pluginName || null, window: 'FL Studio 2026' };
      },
      async convertSingingAudio(args) {
        calls.push({ kind: 'convertSingingAudio', args });
        writeFileSync(args.outputWav, readFileSync(args.sourceWav));
        return {
          ok: true,
          engine: 'seed-vc-singing-f0',
          sourceWav: args.sourceWav,
          referenceWav: args.referenceWav,
          outputWav: args.outputWav,
          outputBytes: 1024,
          elapsedSec: 12.4,
        };
      },
      async createSerumPreset(args) {
        calls.push({ kind: 'createSerumPreset', args });
        return {
          ok: true,
          presetName: args.presetName,
          style: args.style,
          bankName: args.bankName || 'Usami',
          outPath: join(dir, `${args.presetName}.SerumPreset`),
          md5: 'deadbeef',
        };
      },
    };

    const telemetry = [];
    const tools = createFlStudioTools({
      flClient: fakeClient,
      dataDir: dir,
      serumLibrary: fakeSerumLib,
      onTelemetry: evt => telemetry.push(evt),
    });
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));

    const stateRes = await byName['fl.state'].execute({ onlyActive: true });
    assert.equal(stateRes.schema, FL_STUDIO_SCHEMA);
    assert.equal(byName['fl.state'].verify(stateRes), true);

    // Analise espectral real em arquivo WAV com sub fora de fase + alvo dubstep!
    const listenRes = await byName['fl.listen'].execute({ source: 'file', filePath: wavPath, genre: 'dubstep' });
    assert.equal(byName['fl.listen'].verify(listenRes), true);
    assert.equal(listenRes.silent, false);
    assert.deepEqual(listenRes.targetLufsRange, [-6.5, -3.5]);
    assert.ok(Array.isArray(listenRes.suggestions));
    assert.ok(listenRes.stereo.subCorrelation < 0, `esperava correlacao sub negativa, veio ${listenRes.stereo.subCorrelation}`);
    assert.ok(listenRes.warnings.some(w => /Sub grave.*fora de mono/i.test(w)), 'detectou Sub fora de mono');

    // Aprendizado persistente (fl.learn) -> recuperado automaticamente em fl.guide!
    const learnSaveRes = await byName['fl.learn'].execute({
      action: 'save',
      genre: 'colour_bass',
      topic: 'fl_tricks',
      title: 'Meu Vocodex Template',
      content: 'Track 10 Growl Modulator, Track 11 Chords Carrier via sidechain 1 e HPF em 130 Hz.',
    });
    assert.equal(byName['fl.learn'].verify(learnSaveRes), true);
    assert.match(learnSaveRes.note.id, /^fln-[0-9a-f]{8}$/);

    const guideRes = await byName['fl.guide'].execute({ genre: 'colour_bass', topic: 'fl_tricks' });
    assert.equal(byName['fl.guide'].verify(guideRes), true);
    assert.equal(guideRes.playbooks[0].genre, 'colour_bass');
    assert.ok(guideRes.learnedNotes.some(n => n.title === 'Meu Vocodex Template'));

    const transRes = await byName['fl.transport'].execute({ action: 'set_bpm', bpm: 150 });
    assert.equal(byName['fl.transport'].verify(transRes), true);

    const mixRes = await byName['fl.mixer'].execute({ trackName: 'Kick', volumePercent: 75 });
    assert.equal(byName['fl.mixer'].verify(mixRes), true);

    const routeRes = await byName['fl.routing'].execute({
      mode: 'sidechain',
      sourceTrackName: 'Kick',
      destTrackNames: ['Supersaw', 'Sub'],
    });
    assert.equal(byName['fl.routing'].verify(routeRes), true);
    assert.equal(routeRes.mode, 'sidechain');

    const eqRes = await byName['fl.eq'].execute({ trackName: 'Sub', preset: 'sub_mono_clean' });
    assert.equal(byName['fl.eq'].verify(eqRes), true);
    assert.equal(eqRes.stereoWidth, -100);

    const stepsRes = await byName['fl.steps'].execute({ channelName: 'Snare', preset: 'halftime_snare', length: 32 });
    assert.equal(byName['fl.steps'].verify(stepsRes), true);
    assert.deepEqual(stepsRes.activeSteps, [8, 24]);

    const plugRes = await byName['fl.plugin'].execute({ action: 'list_params', channelName: 'Vital' });
    assert.equal(byName['fl.plugin'].verify(plugRes), true);

    const midiRes = await byName['fl.midi'].execute({ progression: 'kawaii_royal_road', key: 'F', voicing: 'supersaw', durationMs: 300 });
    assert.equal(byName['fl.midi'].verify(midiRes), true);

    const midiFileRes = await byName['fl.midi_file'].execute({
      style: 'future_bass_pump',
      progression: 'kawaii_royal_road',
      key: 'F',
      bpm: 156,
    });
    assert.equal(byName['fl.midi_file'].verify(midiFileRes), true);
    assert.equal(existsSync(midiFileRes.filePath), true);
    assert.equal(existsSync(midiFileRes.latestScoreJsonPath), true);
    assert.equal(inspectMidiFileBytes(readFileSync(midiFileRes.filePath)).valid, true);
    const latestJson = JSON.parse(readFileSync(midiFileRes.latestScoreJsonPath, 'utf8'));
    assert.equal(latestJson.tpq, 480);
    assert.ok(latestJson.notes.length > 0);

    const undoRes = await byName['fl.undo'].execute({});
    assert.equal(byName['fl.undo'].verify(undoRes), true);

    const serumSearch = await byName['fl.serum'].execute({ action: 'search', query: 'riddim', tag: 'Spectral' });
    assert.equal(byName['fl.serum'].verify(serumSearch), true);
    assert.equal(serumSearch.presets.length, 1);
    assert.equal(serumSearch.presets[0].presetName, 'BA - Riddim Comb');

    const serumStaged = await byName['fl.serum'].execute({ action: 'stage', query: 'riddim' });
    assert.equal(serumStaged.stagedCount, 1);
    assert.equal(existsSync(serumStaged.staged[0].stagedPath), true);

    const serumCreated = await byName['fl.serum'].execute({ action: 'create', style: 'supersaw', presetName: 'Usami Supersaw Test', unison: 8, detune: 0.42 });
    assert.equal(byName['fl.serum'].verify(serumCreated), true);
    assert.equal(serumCreated.presetName, 'Usami Supersaw Test');

    const uiAdd = await byName['fl.ui'].execute({ action: 'add_plugin', pluginName: 'Serum 2' });
    assert.equal(byName['fl.ui'].verify(uiAdd), true);
    assert.equal(uiAdd.pluginName, 'Serum 2');

    const vocalRes = await byName['fl.vocal'].execute({
      action: 'compose',
      style: 'kawaii_hook',
      lyrics: 'vem brilhar comigo no luar',
      key: 'F',
      bpm: 156,
      fileName: 'kawaii_test_vocal',
    });
    assert.equal(byName['fl.vocal'].verify(vocalRes), true);
    assert.equal(existsSync(vocalRes.ustxPath), true);
    assert.equal(existsSync(vocalRes.ustPath), true);
    assert.equal(existsSync(vocalRes.midiPath), true);
    assert.match(readFileSync(vocalRes.ustxPath, 'utf8'), /ustx_version: "0\.6"/);

    const vocalStatus = await byName['fl.vocal'].execute({ action: 'status' });
    assert.equal(byName['fl.vocal'].verify(vocalStatus), true);
    assert.ok(vocalStatus.savedProjects.includes('kawaii_test_vocal.ustx'));

    const refWav = join(dir, 'usami_ref.wav');
    createTestStereoWav(refWav, { durationSec: 0.5, outOfPhaseSub: false });
    const vocalConv = await byName['fl.vocal'].execute({
      action: 'convert',
      sourceWav: wavPath,
      referenceWav: refWav,
      fileName: 'neuro_demo',
      pitchShift: 0,
    });
    assert.equal(byName['fl.vocal'].verify(vocalConv), true);
    assert.equal(existsSync(vocalConv.outputWav), true);

    assert.equal(telemetry.length, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fl-studio-skill: falha fechado em caminhos proibidos e portas ausentes', async () => {
  const nonWin = createFlStudioClient({ platform: 'linux' });
  await assert.rejects(() => nonWin.request('ping'), /apenas no Windows/);
  await assert.rejects(() => nonWin.listenAudio({ source: 'file', filePath: 'a:/Usami Project/vault/secret.wav' }), /bloqueado/);

  const missingPortClient = createFlStudioClient({
    platform: 'win32',
    execPython: async () => ({
      stdout: JSON.stringify({
        ok: false,
        code: 'port_not_found',
        error: 'Porta MIDI virtual nao encontrada. Abra o loopMIDI.',
      }),
      stderr: '',
    }),
  });
  await assert.rejects(() => missingPortClient.request('state'), /loopMIDI/);
});

test('agent-core & tool-selector: roteia Sidechain, EQ Mono, Escuta Loopback, MIDI File e preserva Spotify', () => {
  assert.equal(classifyDeterministic('escuta minha mix no fl studio').kind, 'operational');
  assert.equal(classifyDeterministic('faz sidechain do kick pro supersaw e pro sub').kind, 'operational');
  assert.equal(classifyDeterministic('deixa o sub em mono no fl studio').kind, 'operational');
  assert.equal(classifyDeterministic('gera um arquivo midi de kawaii future bass em F a 158 bpm').kind, 'operational');

  const findMatch = text => DEFAULT_TOOL_MATCHERS.find(m => m.matches(text.toLowerCase()));
  assert.equal(findMatch('escuta minha mix no fl studio')?.toolName, 'fl.listen');
  assert.equal(findMatch('como fazer colour bass usando vocodex no fl studio')?.toolName, 'fl.guide');
  assert.equal(findMatch('anota no estudio que no meu template o chord bus fica na track 10')?.toolName, 'fl.learn');
  assert.equal(findMatch('busca presets de growl no serum 2')?.toolName, 'fl.serum');
  assert.equal(findMatch('cria um preset de growl no serum 2')?.toolName, 'fl.serum');
  const serumMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'fl.serum');
  assert.deepEqual(serumMatcher.buildArgs('cria um preset de supersaw com detune pesado no serum 2'), {
    action: 'create',
    style: 'supersaw',
    presetName: 'Usami - supersaw',
    detune: 0.45,
  });
  assert.equal(findMatch('adiciona um harmor no fl studio')?.toolName, 'fl.ui');
  assert.equal(findMatch('abre um novo serum 2 no fl studio')?.toolName, 'fl.ui');
  assert.equal(findMatch('abre um vital no fl studio')?.toolName, 'fl.ui');
  assert.equal(findMatch('adiciona um sylenth1 no fl studio')?.toolName, 'fl.ui');
  assert.equal(findMatch('faz a usami cantar "vem brilhar comigo" em f a 156 bpm no openutau')?.toolName, 'fl.vocal');
  assert.equal(findMatch('cria uma melodia vocal kawaii cantando kimi to mirai')?.toolName, 'fl.vocal');
  const vocalMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'fl.vocal');
  assert.deepEqual(vocalMatcher.buildArgs('faz a Usami cantar "vem brilhar comigo" em F a 156 bpm e abre no OpenUTAU'), {
    action: 'compose',
    engine: 'classic',
    style: 'kawaii_hook',
    lyrics: 'vem brilhar comigo',
    key: 'F',
    bpm: 156,
    openInUtau: true,
  });
  assert.deepEqual(vocalMatcher.buildArgs('cria um vocal estilo neuro-sama cantando "vem brilhar" em F a 156 bpm'), {
    action: 'compose',
    engine: 'diffsinger',
    style: 'kawaii_hook',
    lyrics: 'vem brilhar',
    key: 'F',
    bpm: 156,
  });
  assert.deepEqual(vocalMatcher.buildArgs('converte a guia vocal pra voz da Usami'), {
    action: 'convert',
  });
  assert.equal(findMatch('faz sidechain do kick pro supersaw e sub')?.toolName, 'fl.routing');
  assert.equal(findMatch('deixa o sub em mono no fl studio')?.toolName, 'fl.eq');
  assert.equal(findMatch('como esta o fl studio agora')?.toolName, 'fl.state');
  assert.equal(findMatch('da play no fl studio')?.toolName, 'fl.transport');
  const transportMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'fl.transport');
  assert.deepEqual(transportMatcher.buildArgs('coloca o bpm do fl studio em 145'), { action: 'set_bpm', bpm: 145 });
  assert.deepEqual(transportMatcher.buildArgs('coloca 158 de bpm no fl studio'), { action: 'set_bpm', bpm: 158 });
  const stateMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'fl.state');
  assert.equal(stateMatcher.matches('coloca o bpm do fl studio em 160'), false);
  assert.equal(findMatch('lista o que voce pode fazer no fl studio')?.toolName, 'self.describe');

  const leakedXml = parseProviderRaw('<tool_call>\n<function=fl_state>\n<parameter=maxChannels>\n24\n</parameter>\n</function>\n</tool_call>');
  assert.equal(leakedXml.ok, false);
  assert.equal(leakedXml.status, 502);

  const mixedXml = parseProviderRaw('Consigo mexer no Mixer e no Piano Roll!\n<tool_call><function=fl_state></function></tool_call>');
  assert.equal(mixedXml.ok, true);
  assert.equal(mixedXml.reply, 'Consigo mexer no Mixer e no Piano Roll!');
  assert.equal(findMatch('muta o canal kick no fl studio')?.toolName, 'fl.mixer');
  assert.equal(findMatch('coloca padrao de riddim no kick no fl studio')?.toolName, 'fl.steps');
  assert.equal(findMatch('lista os parametros do vital no fl studio')?.toolName, 'fl.plugin');
  assert.equal(findMatch('ajusta o wavetable e o ott do serum')?.toolName, 'fl.plugin');
  assert.equal(findMatch('toca royal road em f no fl studio')?.toolName, 'fl.midi');
  assert.equal(findMatch('monta um acorde com supersaws e detune pesado')?.toolName, 'fl.midi');
  assert.equal(findMatch('gera um arquivo midi de colour bass em fm a 145 bpm')?.toolName, 'fl.midi_file');
  assert.equal(findMatch('desfaz isso no fl studio')?.toolName, 'fl.undo');

  const routeMatcher = DEFAULT_TOOL_MATCHERS.find(m => m.toolName === 'fl.routing');
  assert.deepEqual(routeMatcher.buildArgs('faz sidechain do Kick pro Supersaw e Sub no FL Studio'), {
    mode: 'sidechain',
    sourceTrackName: 'Kick',
    destTrackNames: ['Supersaw', 'Sub'],
  });

  // Regressao Spotify intacta (inclusive "oq eu estava ouvindo")
  assert.equal(findMatch('oq eu estava ouvindo')?.toolName, 'spotify.now_playing');
  assert.equal(findMatch('toca idol no spotify')?.toolName, 'spotify.control');
  assert.equal(findMatch('pausa a musica')?.toolName, 'spotify.control');

  // Top-K selector
  const tools = createFlStudioTools({ flClient: createFlStudioClient() });
  assert.ok(selectTopKTools('faz sidechain no submix bus', tools, { k: 3 }).some(t => t.name === 'fl.routing'));
  assert.ok(selectTopKTools('escuta o lufs e fase do espectro', tools, { k: 3 }).some(t => t.name === 'fl.listen'));
  assert.ok(selectTopKTools('deixa o sub em mono no eq', tools, { k: 3 }).some(t => t.name === 'fl.eq'));

  const listenReply = formatExecutedTurnFallbackReply({
    status: 'executed',
    tool: 'fl.listen',
    result: { silent: false, durationSec: 2.5, lufsApprox: -8.4, peakDbfs: -0.3, stereo: { subCorrelation: 0.99 }, warnings: [] },
  });
  assert.match(listenReply, /-8\.4 LUFS/);

  // Reconhecimento por voz (STT / Web Speech pt-BR): grafias foneticas aportuguesadas e prompt do Whisper
  assert.match(WHISPER_INITIAL_PROMPT, /FL Studio/);
  assert.match(WHISPER_INITIAL_PROMPT, /OpenUTAU/);
  assert.match(WHISPER_INITIAL_PROMPT, /sidechain/);
  assert.match(WHISPER_INITIAL_PROMPT, /Kawaii/);
  assert.match(WHISPER_INITIAL_PROMPT, /Colour Bass/);

  const matchSpoken = text => {
    // Reproduz o caminho real de classifyDeterministic + resolveToolCalls usando normalizeText interno
    const det = classifyDeterministic(text);
    assert.equal(det.kind, 'operational', `esperava operational para fala "${text}"`);
    return DEFAULT_TOOL_MATCHERS.find(m => m.matches(
      text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(?:f\s+l|efe\s+ele)\s+(?:studio|estudio)\b/g, 'fl studio')
        .replace(/\bfl\s+estudio\b/g, 'fl studio')
        .replace(/\b(?:side\s+chain|said\s*chein|saide\s*chein)\b/g, 'sidechain')
        .replace(/\b(?:super\s+saw|supersol)\b/g, 'supersaw')
        .replace(/\b(?:color\s+bass|colou?r\s+beis)\b/g, 'colour bass')
        .replace(/\bfuture\s+beis\b/g, 'future bass')
        .replace(/\b(?:kawai|cauai)\b/g, 'kawaii')
        .replace(/\bridim\b/g, 'riddim')
        .replace(/\bb\s+p\s+m\b/g, 'bpm')
        .replace(/\b(?:l\s+u\s+f\s+s|lufis)\b/g, 'lufs'),
    ));
  };

  assert.equal(matchSpoken('faz saidchein do kick pro super saw no efe ele estúdio')?.toolName, 'fl.routing');
  assert.deepEqual(routeMatcher.buildArgs('faz saidchein do Kick pro super saw no efe ele estúdio'), {
    mode: 'sidechain',
    sourceTrackName: 'Kick',
    destTrackName: 'Supersaw',
  });
  assert.equal(matchSpoken('coloca o b p m do f l estúdio em 150')?.toolName, 'fl.transport');
  assert.equal(matchSpoken('mede os lufis da minha mix no fl estúdio')?.toolName, 'fl.listen');
  assert.equal(matchSpoken('gera um arquivo midi de cauai future beis em F a 158 b p m')?.toolName, 'fl.midi_file');
  assert.equal(matchSpoken('coloca padrão de ridim no kick no f l studio')?.toolName, 'fl.steps');
  assert.ok(selectTopKTools('faz saidchein e mede os lufis no efe ele estúdio', tools, { k: 4 }).some(t => t.name === 'fl.routing' || t.name === 'fl.listen'));
});

test('bridges Python (winmm + WASAPI loopback) e instalador de scripts FL funcionam no Windows', async () => {
  if (process.platform === 'win32') {
    const { stdout: listOut } = await execFileAsync('python', ['tools/fl-bridge/winmm_midi_bridge.py', 'list'], {
      timeout: 8000,
      windowsHide: true,
    });
    assert.equal(JSON.parse(listOut.trim()).ok, true);

    const { stdout: loopOut } = await execFileAsync('python', ['tools/fl-bridge/audio_analyzer.py', '--source', 'loopback', '--duration', '0.5'], {
      timeout: 10000,
      windowsHide: true,
    });
    const loopParsed = JSON.parse(loopOut.trim());
    assert.equal(loopParsed.ok, true, loopParsed.error || '');
    assert.equal(typeof loopParsed.silent, 'boolean');

    const { stdout: uiOut } = await execFileAsync('python', ['tools/fl-bridge/ui_bridge.py', '--payload', '{"action":"inspect_windows"}'], {
      timeout: 8000,
      windowsHide: true,
    });
    const uiParsed = JSON.parse(uiOut.trim());
    assert.equal(uiParsed.ok, true, uiParsed.error || '');
    assert.ok(Array.isArray(uiParsed.installedGenerators));
  }

  const fakeSettings = mkdtempSync(join(tmpdir(), 'usami-fl-settings-'));
  try {
    const fakeHw = join(fakeSettings, 'Hardware');
    mkdirSync(fakeHw, { recursive: true });
    const res = installFlScript({ destRoot: fakeHw, dryRun: false, scoreJsonPath: 'A:/Usami Project/usami/data/midi/latest_score.json' });
    assert.equal(res.ok, true);
    assert.equal(existsSync(res.targetFile), true);
    assert.equal(existsSync(res.pianoRollScript), true);
    const pyScriptText = readFileSync(res.pianoRollScript, 'utf8');
    assert.match(pyScriptText, /A:\/Usami Project\/usami\/data\/midi\/latest_score\.json/);
  } finally {
    rmSync(fakeSettings, { recursive: true, force: true });
  }
});
