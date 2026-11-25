/**
 * Memória episódica vetorial: indexa turnos de conversa (usuário + resposta) em
 * uma tabela LanceDB por personagem e recupera por similaridade semântica com
 * decaimento temporal.
 *
 * Separada de `lancedb-store.js` (notas do vault) de propósito: o corpus, o
 * schema e a política de retenção são diferentes. Compartilha o mesmo diretório
 * por personagem e o mesmo embedder local (Xenova/all-MiniLM-L6-v2, 384d).
 *
 * Escrita é bufferizada e nunca bloqueia o turno: falha de embedding grava um
 * vetor zero marcado como `degraded` (não recuperável), e falha de busca
 * devolve lista vazia em vez de resultado sem sentido.
 */
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { embedText, EMBEDDING_DIMENSION } from './local-embedder.js';
import { dataDir as defaultDataDir } from './data-paths.js';

const SAFE_TENANT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const INIT_ID = '__init__';
const DEFAULT_BUFFER_SIZE = 8;
const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_LIMIT = 3;
// MiniLM é treinado em inglês e comprime a similaridade em pt-BR (medido:
// 0,28–0,60). Um piso absoluto sozinho não separa ruído de lembrança, então a
// relevância combina similaridade + presença dos termos da consulta.
const DEFAULT_THRESHOLD = 0.45;
const LEXICAL_BONUS = 0.1;
const DEFAULT_RELATIVE_MARGIN = 0.06;
// Abaixo disso a similaridade densa sozinha não é confiável em pt-BR: exige
// pelo menos um termo da consulta no turno.
const DIRECT_SIMILARITY = 0.6;
// 0,05/dia enterrava uma lembrança de 20 dias mesmo sendo a mais relevante
// (meia-vida de ~20 dias). 0,01 mantém a ordem temporal sem apagar o passado.
const DEFAULT_DECAY_FACTOR = 0.01;
const DEFAULT_MAX_ROWS = 20000;
const DEFAULT_MAX_AGE_DAYS = 365;
const MAX_SIDE_CHARS = 600;
const DAY_MS = 86_400_000;

// Palavras de ligação e verbos de recordação não indicam assunto: não devem
// contar como âncora lexical.
const QUERY_STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'pra', 'para', 'com', 'sem', 'que', 'se',
  'e', 'ou', 'mas', 'como', 'quando', 'onde', 'qual', 'quais', 'quem', 'eu', 'voce',
  'vc', 'me', 'te', 'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'gente', 'foi',
  'ser', 'estar', 'tem', 'ter', 'vou', 'vai', 'ja', 'muito', 'mais', 'isso', 'isto',
  'aquilo', 'aquele', 'aquela', 'esse', 'essa', 'este', 'esta', 'hoje', 'ontem',
  'amanha', 'semana', 'passada', 'passado', 'dia', 'dias', 'hora', 'horas', 'agora',
  'entao', 'tipo', 'ne', 'lembra', 'lembrar', 'lembrei', 'lembrava', 'lembro',
  'comentei', 'falou', 'falei', 'falamos', 'conversamos', 'coisa', 'negocio',
]);

const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const clampText = value => collapse(value).slice(0, MAX_SIDE_CHARS);

const normalizeToken = value => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

function contentTokens(text) {
  return normalizeToken(text)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !QUERY_STOPWORDS.has(token));
}

// Sem sessionId no hash de propósito: o mesmo turno pode chegar pelo chat ao
// vivo e pelo backfill do histórico com sessões diferentes.
function createEpisodeId({ userText, assistantText }) {
  return createHash('sha1')
    .update(`${userText}\u0000${assistantText}`)
    .digest('hex')
    .slice(0, 16);
}

