// STT local via faster-whisper (python): módulo puro, sem HTTP e sem deps novas.
// Cada transcrição roda um processo python curto (spawn com timeout); o nome do
// modelo é fixo por processo (WHISPER_MODEL || 'base') e a resolução é cacheada
// aqui — a instância WhisperModel vive dentro do processo python de cada chamada,
// e o faster-whisper mantém os pesos em disco (cache HF), então cargas quentes
// são rápidas mesmo entre processos.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sttTmpDir } from './data-paths.js';

let cachedModelName = null;
let activeWorker = null;
let workerQueue = Promise.resolve();
let workerSeq = 0;

function buildWorkerScript() {
  return [
    'import json, os, sys',
    'import av',
    '_orig_av_open = av.open',
    'def _av_open_compat(*args, **kwargs):',
    '    try:',
    '        return _orig_av_open(*args, **kwargs)',
    '    except TypeError:',
    '        kwargs.pop("metadata_errors", None)',
    '        return _orig_av_open(*args, **kwargs)',
    'av.open = _av_open_compat',
    'from faster_whisper import WhisperModel',
    'threads = min(8, os.cpu_count() or 4)',
    'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=threads)',
    'sys.stdout.write(json.dumps({"ready": True}) + "\\n")',
    'sys.stdout.flush()',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line:',
    '        continue',
    '    req_id = None',
    '    try:',
    '        req = json.loads(line)',
    '        req_id = req.get("id")',
    '        segments, _ = model.transcribe(req["audioPath"], language=req.get("language", "pt"), beam_size=int(req.get("beamSize", 1)), vad_filter=True, condition_on_previous_text=False, initial_prompt="Usami, skills, módulos, ferramentas, GitHub, API, desktop, Rust, Node.js.")',
    '        text = " ".join(segment.text for segment in segments).strip()',
    '        sys.stdout.write(json.dumps({"id": req_id, "ok": True, "text": text}) + "\\n")',
    '    except Exception as exc:',
    '        sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)[:300]}) + "\\n")',
    '    sys.stdout.flush()',
  ].join('\n');
}

function stopActiveWorker() {
  if (!activeWorker) return;
  try {
    activeWorker.child.kill();
  } catch {
    // noop
  }
  activeWorker = null;
}

// O worker é persistente de propósito (modelo quente), mas não pode segurar o
// event loop quando não há transcrição em curso: sem isso, qualquer processo
// que use o STT e não tenha outro handle (teste/CLI) nunca encerra. Durante a
// requisição os pipes voltam a segurar o processo.
function setWorkerRef(worker, referenced) {
  if (!worker || worker.closed) return;
  const targets = [worker.child, worker.child.stdin, worker.child.stdout, worker.child.stderr];
  for (const target of targets) {
    try {
      if (referenced) target?.ref?.();
      else target?.unref?.();
    } catch {
      // stream já encerrado: nada a fazer
    }
  }
}

function getOrStartWorker(modelName) {
  if (activeWorker && activeWorker.modelName === modelName && !activeWorker.closed) {
    return activeWorker;
  }
  stopActiveWorker();

  const child = spawn('python', ['-u', '-c', buildWorkerScript(), modelName], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const worker = {
    modelName,
    child,
    closed: false,
    stderr: '',
    pending: new Map(),
    readyResolved: false,
    readyPromise: null,
    _resolveReady: null,
    _rejectReady: null,
  };

  worker.readyPromise = new Promise((resolve, reject) => {
    worker._resolveReady = resolve;
    worker._rejectReady = reject;
  });

  let stdoutBuf = '';
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const rawLine = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!rawLine) continue;
      let msg;
      try {
        msg = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (msg.ready && !worker.readyResolved) {
        worker.readyResolved = true;
        worker._resolveReady();
        continue;
      }
      if (msg.id && worker.pending.has(msg.id)) {
        const entry = worker.pending.get(msg.id);
        worker.pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  });

  child.stderr.on('data', chunk => {
    worker.stderr = (worker.stderr + chunk.toString('utf8')).slice(-1000);
  });

  const failAll = reason => {
    if (worker.closed) return;
    worker.closed = true;
    if (activeWorker === worker) activeWorker = null;
    if (!worker.readyResolved) {
      worker.readyResolved = true;
      worker._rejectReady(new Error(reason));
    }
    for (const entry of worker.pending.values()) {
      entry.reject(new Error(reason));
    }
    worker.pending.clear();
  };

  child.on('error', () => failAll('Não foi possível executar o python (faster-whisper).'));
  child.on('close', code => {
    const lastLine = worker.stderr.trim().split('\n').pop() || `código ${code ?? 'desconhecido'}`;
    failAll('faster-whisper falhou: ' + lastLine.slice(0, 300));
  });

  activeWorker = worker;
  return worker;
}

