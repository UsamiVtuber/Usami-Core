// Caminhos de dados do runtime em um único lugar (B9).
//
// Antes só memória/personalidade/vault-index honravam USAMI_DATA_DIR; TTS,
// STT, técnicas, planner e aprendizagem tinham defaults próprios ('data',
// 'data/tts-cache', 'tmp'). Um teste que redirecionava a memória ainda podia
// escrever no data/ real por uma dessas portas. Agora todo default deriva de
// dataDir(); os overrides específicos (USAMI_TTS_CACHE_DIR, USAMI_STT_TMP_DIR)
// continuam tendo prioridade sobre ele.
//
// A leitura é por chamada, não no import: os testes trocam o env antes de
// instanciar handlers/stores e o valor vale naquele momento.
import { join } from 'node:path';

export function dataDir() {
  const value = process.env.USAMI_DATA_DIR;
  return typeof value === 'string' && value.trim() ? value.trim() : 'data';
}

export function dataPath(...segments) {
  return join(dataDir(), ...segments);
}

// Override específico vence o data dir: um cache grande pode morar em outro
// volume sem mover a memória junto.
export function ttsCacheDir() {
  const value = process.env.USAMI_TTS_CACHE_DIR;
  return typeof value === 'string' && value.trim() ? value.trim() : dataPath('tts-cache');
}

export function sttTmpDir() {
  const value = process.env.USAMI_STT_TMP_DIR;
  return typeof value === 'string' && value.trim() ? value.trim() : dataPath('tmp');
}
