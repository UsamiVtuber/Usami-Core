// Fase 3: persistência mínima de técnicas e leitura das fichas ingeridas.
//
// Isto NÃO é a base de conhecimento (Fase 4, SQLite + Obsidian): é o arquivo onde
// a técnica validada fica para que a Fase 4 indexe e o Fase 5 consulte. Um arquivo
// por técnica, nome = id, escrita atômica (mesma política de memory-store.js e do
// pipeline de ingestão): um crash no meio nunca deixa técnica pela metade na pasta.
//
// A leitura da ficha de origem é daqui também porque o `sourceId` vem de requisição
// HTTP: o id é validado por formato ANTES de virar caminho de arquivo. Sem isso,
// `../../vault/qualquer-coisa` seria uma rota de leitura fora do diretório de
// ingestão — e o vault é privado.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateTechnique } from './technique-schema.js';
import { dataDir as defaultDataDir } from './data-paths.js';

const SOURCE_ID_RE = /^src-[0-9a-f]{12}$/;
const TECHNIQUE_ID_RE = /^tc-[0-9a-f]{12}$/;

async function writeJsonAtomic(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function createTechniqueStore({ dataDir = defaultDataDir() } = {}) {
  const dir = path.join(dataDir, 'techniques');

  async function save(technique) {
    const check = validateTechnique(technique);
    if (!check.ok) return { ok: false, errors: check.errors };
    const target = path.join(dir, `${check.technique.id}.json`);
    await writeJsonAtomic(target, check.technique);
    return { ok: true, path: target, technique: check.technique };
  }

  async function get(id) {
    if (!TECHNIQUE_ID_RE.test(id ?? '')) return { ok: false, errors: ['id de técnica inválido'] };
    const loaded = await readJsonSafe(path.join(dir, `${id}.json`));
    if (!loaded) return { ok: false, errors: ['técnica não encontrada'] };
    const check = validateTechnique(loaded);
    // reler é validar: um arquivo editado à mão não entra no planner
    if (!check.ok) return { ok: false, errors: [`técnica armazenada inválida: ${check.errors.join('; ')}`] };
    return { ok: true, technique: check.technique };
  }

  async function list() {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const techniques = [];
    for (const name of names.filter(item => TECHNIQUE_ID_RE.test(item.replace(/\.json$/, '')))) {
      const loaded = await readJsonSafe(path.join(dir, name));
      if (loaded && validateTechnique(loaded).ok) techniques.push(loaded);
    }
    return techniques.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { save, get, list, dir };
}

// Ficha de ingestão pelo id declarado na requisição. Caminho nunca é montado a
// partir de texto livre: só `data/ingest/src-<12hex>/ficha.json`.
export async function readIngestedFicha(sourceId, { dataDir = defaultDataDir() } = {}) {
  if (!SOURCE_ID_RE.test(sourceId ?? '')) return { ok: false, errors: ['sourceId inválido (esperado src-<12 hex>)'] };
  const filePath = path.join(dataDir, 'ingest', sourceId, 'ficha.json');
  if (!existsSync(filePath)) return { ok: false, errors: [`ficha não encontrada em ${path.relative(process.cwd(), filePath)}`] };
  const ficha = await readJsonSafe(filePath);
  if (!ficha) return { ok: false, errors: ['ficha ilegível ou JSON inválido'] };
  return { ok: true, ficha };
}