export class EpisodicMemoryStore {
  constructor({
    dataDir = defaultDataDir(),
    characterId = 'usami-classic',
    embedder = embedText,
    bufferSize = DEFAULT_BUFFER_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_MS,
    now = () => Date.now(),
    onError = message => console.warn(`[episodic] ${message}`),
  } = {}) {
    if (typeof characterId !== 'string' || !SAFE_TENANT_ID_RE.test(characterId)) {
      throw new Error(`characterId inválido para EpisodicMemoryStore: "${String(characterId)}"`);
    }
    this.characterId = characterId;
    this.dataDir = dataDir;
    this.embedder = embedder;
    this.bufferSize = Math.max(1, bufferSize);
    this.flushIntervalMs = Math.max(0, flushIntervalMs);
    this.now = now;
    this.onError = onError;
    this.dbDir = path.join(dataDir, 'characters', characterId, 'memory', 'lancedb');
    this.tableName = `episodes_${characterId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    this.db = null;
    this.table = null;
    this.buffer = new Map();
    this.knownIds = null;
    this.flushTimer = null;
    this.flushing = null;
    this.embeddingDegraded = false;
  }

  async init() {
    if (this.table) return this.table;
    mkdirSync(this.dbDir, { recursive: true });
    this.db = await lancedb.connect(this.dbDir);
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    } else {
      this.table = await this.db.createTable(this.tableName, [{
        id: INIT_ID,
        sessionId: '',
        text: 'initialization marker',
        ts: 0,
        isoDate: '',
        vector: new Array(EMBEDDING_DIMENSION).fill(0),
        degraded: false,
      }]);
    }
    return this.table;
  }

  /**
   * Enfileira um turno completo. Deduplica por conteúdo: reenvio do mesmo par
   * (retry de rota, reidratação) não gera linha nova.
   */
  recordTurn({ userText, assistantText, ts = this.now(), sessionId = 'default' } = {}) {
    const user = clampText(userText);
    const assistant = clampText(assistantText);
    if (!user && !assistant) return { ok: false, error: 'turno vazio' };

    const id = createEpisodeId({ userText: user, assistantText: assistant });
    if (this.buffer.has(id) || this.knownIds?.has(id)) return { ok: true, queued: false, id };

    this.buffer.set(id, {
      id,
      sessionId: String(sessionId),
      text: [user ? `Usuário: ${user}` : '', assistant ? `Usami: ${assistant}` : '']
        .filter(Boolean)
        .join('\n'),
      ts: Number(ts) || this.now(),
      isoDate: new Date(Number(ts) || this.now()).toISOString(),
      degraded: false,
    });

    if (this.buffer.size >= this.bufferSize) {
      this.flush().catch(error => this.onError(`flush falhou: ${error?.message || error}`));
    } else {
      this.armTimer();
    }
    return { ok: true, queued: true, id };
  }

  // Ids já indexados, carregados uma vez por processo. Barato porque a tabela
  // tem teto de linhas; evita reindexar o mesmo turno após flush/restart.
  async ensureKnownIds() {
    if (this.knownIds) return this.knownIds;
    try {
      const rows = await this.table.query().select(['id']).toArray();
      this.knownIds = new Set(rows.map(row => row.id).filter(id => id && id !== INIT_ID));
    } catch {
      this.knownIds = new Set();
    }
    return this.knownIds;
  }

  armTimer() {
    if (this.flushTimer || !this.flushIntervalMs) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(error => this.onError(`flush agendado falhou: ${error?.message || error}`));
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.#flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #flush() {
    if (this.buffer.size === 0) return 0;
    const pending = [...this.buffer.values()];
    this.buffer.clear();

    await this.init();
    const known = await this.ensureKnownIds();
    const records = [];
    for (const episode of pending) {
      if (known.has(episode.id)) continue;
      let vector;
      try {
        vector = await this.embedder(episode.text, { allowFallback: false });
      } catch {
        // Nunca perde o turno: grava degradado (excluído da busca).
        if (!this.embeddingDegraded) {
          this.embeddingDegraded = true;
          this.onError('embedder indisponível: turnos gravados como degradados e não recuperáveis');
        }
        vector = new Array(EMBEDDING_DIMENSION).fill(0);
        episode.degraded = true;
      }
      known.add(episode.id);
      records.push({ ...episode, vector });
    }

    if (!records.length) return 0;
    await this.table.add(records);
    return records.length;
  }

  /**
   * Busca semântica com decaimento. A relevância (similaridade + âncora
   * lexical) filtra e define uma janela relativa ao melhor resultado; o
   * decaimento ordena, para uma lembrança antiga e muito relevante ainda poder
   * vencer uma recente e fraca. A janela relativa evita injetar vizinhos
   * apenas porque a similaridade em pt-BR é comprimida.
   */
  async search({
    query,
    limit = DEFAULT_LIMIT,
    threshold = DEFAULT_THRESHOLD,
    relativeMargin = DEFAULT_RELATIVE_MARGIN,
    decayFactorPerDay = DEFAULT_DECAY_FACTOR,
    nowMs = this.now(),
  } = {}) {
    const clean = collapse(query);
    if (!clean) return [];
    await this.flush();
    await this.init();
    if (!this.table) return [];

    let queryVector;
    try {
      queryVector = await this.embedder(clean, { allowFallback: false });
    } catch {
      return [];
    }

    const queryTerms = new Set(contentTokens(clean));
    const rows = await this.table
      .vectorSearch(queryVector)
      .limit(Math.max(1, limit) * 3 + 1)
      .toArray();

    const scored = rows
      .filter(row => row.id !== INIT_ID && !row.degraded)
      .map(row => {
        const similarity = Number((1 / (1 + (row._distance ?? 0))).toFixed(4));
        const anchored = queryTerms.size
          ? contentTokens(row.text).some(token => queryTerms.has(token))
          : false;
        const relevance = Number(Math.min(1, similarity + (anchored ? LEXICAL_BONUS : 0)).toFixed(4));
        const ageDays = Math.max(0, (nowMs - Number(row.ts || 0)) / DAY_MS);
        const decay = 1 / (1 + Math.max(0, decayFactorPerDay) * ageDays);
        return {
          id: row.id,
          sessionId: row.sessionId,
          text: row.text,
          ts: Number(row.ts || 0),
          isoDate: row.isoDate,
          similarity,
          relevance,
          anchored,
          ageDays: Number(ageDays.toFixed(1)),
          score: Number((relevance * decay).toFixed(4)),
        };
      })
      .filter(item => item.relevance >= threshold && (item.anchored || item.similarity >= DIRECT_SIMILARITY));

    if (!scored.length) return [];
    const topRelevance = Math.max(...scored.map(item => item.relevance));
    const cutoff = topRelevance - Math.max(0, relativeMargin);
    const seenText = new Set();
    return scored
      .filter(item => item.relevance >= cutoff)
      .sort((a, b) => b.score - a.score)
      .filter(item => {
        if (seenText.has(item.text)) return false;
        seenText.add(item.text);
        return true;
      })
      .slice(0, Math.max(1, limit));
  }

  /**
   * Remove episódios antigos (por idade) e, se possível, o excedente por
   * quantidade. Falha de leitura de ts não impede a poda por idade.
   */
  async prune({ maxRows = DEFAULT_MAX_ROWS, maxAgeDays = DEFAULT_MAX_AGE_DAYS, nowMs = this.now() } = {}) {
    await this.flush();
    await this.init();
    let removedByAge = 0;
    let removedByRows = 0;

    if (maxAgeDays > 0) {
      try {
        const cutoff = nowMs - maxAgeDays * DAY_MS;
        await this.table.delete(`ts > 0 AND ts < ${Math.floor(cutoff)}`);
        removedByAge = 1;
      } catch (error) {
        this.onError(`poda por idade falhou: ${error?.message || error}`);
      }
    }

    if (maxRows > 0) {
      try {
        const rows = await this.table.query().select(['ts']).toArray();
        const stamps = rows.map(row => Number(row.ts || 0)).filter(ts => ts > 0).sort((a, b) => a - b);
        const excess = stamps.length - maxRows;
        if (excess > 0) {
          const cutoff = stamps[excess - 1] + 1;
          await this.table.delete(`ts > 0 AND ts < ${cutoff}`);
          removedByRows = excess;
        }
      } catch (error) {
        this.onError(`poda por quantidade falhou: ${error?.message || error}`);
      }
    }

    return { removedByAge, removedByRows };
  }

  /**
   * Semeia o índice com o histórico diário já existente (≤7 dias × 8 mensagens).
   * Idempotente: o id é hash do conteúdo, então rodar de novo não duplica.
   */
  async backfill(dailyHistory = {}) {
    let queued = 0;
    for (const [day, messages] of Object.entries(dailyHistory || {})) {
      if (!Array.isArray(messages)) continue;
      let pendingUser = null;
      for (const message of messages) {
        const content = clampText(message?.content);
        if (!content) continue;
        const ts = Date.parse(message?.timestamp || '') || Date.parse(`${day}T12:00:00.000Z`) || this.now();
        if (message.role === 'user') {
          pendingUser = { content, ts };
          continue;
        }
        if (message.role !== 'assistant') continue;
        if (pendingUser) {
          const res = this.recordTurn({
            userText: pendingUser.content,
            assistantText: content,
            ts: pendingUser.ts,
            sessionId: `backfill-${day}`,
          });
          if (res.queued) queued += 1;
          pendingUser = null;
        } else {
          const res = this.recordTurn({ userText: '', assistantText: content, ts, sessionId: `backfill-${day}` });
          if (res.queued) queued += 1;
        }
      }
    }
    if (queued) await this.flush();
    return { queued };
  }

  async count() {
    await this.init();
    const total = await this.table.countRows();
    return Math.max(0, total - 1);
  }

  /**
   * Aquece o pipeline ONNX fora do caminho de resposta: o primeiro turno não
   * deve pagar o carregamento do modelo.
   */
  async warmUp() {
    await this.init();
    await this.ensureKnownIds();
    try {
      await this.embedder('aquecimento da memória episódica', { allowFallback: false });
    } catch {
      // sem modelo local: a busca devolve vazio em vez de resultado inválido
    }
    return true;
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch {
      // melhor esforço no encerramento
    }
    this.table = null;
    this.db = null;
  }
}

export function createEpisodicMemory(options = {}) {
  return new EpisodicMemoryStore(options);
}
