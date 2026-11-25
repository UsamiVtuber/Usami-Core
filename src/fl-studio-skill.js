/**
 * Skill operacional FL Studio Controller (`fl-studio` v1.2).
 *
 * Publica `skills/fl-studio` em `dataDir/skills` e registra 11 ferramentas:
 *  - `fl.state` (nivel 1): BPM, transport, pattern, canais do Channel Rack e tracks do Mixer com picos;
 *  - `fl.listen` (nivel 1): captura WASAPI Loopback (ou le .wav) e analisa LUFS, espectro de 6 bandas e correlacao mono do Sub;
 *  - `fl.transport` (nivel 2): play, pause, stop, record, loop/pattern/song, metronomo, BPM e marcadores;
 *  - `fl.mixer` (nivel 2): volume, pan, mute, solo, nome e selecao de track no Mixer;
 *  - `fl.routing` (nivel 2): Sidechain ghost (level 0), submix bus_only, send paralelo, disconnect e inspect;
 *  - `fl.eq` (nivel 2): EQ nativo de 3 bandas da track + abertura estereo / 100% Mono;
 *  - `fl.steps` (nivel 2): Step Sequencer com presets half-time (Future Bass, Kawaii, Dubstep, Riddim, Brostep, Colour Bass);
 *  - `fl.plugin` (nivel 2): inspecao e ajuste de parametros/macros/presets de plugins (Channel Rack ou Mixer);
 *  - `fl.midi` (nivel 2): envio de notas, acordes estendidos/voicings ou progressoes MIDI ao vivo;
 *  - `fl.midi_file` (nivel 2): geracao de `.mid` + `latest_score.json` para Piano Roll;
 *  - `fl.undo` (nivel 2): desfazer/refazer ultima acao no FL Studio.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { readEnvValue } from './api-security.js';
import { dataDir as resolveDefaultDataDir } from './data-paths.js';
import { createFlKnowledgeStore } from './fl-knowledge-store.js';
import { createSerumPresetLibrary } from './fl-serum-presets.js';
import { publishSkillPackage } from './skill-package.js';
import {
  EQ_PRESETS,
  FL_STUDIO_SCHEMA,
  GENRE_PROGRESSIONS,
  LISTEN_GENRES,
  LISTEN_SOURCES,
  MIDI_STYLES,
  PLUGIN_ACTIONS,
  PLUGIN_TARGETS,
  ROUTING_MODES,
  STEPS_MODES,
  STEP_PRESETS,
  TRANSPORT_ACTIONS,
  UNDO_DIRECTIONS,
  VOICING_MODES,
  buildMidiScoreEvents,
  validateEqArgs,
  validateListenArgs,
  validateMidiArgs,
  validateMixerArgs,
  validatePluginArgs,
  validateRoutingArgs,
  validateStepsArgs,
  validateTransportArgs,
  validateUndoArgs,
} from '../skills/fl-studio/fl-core.mjs';
import {
  KNOWLEDGE_GENRES,
  KNOWLEDGE_TOPICS,
  LEARN_ACTIONS,
  SERUM_ACTIONS,
  SERUM_STYLES,
  UI_ACTIONS,
  UI_SHORTCUTS,
  queryGenreKnowledge,
  validateGuideArgs,
  validateLearnArgs,
  validateSerumArgs,
  validateUiArgs,
} from '../skills/fl-studio/fl-knowledge.mjs';
import { DEFAULT_TPQ, buildMidiFileBytes, inspectMidiFileBytes } from '../skills/fl-studio/fl-midi-writer.mjs';
import {
  VOCAL_ACTIONS,
  VOCAL_ENGINES,
  VOCAL_LANGUAGES,
  VOCAL_STYLES,
  buildUstText,
  buildUstxYaml,
  buildVocalMelodyScore,
  inspectUstxText,
  validateVocalArgs,
} from '../skills/fl-studio/fl-utau.mjs';
import { parseKeySignature } from '../skills/fl-studio/fl-core.mjs';

const execFileAsync = promisify(execFile);

export const FL_STUDIO_SKILL_ID = 'fl-studio';
export const FL_STUDIO_TOOLS = Object.freeze([
  'fl.state',
  'fl.listen',
  'fl.guide',
  'fl.learn',
  'fl.serum',
  'fl.ui',
  'fl.vocal',
  'fl.transport',
  'fl.mixer',
  'fl.routing',
  'fl.eq',
  'fl.steps',
  'fl.plugin',
  'fl.midi',
  'fl.midi_file',
  'fl.undo',
]);

const DEFAULT_OUT_PORT = 'Usami-To-FL';
const DEFAULT_IN_PORT = 'FL-To-Usami';
const DEFAULT_TIMEOUT_MS = 4000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC_DIR = join(REPO_ROOT, 'skills', FL_STUDIO_SKILL_ID);
const DEFAULT_BRIDGE_PATH = join(REPO_ROOT, 'tools', 'fl-bridge', 'winmm_midi_bridge.py');
const DEFAULT_AUDIO_ANALYZER_PATH = join(REPO_ROOT, 'tools', 'fl-bridge', 'audio_analyzer.py');
const DEFAULT_UI_BRIDGE_PATH = join(REPO_ROOT, 'tools', 'fl-bridge', 'ui_bridge.py');
const DEFAULT_SERUM_BUILDER_PATH = join(REPO_ROOT, 'tools', 'fl-bridge', 'serum_preset_builder.py');
const DEFAULT_SINGING_VC_BRIDGE_PATH = join(REPO_ROOT, 'tools', 'fl-bridge', 'singing_vc_bridge.py');
const DEFAULT_RVC_NOTEBOOK_PATH = join(REPO_ROOT, 'tools', 'rvc', 'train_and_sing_usami_rvc_v2.ipynb');

const FORBIDDEN_AUDIO_PATH_RE = /(?:^|[\\/])(?:\.env(?:\..*)?|\.git|vault|secrets?|credentials?)(?:[\\/]|$)/i;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishFlStudioSkill({ dataDir, bundledDir = SKILL_SRC_DIR } = {}) {
  const initial = publishSkillPackage({ skillId: FL_STUDIO_SKILL_ID, dataDir, bundledDir });
  if (initial.published) return initial;

  try {
    const targetDir = join(dataDir, 'skills', FL_STUDIO_SKILL_ID);
    const targetManifestPath = join(targetDir, 'skill.json');
    const bundledManifestPath = join(bundledDir, 'skill.json');
    const current = JSON.parse(readFileSync(targetManifestPath, 'utf8'));
    const next = JSON.parse(readFileSync(bundledManifestPath, 'utf8'));
    if (current?.version !== next?.version) {
      const preservedState = typeof current?.state === 'string' ? current.state : next.state;
      for (const rel of ['fl-core.mjs', 'fl-midi-writer.mjs', 'fl-knowledge.mjs', 'fl-utau.mjs', 'test/fl-studio.test.mjs']) {
        const srcFile = join(bundledDir, rel);
        const dstFile = join(targetDir, rel);
        if (existsSync(srcFile)) {
          mkdirSync(dirname(dstFile), { recursive: true });
          writeFileSync(dstFile, readFileSync(srcFile));
        }
      }
      writeFileSync(targetManifestPath, `${JSON.stringify({ ...next, state: preservedState }, null, 2)}\n`, 'utf8');
      return { published: true, upgraded: true, alreadyPresent: true, skillDir: targetDir };
    }
  } catch {
    // preserva estado existente caso nao seja legivel
  }
  return initial;
}

async function defaultExecPython(pythonBin, args, timeoutMs = 15000) {
  const res = await execFileAsync(pythonBin, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return {
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function resolveSafeWavPath(rawPath) {
  const resolved = resolve(rawPath);
  if (FORBIDDEN_AUDIO_PATH_RE.test(resolved)) {
    throw new Error('Caminho de audio bloqueado por politica de seguranca.');
  }
  if (!existsSync(resolved)) {
    throw new Error(`Arquivo WAV nao encontrado: ${rawPath}`);
  }
  const st = lstatSync(resolved);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error('Arquivo WAV invalido (symlink nao permitido).');
  }
  return resolved;
}

export function createFlStudioClient({
  envProvider = name => readEnvValue(name),
  execPython = defaultExecPython,
  outPort = null,
  inPort = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  bridgeScriptPath = DEFAULT_BRIDGE_PATH,
  audioAnalyzerPath = DEFAULT_AUDIO_ANALYZER_PATH,
  uiBridgePath = DEFAULT_UI_BRIDGE_PATH,
  serumBuilderPath = DEFAULT_SERUM_BUILDER_PATH,
  singingVcBridgePath = DEFAULT_SINGING_VC_BRIDGE_PATH,
  platform = process.platform,
} = {}) {
  function resolveConfig() {
    const resolvedOut = String(outPort || envProvider('FL_MIDI_OUT_PORT') || DEFAULT_OUT_PORT).trim();
    const resolvedIn = String(inPort || envProvider('FL_MIDI_IN_PORT') || DEFAULT_IN_PORT).trim();
    const pythonBin = String(envProvider('FL_BRIDGE_PYTHON') || 'python').trim() || 'python';
    return { outPort: resolvedOut, inPort: resolvedIn, pythonBin };
  }

  function ensureWindows(contextLabel = 'Ponte FL Studio') {
    if (platform !== 'win32') {
      throw new Error(`${contextLabel} disponivel apenas no Windows.`);
    }
  }

  async function runPythonJsonScript(scriptPath, args, execTimeoutMs, label = 'Ponte MIDI do FL Studio') {
    const { pythonBin } = resolveConfig();
    let stdout = '';
    try {
      const res = await execPython(pythonBin, [scriptPath, ...args], execTimeoutMs);
      stdout = String(res?.stdout || '').trim();
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 220);
      throw new Error(`Falha ao executar ${label}: ${detail}`);
    }
    if (!stdout) {
      throw new Error(`${label} nao retornou resposta.`);
    }
    try {
      const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop();
      return JSON.parse(lastLine);
    } catch {
      throw new Error(`Resposta invalida de ${label}: ${stdout.slice(0, 160)}`);
    }
  }

  return {
    getConfig: resolveConfig,

    async listPorts() {
      ensureWindows('Ponte FL Studio (loopMIDI)');
      const res = await runPythonJsonScript(bridgeScriptPath, ['list'], 6000);
      if (!res?.ok) {
        throw new Error(res?.error || 'Falha ao listar portas MIDI do Windows.');
      }
      return {
        inputs: Array.isArray(res.inputs) ? res.inputs : [],
        outputs: Array.isArray(res.outputs) ? res.outputs : [],
      };
    },

    async request(cmd, args = {}, opts = {}) {
      ensureWindows('Ponte FL Studio (loopMIDI)');
      const cfg = resolveConfig();
      const effectiveTimeout = Number.isInteger(opts.timeoutMs)
        ? Math.max(500, Math.min(opts.timeoutMs, 15000))
        : timeoutMs;
      const reqId = randomUUID().slice(0, 12);
      const payload = JSON.stringify({ id: reqId, cmd, args });

      const res = await runPythonJsonScript(
        bridgeScriptPath,
        [
          'request',
          '--out',
          cfg.outPort,
          '--in',
          cfg.inPort,
          '--payload',
          payload,
          '--timeout-ms',
          String(effectiveTimeout),
        ],
        effectiveTimeout + 4000,
      );

      if (!res?.ok) {
        throw new Error(res?.error || `FL Studio retornou erro no comando ${cmd}.`);
      }
      return res.data ?? {};
    },

    async playMidi({ channel = 0, events = [], targetChannel, targetChannelName } = {}) {
      ensureWindows('Ponte FL Studio (loopMIDI)');
      if (targetChannel !== undefined || targetChannelName !== undefined) {
        const selArgs = {};
        if (targetChannel !== undefined) selArgs.channel = targetChannel;
        if (targetChannelName !== undefined) selArgs.channelName = targetChannelName;
        await this.request('select_channel', selArgs);
      }

      const cfg = resolveConfig();
      const totalDurationMs = events.reduce((acc, ev) => acc + (ev.durationMs || 350) + (ev.delayMs || 0), 0);
      const payload = JSON.stringify({ channel, events });

      const res = await runPythonJsonScript(
        bridgeScriptPath,
        ['notes', '--out', cfg.outPort, '--payload', payload],
        Math.max(6000, totalDurationMs + 4000),
      );

      if (!res?.ok) {
        throw new Error(res?.error || 'Falha ao enviar notas MIDI para o FL Studio.');
      }
      return res;
    },

    async listenAudio({ source = 'loopback', durationSec = 2.5, genre = 'future_bass', filePath = null } = {}) {
      if (source === 'loopback') {
        ensureWindows('Escuta WASAPI Loopback');
      }
      const cliArgs = ['--source', source, '--duration', String(durationSec), '--genre', genre];
      if (source === 'file') {
        const safeWav = resolveSafeWavPath(filePath);
        cliArgs.push('--file', safeWav);
      }
      const execTimeout = Math.max(8000, Math.round(durationSec * 1000) + 6000);
      const res = await runPythonJsonScript(audioAnalyzerPath, cliArgs, execTimeout, 'Analisador de audio da Usami');
      if (!res?.ok) {
        throw new Error(res?.error || 'Falha ao analisar audio.');
      }
      return res;
    },

    async runUiAction(payload = {}) {
      ensureWindows('Automacao UI do FL Studio');
      const res = await runPythonJsonScript(
        uiBridgePath,
        ['--payload', JSON.stringify(payload)],
        12000,
        'Automacao UI do FL Studio',
      );
      if (!res?.ok) {
        throw new Error(res?.error || 'Falha na automacao de interface do FL Studio.');
      }
      return res;
    },

    async convertSingingAudio({
      sourceWav,
      referenceWav,
      outputWav,
      diffusionSteps = 30,
      pitchShift = 0,
    } = {}) {
      const safeSource = resolveSafeWavPath(sourceWav);
      const safeRef = resolveSafeWavPath(referenceWav);
      const cliArgs = [
        '--source',
        safeSource,
        '--reference',
        safeRef,
        '--output',
        resolve(outputWav),
        '--steps',
        String(diffusionSteps),
        '--pitch-shift',
        String(pitchShift),
      ];
      const res = await runPythonJsonScript(
        singingVcBridgePath,
        cliArgs,
        115000,
        'Conversor de canto Seed-VC da Usami',
      );
      if (!res?.ok) {
        throw new Error(res?.error || 'Falha na conversao de voz cantada via Seed-VC.');
      }
      return res;
    },

    async createSerumPreset(payload = {}) {
      const res = await runPythonJsonScript(
        serumBuilderPath,
        ['--payload', JSON.stringify(payload)],
        15000,
        'Criador de presets Serum 2 da Usami',
      );
      if (!res?.ok) {
        throw new Error(res?.error || 'Falha ao criar arquivo .SerumPreset.');
      }
      return res;
    },
  };
}

function writeSafeMidiArtifacts(baseDataDir, fileName, bytes, scorePayload) {
  const rootDir = resolve(baseDataDir || resolveDefaultDataDir(), 'midi');
  if (existsSync(rootDir) && lstatSync(rootDir).isSymbolicLink()) {
    throw new Error('Diretorio de destino MIDI nao pode ser symlink.');
  }
  mkdirSync(rootDir, { recursive: true });
  const targetPath = resolve(rootDir, fileName);
  const rel = relative(rootDir, targetPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Caminho de arquivo MIDI invalido.');
  }
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
    throw new Error('Arquivo MIDI de destino nao pode ser symlink.');
  }
  writeFileSync(targetPath, Buffer.from(bytes));

  // Tambem salva latest_score.json para importacao com 1 clique no UsamiImportScore.pyscript dentro do Piano Roll
  const latestJsonPath = resolve(rootDir, 'latest_score.json');
  if (!existsSync(latestJsonPath) || !lstatSync(latestJsonPath).isSymbolicLink()) {
    writeFileSync(latestJsonPath, JSON.stringify(scorePayload, null, 2), 'utf8');
  }

  // Espelha o .mid em Documents/Image-Line/FL Studio/Presets/Scores/Usami (se existir) para aparecer no Browser do FL
  let flScoresPath = null;
  try {
    const flScoresRoot = resolve(homedir(), 'Documents', 'Image-Line', 'FL Studio', 'Presets', 'Scores');
    if (existsSync(flScoresRoot) && !lstatSync(flScoresRoot).isSymbolicLink()) {
      const usamiScoresDir = resolve(flScoresRoot, 'Usami');
      if (!existsSync(usamiScoresDir) || !lstatSync(usamiScoresDir).isSymbolicLink()) {
        mkdirSync(usamiScoresDir, { recursive: true });
        const mirrored = resolve(usamiScoresDir, fileName);
        if (!existsSync(mirrored) || !lstatSync(mirrored).isSymbolicLink()) {
          writeFileSync(mirrored, Buffer.from(bytes));
          flScoresPath = mirrored;
        }
      }
    }
  } catch { /* nao bloqueia geracao principal em data/midi */ }

  return { filePath: targetPath, latestScoreJsonPath: latestJsonPath, flScoresPath };
}

