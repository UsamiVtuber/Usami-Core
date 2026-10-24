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

let cachedModelName = null;

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

// Transcreve um arquivo de áudio local e devolve o texto (trimmed); lança Error
// com name === 'TimeoutError' quando o python estoura o timeout do spawn.
export async function transcribeAudio({ audioPath, modelName = resolveWhisperModelName(), language = 'pt', beamSize = 1, timeoutMs = 60000 } = {}) {
  if (!audioPath || typeof audioPath !== 'string') throw new Error('audioPath é obrigatório.');
  const args = buildTranscribeCommand({ audioPath, modelName, language, beamSize });
  return await new Promise((resolve, reject) => {
    const child = spawn('python', args, { timeout: timeoutMs, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeoutError = () => {
      const error = new Error('A transcrição expirou.');
      error.name = 'TimeoutError';
      return error;
    };
    child.on('error', error => {
      // spawn com timeout mata o processo e emite error com killed/signal
      if (error?.killed || error?.code === 'ETIMEDOUT') return reject(timeoutError());
      reject(new Error('Não foi possível executar o python (faster-whisper).'));
    });
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') return reject(timeoutError());
      if (code !== 0) {
        const lastLine = stderr.trim().split('\n').pop() || 'sem detalhes';
        return reject(new Error('faster-whisper falhou: ' + lastLine.slice(0, 300)));
      }
      resolve(stdout.trim());
    });
  });
}

// Temp do upload multipart: <dir>/<uuid>.<ext>, criado antes da transcrição e
// apagado (best-effort) depois, tanto no sucesso quanto na falha.
export async function saveTempAudio(buffer, { dir = process.env.USAMI_STT_TMP_DIR || 'tmp', extension = 'webm' } = {}) {
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