process.once('exit', stopActiveWorker);

// Modelo fixo resolvido na primeira chamada e cacheado pelo lifetime do processo.
export function resolveWhisperModelName() {
  if (cachedModelName === null) cachedModelName = process.env.WHISPER_MODEL || 'base';
  return cachedModelName;
}

export function resetWhisperModelCache() {
  cachedModelName = null;
}

// Comando python exato:
//   python -c <código> <modelName> <audioPath> <language> <beamSize>
// Caminho e parâmetros vão por argv (nunca por interpolação) para evitar injection.
// sys.argv: [0]='-c', [1]=model, [2]=audioPath, [3]=language, [4]=beamSize.
export function buildTranscribeCommand({ audioPath, modelName, language, beamSize } = {}) {
  const code = [
    'import sys',
    'import av',
    '# av>=12 aceita metadata_errors em av.open; builds novas do av nao aceitam —',
    '# o shim tenta primeiro e reabre sem o kwarg em caso de TypeError',
    '_orig_av_open = av.open',
    'def _av_open_compat(*args, **kwargs):',
    '    try:',
    '        return _orig_av_open(*args, **kwargs)',
    '    except TypeError:',
    '        kwargs.pop("metadata_errors", None)',
    '        return _orig_av_open(*args, **kwargs)',
    'av.open = _av_open_compat',
    'from faster_whisper import WhisperModel',
    'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")',
    'segments, _ = model.transcribe(sys.argv[2], language=sys.argv[3], beam_size=int(sys.argv[4]))',
    'print(" ".join(segment.text for segment in segments))',
  ].join('\n');
  const beams = Number.isFinite(Number(beamSize)) ? Number(beamSize) : 1;
  return [
    '-c',
    code,
    String(modelName || resolveWhisperModelName()),
    String(audioPath),
    String(language || 'pt'),
    String(beams),
  ];
}

// Transcreve um arquivo de áudio local usando um worker Python persistente
// (WhisperModel quente em RAM). Lança Error com name === 'TimeoutError' quando
// estoura o timeout.
export async function transcribeAudio({ audioPath, modelName = resolveWhisperModelName(), language = 'pt', beamSize = 1, timeoutMs = 60000 } = {}) {
  if (!audioPath || typeof audioPath !== 'string') throw new Error('audioPath é obrigatório.');
  const model = String(modelName || resolveWhisperModelName());
  const beams = Number.isFinite(Number(beamSize)) ? Number(beamSize) : 1;
  const lang = String(language || 'pt');

  const run = async () => {
    const worker = getOrStartWorker(model);
    setWorkerRef(worker, true);
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('A transcrição expirou.');
        error.name = 'TimeoutError';
        stopActiveWorker();
        reject(error);
      }, timeoutMs);
    });

    try {
      await Promise.race([worker.readyPromise, timeoutPromise]);
      const id = ++workerSeq;
      const responsePromise = new Promise((resolve, reject) => {
        worker.pending.set(id, { resolve, reject });
        worker.child.stdin.write(
          JSON.stringify({ id, audioPath, language: lang, beamSize: beams }) + '\n',
          err => {
            if (err && worker.pending.has(id)) {
              worker.pending.delete(id);
              reject(err);
            }
          },
        );
      });
      const res = await Promise.race([responsePromise, timeoutPromise]);
      if (!res?.ok) {
        throw new Error('faster-whisper falhou: ' + String(res?.error || 'sem detalhes'));
      }
      return String(res.text || '').trim();
    } finally {
      if (timer) clearTimeout(timer);
      if (activeWorker === worker && worker.pending.size === 0) setWorkerRef(worker, false);
    }
  };

  const task = workerQueue.then(run, run);
  workerQueue = task.catch(() => {});
  return await task;
}

// Temp do upload multipart: <dir>/<uuid>.<ext>, criado antes da transcrição e
// apagado (best-effort) depois, tanto no sucesso quanto na falha.
export async function saveTempAudio(buffer, { dir = sttTmpDir(), extension = 'webm' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Buffer de áudio inválido.');
  await mkdir(dir, { recursive: true });
  const path = join(dir, randomUUID() + '.' + extension);
  await writeFile(path, buffer);
  return path;
}

export async function removeTempAudio(path) {
  if (!path) return;
  try {
    await rm(path, { force: true });
  } catch {
    // limpeza é best-effort; falha nunca vira resposta de erro para o cliente
  }
}
