// Parser de streaming e fatiador de balões enriquecido com emoções e SFX.
//
// Projetado para Usami:
//   - Aceita tags inline de emoção: `[casual_happy]`, `[intimate_shy]`, etc.
//   - Aceita tags de efeitos sonoros: `【Laugh】`, `【Sigh】`, `【Yawn】`, `[risada]`.
//   - Converte efeitos sonoros em speech tags compatíveis com o Gemini TTS (<laugh>, <sigh>...).
//   - Divide em balões curtos (~60 caracteres, máx 5 balões, sem perda de texto).
//   - O 1º balão sai mais rápido (com ~25-35 chars ao encontrar pontuação) para acelerar o TTFT de voz.
//   - Resiliente a cortes de rede no meio de tags (ex: chunk terminando em `[casual_` ou `【Lau`).
//
// Módulo puro: funciona no Node.js e no browser sem dependências.

import { resolveEmotion, DEFAULT_EMOTION } from './emotion-resolver.js';

const SENTENCE_ENDERS = new Set(['.', '!', '?', '…', '\n']);

// Mapeamento canônico dos 9 SFX do OpenAmika + aliases em pt-BR para tags Gemini TTS.
const SFX_TO_GEMINI = Object.freeze({
  laugh: 'laugh',
  laughter: 'laugh',
  can_t_help_laughing: 'laugh',
  cant_help_laughing: 'laugh',
  chuckle: 'chuckle',
  soft_hmph: 'chuckle',
  hmph: 'chuckle',
  giggle: 'giggle',
  risada: 'laugh',
  risinho: 'chuckle',
  risadinha: 'chuckle',
  sigh: 'sigh',
  suspiro: 'sigh',
  deep_breath: 'breath',
  breath: 'breath',
  respiro: 'breath',
  yawn: 'short pause',
  bocejo: 'short pause',
  sniff: 'short pause',
  light_cough: 'short pause',
  throat_clear: 'short pause',
  pause: 'short pause',
  gasp: 'gasp',
  espanto: 'gasp',
});

// Tags que devem ser descartadas sem emitir som (placeholders comuns)
const PLACEHOLDER_TAGS = new Set([
  '声效名', '声效', 'sfx', 'sfx_name', 'register_emotion', 'tag',
  'emotion', '语气', '语气标签', 'name', '声效标签', 'emocao',
]);

export class UsamiStreamingParser {
  constructor({
    maxBalloonChars = 60,
    maxBalloons = 5,
    firstBalloonMinChars = 12,
    onBalloonReady = null,
  } = {}) {
    this.maxBalloonChars = Number.isFinite(maxBalloonChars) && maxBalloonChars > 0 ? Math.floor(maxBalloonChars) : 60;
    this.maxBalloons = Number.isFinite(maxBalloons) && maxBalloons > 0 ? Math.floor(maxBalloons) : 5;
    this.firstBalloonMinChars = Number.isFinite(firstBalloonMinChars) ? Math.floor(firstBalloonMinChars) : 12;
    this.onBalloonReady = typeof onBalloonReady === 'function' ? onBalloonReady : null;

    this.buffer = '';
    this.currentEmotion = DEFAULT_EMOTION;
    this.balloons = [];
    this.activeText = '';
    this.activeSfx = [];
    this.flushed = false;
  }

  feed(chunk) {
    if (this.flushed || chunk === null || chunk === undefined) return;
    this.buffer += String(chunk);
    this._drain(false);
  }

  flush() {
    if (this.flushed) return this.balloons;
    this._drain(true);

    const remainder = this.activeText.trim();
    if (remainder) {
      this._emitBalloon(remainder, true);
      this.activeText = '';
    } else if (this.balloons.length > 0) {
      // Garante que o último balão gerado seja marcado como final
      this.balloons[this.balloons.length - 1].isFinal = true;
    }

    this.flushed = true;
    return this.balloons;
  }