function resolveOpenUtauStatus(baseDataDir, envProvider = name => readEnvValue(name)) {
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const customBin = envProvider('OPENUTAU_BIN');

  const binCandidates = [
    customBin,
    join(localAppData, 'Programs', 'OpenUtau', 'OpenUtau.exe'),
    join(programFiles, 'OpenUtau', 'OpenUtau.exe'),
    join(REPO_ROOT, 'tools', 'openutau', 'OpenUtau.exe'),
  ].filter(Boolean);

  const openUtauBin = binCandidates.find(p => existsSync(p)) || null;

  const effectiveDataDir = baseDataDir || resolveDefaultDataDir();
  const singerCandidates = [
    join(effectiveDataDir, 'openutau', 'Singers', 'Usami_CV'),
    join(home, 'Documents', 'OpenUtau', 'Singers', 'Usami_CV'),
    join(appData, 'OpenUtau', 'Singers', 'Usami_CV'),
    openUtauBin ? join(dirname(openUtauBin), 'Singers', 'Usami_CV') : null,
  ].filter(Boolean);

  const voicebankDir = singerCandidates.find(d => existsSync(join(d, 'oto.ini'))) || null;

  const diffSingerCandidates = [
    openUtauBin ? join(dirname(openUtauBin), 'Singers', 'Evelyn_DS_v110') : null,
    join(home, 'Documents', 'OpenUtau', 'Singers', 'Evelyn_DS_v110'),
    join(appData, 'OpenUtau', 'Singers', 'Evelyn_DS_v110'),
  ].filter(Boolean);
  const diffSingerDir = diffSingerCandidates.find(d => existsSync(join(d, 'dsconfig.yaml'))) || null;

  const rvcDatasetZip = join(effectiveDataDir, 'rvc', 'usami_rvc_dataset_30min.zip');
  const defaultRefWav = join(effectiveDataDir, 'voice-samples', 'singing-sites', 'usami_voice_30s.wav');

  const vocalsDir = resolve(effectiveDataDir, 'vocals');
  let savedProjects = [];
  let guideWavs = [];
  if (existsSync(vocalsDir)) {
    try {
      const allFiles = readdirSync(vocalsDir);
      savedProjects = allFiles.filter(f => f.endsWith('.ustx')).slice(0, 25);
      guideWavs = allFiles
        .filter(f => f.toLowerCase().endsWith('.wav') && !f.toLowerCase().includes('_usami_singing'))
        .slice(0, 25);
    } catch {
      savedProjects = [];
      guideWavs = [];
    }
  }

  return {
    openUtauInstalled: Boolean(openUtauBin),
    openUtauBin,
    voicebankInstalled: Boolean(voicebankDir),
    voicebankDir,
    diffSingerInstalled: Boolean(diffSingerDir),
    diffSingerDir,
    rvcDatasetReady: existsSync(rvcDatasetZip),
    rvcDatasetZip: existsSync(rvcDatasetZip) ? rvcDatasetZip : null,
    colabNotebookPath: existsSync(DEFAULT_RVC_NOTEBOOK_PATH) ? DEFAULT_RVC_NOTEBOOK_PATH : null,
    defaultReferenceWav: existsSync(defaultRefWav) ? defaultRefWav : null,
    vocalsDir,
    savedProjects,
    guideWavs,
  };
}