  _drain(isFinal) {
    while (this.buffer.length > 0) {
      // 1. Tag de emoção no início: `[casual_happy]`
      const emoMatch = this.buffer.match(/^\[([a-zA-Z0-9_\-\s]{2,40})\]/);
      if (emoMatch) {
        const raw = emoMatch[1].trim();
        const lower = raw.toLowerCase().replace(/[-\s]+/g, '_');
        // Se for uma tag SFX disfarçada entre colchetes (ex: [laugh] ou [risada])
        if (SFX_TO_GEMINI[lower]) {
          this.activeSfx.push(SFX_TO_GEMINI[lower]);
        } else if (!PLACEHOLDER_TAGS.has(lower)) {
          this.currentEmotion = resolveEmotion(raw, this.currentEmotion);
        }
        this.buffer = this.buffer.slice(emoMatch[0].length);
        continue;
      }

      // 2. Tag de efeito sonoro no início: `【Laugh】`
      const sfxMatch = this.buffer.match(/^【([a-zA-Z0-9_\-\s\u4e00-\u9fa5]{1,30})】/);
      if (sfxMatch) {
        const raw = sfxMatch[1].trim();
        const lower = raw.toLowerCase().replace(/[-\s]+/g, '_');
        if (SFX_TO_GEMINI[lower]) {
          this.activeSfx.push(SFX_TO_GEMINI[lower]);
        }
        this.buffer = this.buffer.slice(sfxMatch[0].length);
        continue;
      }

      // 3. Se houver um início de tag não terminada no final do buffer, aguarda mais dados
      if (!isFinal) {
        const pendingTagIdx = this.buffer.search(/[\[【][^\]】]*$/);
        if (pendingTagIdx !== -1) {
          const safePrefix = this.buffer.slice(0, pendingTagIdx);
          this.buffer = this.buffer.slice(pendingTagIdx);
          if (safePrefix) this._consumeText(safePrefix);
          break;
        }
      }

      // 4. Procura o próximo caractere especial (início de tag ou pontuação)
      const specialIdx = this.buffer.search(/[\[【.!?…\n]/);
      if (specialIdx === -1) {
        if (isFinal) {
          this._consumeText(this.buffer);
          this.buffer = '';
        }
        break;
      }

      const matchChar = this.buffer[specialIdx];
      if (matchChar === '[' || matchChar === '【') {
        const textBefore = this.buffer.slice(0, specialIdx);
        this.buffer = this.buffer.slice(specialIdx);
        if (textBefore) this._consumeText(textBefore);
      } else {
        // Pontuação: inclui repetidos ("...", "?!") na mesma fatia
        let endIdx = specialIdx;
        while (endIdx + 1 < this.buffer.length && SENTENCE_ENDERS.has(this.buffer[endIdx + 1])) {
          endIdx += 1;
        }
        const textWithPunct = this.buffer.slice(0, endIdx + 1);
        this.buffer = this.buffer.slice(endIdx + 1);
        this._consumeText(textWithPunct);
      }
    }
  }

  _consumeText(segment) {
    if (!segment) return;
    this.activeText += segment;

    const trimmed = this.activeText.trim();
    if (!trimmed) return;

    // Se já atingimos o número máximo de balões permitidos menos 1,
    // o restante do texto deve se acumular para o último balão
    if (this.balloons.length >= this.maxBalloons - 1) {
      return;
    }

    const isFirst = this.balloons.length === 0;
    const minThreshold = isFirst ? this.firstBalloonMinChars : 40;
    const hasPunctEnd = /[.!?…\n]$/.test(trimmed);

    // Corta balão se terminou em pontuação com tamanho razoável OU se estourou o limite máximo
    if (
      (hasPunctEnd && trimmed.length >= minThreshold) ||
      trimmed.length >= this.maxBalloonChars
    ) {
      this._emitBalloon(trimmed, false);
      this.activeText = '';
    }
  }

  _emitBalloon(rawText, isFinal) {
    let display = rawText
      .replace(/["“”「」『』]/g, '')
      .replace(/\*+[^*]*\*+/g, '') // remove direções de palco (*ação*)
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    if (!display) return;

    let ttsText = display;
    const tags = [...new Set(this.activeSfx)].slice(0, 2);
    this.activeSfx = [];

    if (tags.length > 0) {
      ttsText = `${display} ${tags.map(t => `<${t}>`).join(' ')}`;
    }

    const balloon = {
      index: this.balloons.length,
      display,
      ttsText,
      emotionKey: this.currentEmotion,
      speechTags: tags,
      isFinal: Boolean(isFinal),
    };

    this.balloons.push(balloon);
    if (this.onBalloonReady) {
      this.onBalloonReady(balloon);
    }
  }
}

/**
 * Utilitário puro: divide um texto completo de resposta nos balões estruturados da Usami.
 */
export function parseReplyBalloons(reply, options = {}) {
  const parser = new UsamiStreamingParser(options);
  parser.feed(reply);
  return parser.flush();
}