function writeSafeVocalArtifacts(baseDataDir, baseName, ustxText, ustText, midiBytes, scorePayload) {
  const effectiveBase = baseDataDir || resolveDefaultDataDir();
  const vocalsDir = resolve(effectiveBase, 'vocals');
  if (existsSync(vocalsDir) && lstatSync(vocalsDir).isSymbolicLink()) {
    throw new Error('Diretorio de destino vocal nao pode ser symlink.');
  }
  mkdirSync(vocalsDir, { recursive: true });

  const ustxPath = resolve(vocalsDir, `${baseName}.ustx`);
  const ustPath = resolve(vocalsDir, `${baseName}.ust`);
  for (const candidate of [ustxPath, ustPath]) {
    const rel = relative(vocalsDir, candidate);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Caminho de arquivo vocal invalido.');
    }
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Arquivo vocal de destino nao pode ser symlink.');
    }
  }

  writeFileSync(ustxPath, ustxText, 'utf8');
  writeFileSync(ustPath, ustText, 'utf8');

  const midiArtifacts = writeSafeMidiArtifacts(
    effectiveBase,
    `${baseName}.mid`,
    midiBytes,
    scorePayload,
  );

  return {
    ustxPath,
    ustPath,
    midiPath: midiArtifacts.filePath,
    latestScoreJsonPath: midiArtifacts.latestScoreJsonPath,
  };
}

export function createFlStudioTools({
  flClient = createFlStudioClient(),
  dataDir = null,
  knowledgeStore = null,
  serumLibrary = null,
  onTelemetry = null,
} = {}) {
  const store = knowledgeStore || createFlKnowledgeStore({ dataDir });
  const serumLib = serumLibrary || createSerumPresetLibrary();
  function emitTelemetry(tool, extra = {}) {
    if (typeof onTelemetry !== 'function') return;
    try {
      Promise.resolve(onTelemetry({ tool, ...extra })).catch(() => {});
    } catch {
      // telemetria nunca bloqueia a tool
    }
  }

  function wrapTool(tool) {
    const origExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(args = {}) {
        const started = Date.now();
        try {
          const res = await origExecute(args);
          emitTelemetry(tool.name, {
            ok: true,
            durationMs: Date.now() - started,
            action: args?.action || args?.mode || args?.style || args?.preset || null,
          });
          return res;
        } catch (err) {
          emitTelemetry(tool.name, {
            ok: false,
            isError: true,
            durationMs: Date.now() - started,
            action: args?.action || args?.mode || args?.style || args?.preset || null,
            errorMessage: String(err?.message || err),
          });
          throw err;
        }
      },
    };
  }

  const stateTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.state',
    version: '1.2.0',
    description: 'Le o estado atual do FL Studio: BPM, play/record, pattern, canais do Channel Rack e tracks do Mixer com picos e clipping.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 8000,
    parameters: [
      { name: 'maxChannels', type: 'number', required: false, description: 'Maximo de canais retornados (1 a 64, padrao 24).' },
      { name: 'maxTracks', type: 'number', required: false, description: 'Maximo de tracks do Mixer retornadas (1 a 64, padrao 16).' },
      { name: 'onlyActive', type: 'boolean', required: false, description: 'Se true, omite inserts sem nome/sinal alem do Master.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && isPlainObject(result.transport)
        && Array.isArray(result.channels)
        && Array.isArray(result.mixerTracks);
    },
    async execute(args = {}) {
      const data = await flClient.request('state', {
        maxChannels: Number.isInteger(args.maxChannels) ? args.maxChannels : 24,
        maxTracks: Number.isInteger(args.maxTracks) ? args.maxTracks : 16,
        onlyActive: args.onlyActive === true,
      });
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const listenTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.listen',
    version: '1.2.0',
    description: 'Escuta a saida de audio real do PC via WASAPI Loopback (ou analisa um .wav) medindo LUFS, pico, espectro de 6 bandas, correlacao estereo e fase mono do Sub.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 16000,
    parameters: [
      { name: 'source', type: 'string', required: false, enum: [...LISTEN_SOURCES], description: 'loopback (padrao: escuta o que esta tocando no PC/FL) ou file (.wav).' },
      { name: 'durationSec', type: 'number', required: false, description: 'Segundos de escuta no modo loopback (0.5 a 8.0, padrao 2.5).' },
      { name: 'genre', type: 'string', required: false, enum: [...LISTEN_GENRES], description: 'Referencia de genero para diagnostico espectral (future_bass, kawaii, dubstep, riddim, brostep, colour_bass, melodic_dubstep).' },
      { name: 'filePath', type: 'string', required: false, description: 'Caminho local de arquivo .wav quando source=file.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.silent === 'boolean'
        && Array.isArray(result.warnings);
    },
    async execute(args = {}) {
      const validated = validateListenArgs(args);
      const data = await flClient.listenAudio(validated);
      return { ...data, ok: true, schema: FL_STUDIO_SCHEMA };
    },
  };

  const guideTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.guide',
    version: '1.3.0',
    description: 'Consulta a enciclopedia de producao musical da Usami (sound design no Serum/Vital, Vocodex, Patcher, bateria half-time, harmonia e mixagem) para Future Bass, Kawaii e Dubstep, somada as notas aprendidas.',
    origin: 'skill',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [
      { name: 'genre', type: 'string', required: false, enum: [...KNOWLEDGE_GENRES], description: 'Subgenero: future_bass, kawaii, dubstep, riddim, brostep, colour_bass, melodic_dubstep ou general.' },
      { name: 'topic', type: 'string', required: false, enum: [...KNOWLEDGE_TOPICS], description: 'Topico: sound_design, drums, harmony, mixing, fl_tricks, arrangement ou all.' },
      { name: 'query', type: 'string', required: false, description: 'Termo especifico (ex.: vocodex, square4, supersaw, growl, royal road).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && Array.isArray(result.playbooks);
    },
    async execute(args = {}) {
      const validated = validateGuideArgs(args);
      const customNotes = store.list({ genre: validated.genre || null, topic: validated.topic || null, limit: 50 });
      const data = queryGenreKnowledge({
        genre: validated.genre || null,
        topic: validated.topic,
        query: validated.query || '',
        customNotes,
      });
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const learnTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.learn',
    version: '1.3.0',
    description: 'Salva, lista ou remove aprendizados de producao musical (receitas de patches, preferencias do seu template no FL Studio ou tecnicas estudadas) na memoria de estudio da Usami.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 5000,
    parameters: [
      { name: 'action', type: 'string', required: false, enum: [...LEARN_ACTIONS], description: 'save (padrao), list ou delete.' },
      { name: 'genre', type: 'string', required: false, enum: [...KNOWLEDGE_GENRES], description: 'Subgenero associado a nota.' },
      { name: 'topic', type: 'string', required: false, enum: [...KNOWLEDGE_TOPICS], description: 'Topico tecnico (sound_design, mixing, fl_tricks, drums, harmony, arrangement).' },
      { name: 'title', type: 'string', required: false, description: 'Titulo curto do aprendizado (obrigatorio em save).' },
      { name: 'content', type: 'string', required: false, description: 'Receita, parametros ou preferencia detalhada (obrigatorio em save).' },
      { name: 'source', type: 'string', required: false, description: 'Origem opcional (user, tutorial, research).' },
      { name: 'noteId', type: 'string', required: false, description: 'ID fln-... quando action=delete.' },
      { name: 'query', type: 'string', required: false, description: 'Filtro textual quando action=list.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.action === 'string';
    },
    async execute(args = {}) {
      const validated = validateLearnArgs(args);
      if (validated.action === 'save') {
        const note = store.save(validated);
        return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'save', note };
      }
      if (validated.action === 'delete') {
        const res = store.remove(validated.noteId);
        return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'delete', ...res };
      }
      const notes = store.list({
        genre: validated.genre || null,
        topic: validated.topic || null,
        query: validated.query || '',
        limit: 25,
      });
      return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'list', count: notes.length, notes };
    },
  };

  const serumTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.serum',
    version: '1.6.0',
    description: 'Busca, separa ou CRIA novos presets reais .SerumPreset do Serum 2 (CBOR + Zstd + MD5) direto na pasta Presets/User/Usami/ (estilos: supersaw, growl, riddim_square4, colour_bass, kawaii_pluck, reese).',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 15000,
    parameters: [
      { name: 'action', type: 'string', required: false, enum: [...SERUM_ACTIONS], description: 'create (gera novo .SerumPreset em User/Usami), search (padrao), categories ou stage.' },
      { name: 'style', type: 'string', required: false, enum: [...SERUM_STYLES], description: 'Arquetipo para action=create: supersaw, growl, riddim_square4, colour_bass, kawaii_pluck ou reese.' },
      { name: 'presetName', type: 'string', required: false, description: 'Nome do novo preset quando action=create (ex.: Usami - Kawaii Supersaw).' },
      { name: 'unison', type: 'number', required: false, description: 'Vozes de unison (1 a 16) quando action=create.' },
      { name: 'detune', type: 'number', required: false, description: 'Detune normalizado (0.0 a 1.0) quando action=create.' },
      { name: 'octave', type: 'number', required: false, description: 'Oitava (-4 a 4) quando action=create.' },
      { name: 'filterFreq', type: 'number', required: false, description: 'Cutoff do filtro (0.0 a 1.0) quando action=create.' },
      { name: 'filterReso', type: 'number', required: false, description: 'Ressonancia do filtro (0.0 a 1.0) quando action=create.' },
      { name: 'filterDrive', type: 'number', required: false, description: 'Drive do filtro (0.0 a 1.0) quando action=create.' },
      { name: 'subEnable', type: 'boolean', required: false, description: 'Liga/desliga Sub Oscilador em action=create.' },
      { name: 'mono', type: 'boolean', required: false, description: 'Modo Mono/Legato em action=create.' },
      { name: 'query', type: 'string', required: false, description: 'Termo de busca (ex.: growl, spectral, acid, supersaw, pluck, arp).' },
      { name: 'category', type: 'string', required: false, description: 'Pasta/categoria (ex.: Bass, Leads, Pads, Plucks, Arp, Chords).' },
      { name: 'tag', type: 'string', required: false, description: 'Tag tecnica do Serum 2 (ex.: Spectral, Granular, Wavetable, Poly, Mono).' },
      { name: 'presetNames', type: 'array', required: false, description: 'Lista de nomes de presets para copiar quando action=stage.' },
      { name: 'bankName', type: 'string', required: false, description: 'Subpasta dentro de Presets/User (padrao Usami).' },
      { name: 'limit', type: 'number', required: false, description: 'Maximo de resultados em search (1 a 30, padrao 12).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.action === 'string';
    },
    async execute(args = {}) {
      const validated = validateSerumArgs(args);
      if (validated.action === 'create') {
        const created = await flClient.createSerumPreset({
          presetName: validated.presetName,
          style: validated.style,
          bankName: validated.bankName || 'Usami',
          overrides: validated.overrides || {},
        });
        return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'create', ...created };
      }
      if (validated.action === 'categories') {
        const sum = serumLib.summary();
        return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'categories', ...sum };
      }
      if (validated.action === 'stage') {
        const staged = serumLib.stageToUsamiBank({
          presetNames: validated.presetNames || [],
          query: validated.query || '',
          category: validated.category || null,
          bankName: validated.bankName || 'Usami',
          maxStage: validated.limit || 8,
        });
        return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'stage', ...staged };
      }
      const found = serumLib.search({
        query: validated.query || '',
        category: validated.category || null,
        tag: validated.tag || null,
        limit: validated.limit || 12,
      });
      return { ok: true, schema: FL_STUDIO_SCHEMA, action: 'search', ...found };
    },
  };

  const uiTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.ui',
    version: '1.4.0',
    description: 'Automacao segura de UI/Teclado/Mouse no FL Studio com trava de janela (FL64.exe) e kill-switch (ESC ou movimento manual do mouse abortam na hora): carrega plugins via F8 (Serum 2, Harmor, Sytrus, Sakura, Ogun), tira print e opera cliques/knobs.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 14000,
    parameters: [
      { name: 'action', type: 'string', required: false, enum: [...UI_ACTIONS], description: 'inspect_windows, capture_window, add_plugin, shortcut, mouse_click, knob_drag ou mouse_drag.' },
      { name: 'pluginName', type: 'string', required: false, description: 'Nome do plugin para add_plugin (ex.: Serum 2, Harmor, Sytrus, Sakura, Ogun, Kepler Exo, 3x Osc).' },
      { name: 'shortcut', type: 'string', required: false, enum: [...UI_SHORTCUTS], description: 'Atalho seguro para action=shortcut (ex.: assign_free_mixer_track, toggle_piano_roll).' },
      { name: 'windowTitle', type: 'string', required: false, description: 'Trecho opcional do titulo da janela do FL/plugin.' },
      { name: 'relX', type: 'number', required: false, description: 'Coordenada X relativa a janela do FL Studio.' },
      { name: 'relY', type: 'number', required: false, description: 'Coordenada Y relativa a janela do FL Studio.' },
      { name: 'deltaPx', type: 'number', required: false, description: 'Deslocamento vertical em pixels para knob_drag (-250 a 250; negativo aumenta).' },
      { name: 'fromRelX', type: 'number', required: false, description: 'X inicial relativo para mouse_drag.' },
      { name: 'fromRelY', type: 'number', required: false, description: 'Y inicial relativo para mouse_drag.' },
      { name: 'toRelX', type: 'number', required: false, description: 'X final relativo para mouse_drag.' },
      { name: 'toRelY', type: 'number', required: false, description: 'Y final relativo para mouse_drag.' },
      { name: 'button', type: 'string', required: false, enum: ['left', 'right'], description: 'Botao do mouse para mouse_click (padrao left).' },
      { name: 'double', type: 'boolean', required: false, description: 'Clique duplo se true em mouse_click.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.action === 'string';
    },
    async execute(args = {}) {
      const validated = validateUiArgs(args);
      if (validated.action === 'capture_window') {
        const base = typeof dataDir === 'function' ? dataDir() : (dataDir || resolveDefaultDataDir());
        const shotDir = resolve(base, 'screenshots');
        if (existsSync(shotDir) && lstatSync(shotDir).isSymbolicLink()) {
          throw new Error('Diretorio screenshots nao pode ser symlink.');
        }
        mkdirSync(shotDir, { recursive: true });
        validated.outPath = join(shotDir, `fl-capture-${Date.now()}.png`);
      }
      const data = await flClient.runUiAction(validated);
      return { ...data, ok: true, schema: FL_STUDIO_SCHEMA };
    },
  };

  const vocalTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.vocal',
    version: '1.6.0',
    description: 'Pipeline completo de canto da Usami (Vocaloid Usami_CV + Estilo Neuro-sama via DiffSinger neural + conversao de timbre Seed-VC com F0 / RVC v2) sincronizado ao FL Studio.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 120000,
    parameters: [
      { name: 'action', type: 'string', required: false, enum: [...VOCAL_ACTIONS], description: 'compose (gera .ustx + .ust + .mid), convert (converte guia .wav na voz cantada da Usami via Seed-VC GPU), status ou open.' },
      { name: 'engine', type: 'string', required: false, enum: [...VOCAL_ENGINES], description: 'classic (Usami_CV estilo Vocaloid) ou diffsinger (Evelyn DS neural humana para pipeline estilo Neuro-sama).' },
      { name: 'lyrics', type: 'string', required: false, description: 'Letra para cantar em Portugues, Japones (Romaji/Hiragana) ou Ingles.' },
      { name: 'language', type: 'string', required: false, enum: [...VOCAL_LANGUAGES], description: 'auto (padrao), pt, ja ou en.' },
      { name: 'style', type: 'string', required: false, enum: [...VOCAL_STYLES], description: 'Estilo vocal: kawaii_hook, future_bass_anthem, melodic_dubstep_soar, colour_bass_chop ou dubstep_pre_drop.' },
      { name: 'key', type: 'string', required: false, description: 'Tonalidade da musica (ex.: F, C, D#m, Fm; padrao F).' },
      { name: 'bpm', type: 'number', required: false, description: 'Andamento em BPM (40 a 300).' },
      { name: 'progression', type: 'string', required: false, enum: Object.keys(GENRE_PROGRESSIONS), description: 'Progressao harmonica base opcional.' },
      { name: 'chords', type: 'array', required: false, description: 'Acordes customizados opcionais.' },
      { name: 'notes', type: 'array', required: false, description: 'Notas customizadas opcionais [{note, lyric, durationBeats}].' },
      { name: 'singerName', type: 'string', required: false, description: 'Nome do singer no OpenUTAU (Usami para classic; Evelyn DS v110 para diffsinger).' },
      { name: 'fileName', type: 'string', required: false, description: 'Nome base opcional para salvar em data/vocals/.' },
      { name: 'openInUtau', type: 'boolean', required: false, description: 'Se true, abre o projeto .ustx imediatamente no OpenUTAU.' },
      { name: 'sourceWav', type: 'string', required: false, description: 'Caminho do .wav guia cantado para action=convert (se omitido, pega o .wav guia mais recente em data/vocals/).' },
      { name: 'referenceWav', type: 'string', required: false, description: 'Amostra de referencia da Usami para action=convert (padrao usami_voice_30s.wav).' },
      { name: 'pitchShift', type: 'number', required: false, description: 'Transposicao em semitons (-24 a 24) para action=convert (padrao 0).' },
      { name: 'diffusionSteps', type: 'number', required: false, description: 'Passos de difusao no Seed-VC (10 a 80, padrao 30).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.action === 'string';
    },
    async execute(args = {}) {
      const validated = validateVocalArgs(args);
      const effectiveDataDir = typeof dataDir === 'function' ? dataDir() : dataDir;
      const status = resolveOpenUtauStatus(effectiveDataDir);

      if (validated.action === 'status') {
        return {
          ok: true,
          schema: FL_STUDIO_SCHEMA,
          action: 'status',
          ...status,
        };
      }

      if (validated.action === 'convert') {
        let srcPath = validated.sourceWav;
        if (!srcPath) {
          if (status.guideWavs.length > 0) {
            srcPath = resolve(status.vocalsDir, status.guideWavs[status.guideWavs.length - 1]);
          } else {
            throw new Error('Informe sourceWav ou exporte primeiro um arquivo .wav guia do OpenUTAU em data/vocals/.');
          }
        }
        const refPath = validated.referenceWav || status.defaultReferenceWav;
        if (!refPath) {
          throw new Error('Amostra de referencia usami_voice_30s.wav nao encontrada. Rode scripts/export-voice-samples.py.');
        }
        mkdirSync(status.vocalsDir, { recursive: true });
        if (lstatSync(status.vocalsDir).isSymbolicLink()) {
          throw new Error('Diretorio vocals nao pode ser symlink.');
        }
        const outWav = resolve(status.vocalsDir, `${validated.fileName}_usami_singing.wav`);
        const relOut = relative(status.vocalsDir, outWav);
        if (!relOut || relOut.startsWith('..') || isAbsolute(relOut)) {
          throw new Error('Caminho de saida vocal invalido.');
        }
        const conv = await flClient.convertSingingAudio({
          sourceWav: srcPath,
          referenceWav: refPath,
          outputWav: outWav,
          diffusionSteps: validated.diffusionSteps,
          pitchShift: validated.pitchShift,
        });
        return {
          ok: true,
          schema: FL_STUDIO_SCHEMA,
          action: 'convert',
          ...conv,
        };
      }

      if (validated.action === 'open') {
        if (!status.openUtauBin) {
          throw new Error('OpenUtau.exe nao encontrado localmente.');
        }
        const targetUstx = resolve(status.vocalsDir, `${validated.fileName}.ustx`);
        const fallbackLatest = status.savedProjects.length > 0
          ? resolve(status.vocalsDir, status.savedProjects[status.savedProjects.length - 1])
          : null;
        const chosen = existsSync(targetUstx) ? targetUstx : fallbackLatest;
        const spawnArgs = chosen ? [chosen] : [];
        const child = spawn(status.openUtauBin, spawnArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        return {
          ok: true,
          schema: FL_STUDIO_SCHEMA,
          action: 'open',
          launched: true,
          openUtauBin: status.openUtauBin,
          ustxPath: chosen,
        };
      }

      const score = buildVocalMelodyScore(validated);
      const parsedKey = parseKeySignature(score.key);
      const ustxText = buildUstxYaml({
        projectName: validated.fileName,
        singerName: validated.singerName,
        engine: validated.engine,
        bpm: score.bpm,
        keySemitone: parsedKey.rootSemitone,
        barsTotal: score.barsTotal,
        notes: score.notes,
      });
      const ustxCheck = inspectUstxText(ustxText);
      if (!ustxCheck.valid) {
        throw new Error(`Projeto USTX invalido gerado internamente: ${ustxCheck.reason}`);
      }
      const ustText = buildUstText({
        projectName: validated.fileName,
        bpm: score.bpm,
        notes: score.notes,
      });
      const midiBytes = buildMidiFileBytes({
        bpm: score.bpm,
        trackName: `${validated.singerName} Vocal`,
        notes: score.notes,
      });
      const midiCheck = inspectMidiFileBytes(midiBytes);
      if (!midiCheck.valid) {
        throw new Error(`MIDI vocal invalido gerado internamente: ${midiCheck.reason}`);
      }

      const paths = writeSafeVocalArtifacts(
        effectiveDataDir,
        validated.fileName,
        ustxText,
        ustText,
        midiBytes,
        {
          tpq: DEFAULT_TPQ,
          bpm: score.bpm,
          style: score.style,
          key: score.key,
          chordsUsed: score.chordsUsed,
          lyrics: score.lyricsOriginal,
          syllables: score.syllables,
          notes: score.notes,
        },
      );

      let launchedInUtau = false;
      if (validated.openInUtau && status.openUtauBin) {
        try {
          const child = spawn(status.openUtauBin, [paths.ustxPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          child.unref();
          launchedInUtau = true;
        } catch {
          launchedInUtau = false;
        }
      }

      return {
        ok: true,
        schema: FL_STUDIO_SCHEMA,
        action: 'compose',
        engine: validated.engine,
        fileName: `${validated.fileName}.ustx`,
        ustxPath: paths.ustxPath,
        ustPath: paths.ustPath,
        midiPath: paths.midiPath,
        latestScoreJsonPath: paths.latestScoreJsonPath,
        style: score.style,
        language: score.language,
        bpm: score.bpm,
        key: score.key,
        chordsUsed: score.chordsUsed,
        lyrics: score.lyricsOriginal,
        syllables: score.syllables,
        noteCount: score.notes.length,
        barsTotal: score.barsTotal,
        singerName: validated.singerName,
        openUtauInstalled: status.openUtauInstalled,
        voicebankInstalled: status.voicebankInstalled,
        launchedInUtau,
      };
    },
  };

  const transportTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.transport',
    version: '1.2.0',
    description: 'Controla o transport do FL Studio: play, pause, stop, record, pattern/song mode, metronomo, BPM e marcadores.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'action', type: 'string', required: true, enum: [...TRANSPORT_ACTIONS], description: 'Acao de transport.' },
      { name: 'bpm', type: 'number', required: false, description: 'Novo andamento entre 20 e 522 quando action=set_bpm.' },
      { name: 'delta', type: 'number', required: false, description: 'Deslocamento de marcador para jump_marker (ex.: 1 ou -1).' },
      { name: 'select', type: 'boolean', required: false, description: 'Se true, seleciona ate o marcador no jump_marker.' },
      { name: 'markerName', type: 'string', required: false, description: 'Nome do marcador quando action=add_marker.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.action === 'string';
    },
    async execute(args = {}) {
      const cmdArgs = validateTransportArgs(args);
      const data = await flClient.request('transport', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const mixerTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.mixer',
    version: '1.2.0',
    description: 'Ajusta track do Mixer no FL Studio por indice ou nome: volume (0..125% ou 0..1), pan, mute, solo, renomear e selecionar.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'track', type: 'number', required: false, description: 'Indice da track no Mixer (0 = Master, 1..125).' },
      { name: 'trackName', type: 'string', required: false, description: 'Nome da track no Mixer (ex.: Kick, Sub, Supersaw, Master).' },
      { name: 'volumePercent', type: 'number', required: false, description: 'Volume em % (0 a 125; 100 equivale a 0 dB / 0.8 no FL).' },
      { name: 'volume', type: 'number', required: false, description: 'Volume normalizado direto (0.0 a 1.0).' },
      { name: 'pan', type: 'number', required: false, description: 'Pan entre -1.0 (esquerda) e 1.0 (direita).' },
      { name: 'mute', type: 'boolean', required: false, description: 'Ativa ou desativa mute na track.' },
      { name: 'solo', type: 'boolean', required: false, description: 'Ativa ou desativa solo na track.' },
      { name: 'name', type: 'string', required: false, description: 'Novo nome para a track do Mixer.' },
      { name: 'select', type: 'boolean', required: false, description: 'Se true, seleciona a track no Mixer.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && Number.isInteger(result.index);
    },
    async execute(args = {}) {
      const cmdArgs = validateMixerArgs(args);
      const data = await flClient.request('mixer', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const routingTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.routing',
    version: '1.2.0',
    description: 'Configura Sidechain ghost (level 0), Submix Bus (bus_only sem Master), Send paralelo, desconexao, inspecao de rotas ou atribuicao Channel Rack -> Mixer (mode="channel_to_mixer").',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'mode', type: 'string', required: false, enum: [...ROUTING_MODES], description: 'sidechain (padrao), bus_only, send, disconnect, inspect ou channel_to_mixer.' },
      { name: 'sourceTrack', type: 'number', required: false, description: 'Indice da track de origem (ex.: Kick).' },
      { name: 'sourceTrackName', type: 'string', required: false, description: 'Nome da track de origem (ex.: Kick, Snare).' },
      { name: 'destTrack', type: 'number', required: false, description: 'Indice da track de destino (ex.: Supersaw, Bass Bus).' },
      { name: 'destTrackName', type: 'string', required: false, description: 'Nome da track de destino.' },
      { name: 'destTracks', type: 'array', required: false, description: 'Lista de indices de destino para aplicar de uma vez.' },
      { name: 'destTrackNames', type: 'array', required: false, description: 'Lista de nomes de destino (ex.: ["Supersaw","Sub","Arp"]).' },
      { name: 'assignments', type: 'array', required: false, description: 'Para mode="channel_to_mixer": lista de { channel ou channelName, track ou trackName } (ate 16 por chamada).' },
      { name: 'channel', type: 'number', required: false, description: 'Indice do canal no Channel Rack para mode="channel_to_mixer".' },
      { name: 'channelName', type: 'string', required: false, description: 'Nome do canal no Channel Rack para mode="channel_to_mixer".' },
      { name: 'levelPercent', type: 'number', required: false, description: 'Nivel de envio em % para send/bus_only (0 a 125; 100 = 0 dB).' },
      { name: 'level', type: 'number', required: false, description: 'Nivel de envio normalizado (0.0 a 1.0).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && (Number.isInteger(result.sourceTrack) || (result.mode === 'channel_to_mixer' && Array.isArray(result.applied)));
    },
    async execute(args = {}) {
      const cmdArgs = validateRoutingArgs(args);
      const data = await flClient.request('routing', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const eqTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.eq',
    version: '1.2.0',
    description: 'Ajusta o EQ nativo de 3 bandas e a abertura estereo / Mono de uma track do Mixer (inclui presets sub_mono_clean, supersaw_air, mud_cut e flat).',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'track', type: 'number', required: false, description: 'Indice da track do Mixer (0..125).' },
      { name: 'trackName', type: 'string', required: false, description: 'Nome da track do Mixer (ex.: Sub, Supersaw, Growl).' },
      { name: 'preset', type: 'string', required: false, enum: [...EQ_PRESETS], description: 'Preset rapido: sub_mono_clean, supersaw_air, mud_cut ou flat.' },
      { name: 'lowGainDb', type: 'number', required: false, description: 'Ganho de graves em dB (-18 a +18).' },
      { name: 'midGainDb', type: 'number', required: false, description: 'Ganho de medios em dB (-18 a +18).' },
      { name: 'highGainDb', type: 'number', required: false, description: 'Ganho de agudos em dB (-18 a +18).' },
      { name: 'mono', type: 'boolean', required: false, description: 'Se true, forca 100% Mono (Merged) na track.' },
      { name: 'stereoWidth', type: 'number', required: false, description: 'Largura estereo de -100 (100% Mono) a +100 (100% Aberto).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && Number.isInteger(result.track);
    },
    async execute(args = {}) {
      const cmdArgs = validateEqArgs(args);
      const data = await flClient.request('eq', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const stepsTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.steps',
    version: '1.2.0',
    description: 'Le ou escreve steps no Step Sequencer usando indices ou presets de Future Bass, Kawaii, Dubstep, Riddim, Brostep e Colour Bass.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'channel', type: 'number', required: false, description: 'Indice do canal no Channel Rack (0..127).' },
      { name: 'channelName', type: 'string', required: false, description: 'Nome do canal no Channel Rack (ex.: Kick, Snare, Clap, Hat).' },
      { name: 'pattern', type: 'number', required: false, description: 'Numero do pattern opcional (1..999).' },
      { name: 'mode', type: 'string', required: false, enum: [...STEPS_MODES], description: 'replace (padrao), add, clear ou read.' },
      { name: 'steps', type: 'array', required: false, description: 'Indices dos steps (0..63; em half-time a caixa principal fica no 8).' },
      { name: 'preset', type: 'string', required: false, enum: Object.keys(STEP_PRESETS), description: 'Preset de groove (halftime_snare, riddim_kick, brostep_kick, future_bass_kick, kawaii_bounce_kick, colour_bass_kick, etc.).' },
      { name: 'length', type: 'number', required: false, description: 'Comprimento em steps (1 a 64, padrao 16; em 32 duplica 2 compassos).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && Array.isArray(result.activeSteps);
    },
    async execute(args = {}) {
      const cmdArgs = validateStepsArgs(args);
      const data = await flClient.request('steps', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const pluginTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.plugin',
    version: '1.2.0',
    description: 'Lista parametros, ajusta knobs/macros (ex.: Serum, Vital, Phase Plant, OTT), troca presets ou abre janela de plugin.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: [...PLUGIN_TARGETS], description: 'channel (padrao) ou mixer.' },
      { name: 'channel', type: 'number', required: false, description: 'Indice do canal (quando target=channel).' },
      { name: 'channelName', type: 'string', required: false, description: 'Nome do canal (quando target=channel).' },
      { name: 'track', type: 'number', required: false, description: 'Indice da track do Mixer (quando target=mixer).' },
      { name: 'trackName', type: 'string', required: false, description: 'Nome da track do Mixer (quando target=mixer).' },
      { name: 'slot', type: 'number', required: false, description: 'Slot FX no Mixer de 0 a 9 (padrao 0).' },
      { name: 'action', type: 'string', required: false, enum: [...PLUGIN_ACTIONS], description: 'list_params (padrao), set_param, next_preset, prev_preset ou focus.' },
      { name: 'paramIndex', type: 'number', required: false, description: 'Indice numerico do parametro para set_param.' },
      { name: 'paramName', type: 'string', required: false, description: 'Nome ou trecho do parametro para set_param (ex.: Cutoff, Macro 1, LFO Rate).' },
      { name: 'value', type: 'number', required: false, description: 'Valor normalizado entre 0.0 e 1.0 para set_param.' },
      { name: 'filter', type: 'string', required: false, description: 'Filtro textual opcional para list_params.' },
      { name: 'limit', type: 'number', required: false, description: 'Limite de parametros retornados (1 a 40).' },
      { name: 'offset', type: 'number', required: false, description: 'Offset de paginacao para list_params.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.pluginName === 'string';
    },
    async execute(args = {}) {
      const cmdArgs = validatePluginArgs(args);
      const data = await flClient.request('plugin', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  const midiTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.midi',
    version: '1.2.0',
    description: 'Toca notas, acordes estendidos (maj9, m11, 69) ou progressoes prontas ao vivo no FL Studio com voicings supersaw/colour_bass.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 20000,
    parameters: [
      { name: 'notes', type: 'array', required: false, description: 'Lista de notas (ex.: ["C4","E4","G4"]) ou grupos.' },
      { name: 'chords', type: 'array', required: false, description: 'Progressao de acordes (ex.: ["Fmaj9","G7","Em7","Am11"]).' },
      { name: 'progression', type: 'string', required: false, enum: Object.keys(GENRE_PROGRESSIONS), description: 'Progressao de genero pronta (kawaii_royal_road, colour_bass_prism, melodic_dubstep_epic, etc.).' },
      { name: 'key', type: 'string', required: false, description: 'Tonalidade da progressao (ex.: F, C, D#m, Fm).' },
      { name: 'voicing', type: 'string', required: false, enum: [...VOICING_MODES], description: 'close (padrao), spread, supersaw ou colour_bass.' },
      { name: 'includeSub', type: 'boolean', required: false, description: 'Se true, dobra fundamental grave para peso de sub.' },
      { name: 'arpeggio', type: 'boolean', required: false, description: 'Se true, toca cada acorde como arpejo.' },
      { name: 'octave', type: 'number', required: false, description: 'Oitava base (0 a 8, padrao 4).' },
      { name: 'velocity', type: 'number', required: false, description: 'Velocidade MIDI de 1 a 127 (padrao 100).' },
      { name: 'durationMs', type: 'number', required: false, description: 'Duracao por evento em ms (40 a 4000, padrao 400).' },
      { name: 'midiChannel', type: 'number', required: false, description: 'Canal MIDI de 0 a 15 (padrao 0).' },
      { name: 'targetChannel', type: 'number', required: false, description: 'Indice opcional do canal do FL Studio para selecionar antes.' },
      { name: 'targetChannelName', type: 'string', required: false, description: 'Nome opcional do canal do FL Studio para selecionar antes.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && Number.isInteger(result.notesSent)
        && result.notesSent > 0;
    },
    async execute(args = {}) {
      const validated = validateMidiArgs(args);
      const res = await flClient.playMidi(validated);
      return {
        ok: true,
        schema: FL_STUDIO_SCHEMA,
        port: res.port || null,
        channel: validated.channel,
        notesSent: res.notesSent,
        eventsPlayed: res.eventsPlayed,
      };
    },
  };

  const midiFileTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.midi_file',
    version: '1.2.0',
    description: 'Gera arquivo .mid polifonico no disco (data/midi e Browser > Scores > Usami) e atualiza latest_score.json para o UsamiImportScore.pyscript. Nao insere notas direto no Piano Roll sem importacao manual (Ctrl+M, arrastar ou UsamiImportScore) — nunca diga que ja esta no Piano Roll.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'style', type: 'string', required: false, enum: [...MIDI_STYLES], description: 'Estilo ritmico: future_bass_pump, kawaii_arp, sustained (Colour Bass), melodic_dubstep_stack, riddim_bass ou brostep_riff.' },
      { name: 'progression', type: 'string', required: false, enum: Object.keys(GENRE_PROGRESSIONS), description: 'Progressao pronta (kawaii_royal_road, kawaii_sparkle, future_bass_anthem, melodic_dubstep_epic, colour_bass_prism, riddim_dark, brostep_drop).' },
      { name: 'key', type: 'string', required: false, description: 'Tonalidade (ex.: F, C, Eb, Am, Fm, D#m; padrao C).' },
      { name: 'chords', type: 'array', required: false, description: 'Lista customizada de acordes sobrepondo progression.' },
      { name: 'notes', type: 'array', required: false, description: 'Lista opcional de notas customizadas.' },
      { name: 'voicing', type: 'string', required: false, enum: [...VOICING_MODES], description: 'Voicing harmonico: supersaw, colour_bass, spread ou close.' },
      { name: 'bpm', type: 'number', required: false, description: 'Andamento gravado no arquivo .mid (20 a 522).' },
      { name: 'barsPerChord', type: 'number', required: false, description: 'Compassos por acorde (1 a 8, padrao 1).' },
      { name: 'octave', type: 'number', required: false, description: 'Oitava base (0 a 7).' },
      { name: 'velocity', type: 'number', required: false, description: 'Velocidade MIDI (1 a 127, padrao 105).' },
      { name: 'includeSub', type: 'boolean', required: false, description: 'Se true, garante fundamental de sub grave.' },
      { name: 'fileName', type: 'string', required: false, description: 'Nome opcional do arquivo .mid.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.filePath === 'string'
        && result.noteCount > 0
        && result.bytesWritten > 22;
    },
    async execute(args = {}) {
      const score = buildMidiScoreEvents(args);
      const midiBytes = buildMidiFileBytes({
        bpm: score.bpm,
        trackName: score.fileName.replace(/\.mid$/i, ''),
        notes: score.notes,
      });
      const check = inspectMidiFileBytes(midiBytes);
      if (!check.valid) {
        throw new Error(`Arquivo MIDI invalido gerado internamente: ${check.reason}`);
      }
      const effectiveDataDir = typeof dataDir === 'function' ? dataDir() : dataDir;
      const { filePath, latestScoreJsonPath, flScoresPath } = writeSafeMidiArtifacts(
        effectiveDataDir,
        score.fileName,
        midiBytes,
        {
          tpq: DEFAULT_TPQ,
          bpm: score.bpm,
          style: score.style,
          key: score.key,
          voicing: score.voicing,
          chordsUsed: score.chordsUsed,
          notes: score.notes,
        },
      );
      return {
        ok: true,
        schema: FL_STUDIO_SCHEMA,
        inPianoRoll: false,
        howToLoadInFl: 'Arraste de Browser > Scores > Usami para o canal, pressione Ctrl+M no Piano Roll selecionando filePath, ou rode Tools > Scripting > UsamiImportScore.',
        fileName: score.fileName,
        filePath,
        flScoresPath,
        latestScoreJsonPath,
        style: score.style,
        bpm: score.bpm,
        key: score.key,
        voicing: score.voicing,
        chordsUsed: score.chordsUsed,
        barsTotal: score.barsTotal,
        noteCount: score.notes.length,
        bytesWritten: midiBytes.length,
      };
    },
  };

  const undoTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'fl.undo',
    version: '1.2.0',
    description: 'Desfaz (undo) ou refaz (redo) a ultima acao registrada no historico do FL Studio.',
    origin: 'skill',
    permissionLevel: 2,
    timeoutMs: 8000,
    parameters: [
      { name: 'direction', type: 'string', required: false, enum: [...UNDO_DIRECTIONS], description: 'undo (padrao) ou redo.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === FL_STUDIO_SCHEMA
        && typeof result.direction === 'string';
    },
    async execute(args = {}) {
      const cmdArgs = validateUndoArgs(args);
      const data = await flClient.request('undo', cmdArgs);
      return { ok: true, schema: FL_STUDIO_SCHEMA, ...data };
    },
  };

  return [
    stateTool,
    listenTool,
    guideTool,
    learnTool,
    serumTool,
    uiTool,
    vocalTool,
    transportTool,
    mixerTool,
    routingTool,
    eqTool,
    stepsTool,
    pluginTool,
    midiTool,
    midiFileTool,
    undoTool,
  ].map(wrapTool);
}
