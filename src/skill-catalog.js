/**
 * Catálogo de Skills do domínio agêntico — descoberta e leitura apenas;
 * instalação fica para S8.
 *
 * Cada skill é um diretório em `data/skills/<id>/` com `skill.json` validado
 * por `validateSkillManifest`. O loader lê só o manifesto: nunca importa
 * código da skill. Manifesto inválido não derruba o catálogo — ele aparece
 * como `valid:false` com os erros, e o motivo fica explícito na consulta.
 *
 * Ativação é derivada, não persistida: exige `state: installed`, todas as
 * ferramentas declaradas presentes no registry e todas as dependências
 * existentes, válidas e instaladas. Não há ativação recursiva (evita ciclo
 * entre skills); a lacuna sempre aponta qual item falta.
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir as resolveDataDir } from './data-paths.js';
import { validateSkillManifest } from './agent-contracts.js';

const DIR_NAME = 'skills';
const MANIFEST_FILE = 'skill.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const SKILL_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createSkillCatalog({
  dataDir = resolveDataDir(),
  skillsDir = join(dataDir, DIR_NAME),
  registry,
  onLoadError = message => console.error(message),
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createSkillCatalog: dataDir é obrigatório.');
  if (!registry || typeof registry.has !== 'function') {
    throw new Error('createSkillCatalog: registry com has() é obrigatório.');
  }

  const records = new Map();

  function readManifest(path) {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error(`${MANIFEST_FILE} não é um arquivo`);
    if (stats.size > MANIFEST_MAX_BYTES) throw new Error(`${MANIFEST_FILE} excede ${MANIFEST_MAX_BYTES} bytes`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  function loadEntry(id) {
    let raw;
    try {
      raw = readManifest(join(skillsDir, id, MANIFEST_FILE));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`manifesto ausente (${MANIFEST_FILE})`);
      throw error;
    }
    const result = validateSkillManifest(raw);
    if (!result.ok) throw new Error(result.errors.join('; '));
    if (result.value.id !== id) throw new Error(`id (${result.value.id}) não corresponde ao diretório (${id})`);
    return result.value;
  }

  function evaluate(record) {
    if (!record.valid) {
      return {
        id: record.id,
        valid: false,
        errors: record.errors,
        activation: { canActivate: false, reasons: ['manifesto inválido'] },
      };
    }
    const manifest = record.manifest;
    const reasons = [];
    if (manifest.state === 'disabled') reasons.push('skill desativada');
    else if (manifest.state !== 'installed') reasons.push(`estado ${manifest.state}: skill não instalada`);

    const missingTools = manifest.tools.filter(tool => !registry.has(tool));
    for (const tool of missingTools) reasons.push(`ferramenta ausente: ${tool}`);

    const missingDependencies = [];
    for (const dependency of manifest.dependencies) {
      const dependencyRecord = records.get(dependency);
      if (!dependencyRecord) {
        missingDependencies.push(dependency);
        reasons.push(`dependência ausente: ${dependency}`);
        continue;
      }
      if (!dependencyRecord.valid) {
        missingDependencies.push(dependency);
        reasons.push(`dependência inválida: ${dependency}`);
        continue;
      }
      if (dependencyRecord.manifest.state !== 'installed') {
        missingDependencies.push(dependency);
        reasons.push(`dependência não instalada: ${dependency} (estado ${dependencyRecord.manifest.state})`);
      }
    }

    return {
      id: manifest.id,
      valid: true,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      state: manifest.state,
      origin: manifest.origin,
      maxPermissionLevel: manifest.maxPermissionLevel,
      activation: { canActivate: manifest.state === 'installed' && reasons.length === 0, reasons },
      missing: { tools: missingTools, dependencies: missingDependencies },
    };
  }

  /**
   * Carrega `data/skills/`. Diretório ausente começa vazio sem criar nada.
   * Entrada inválida fica registrada com os erros; as demais seguem legíveis.
   */
  function load() {
    records.clear();
    let entries;
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { skills: [] };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!SKILL_ID_RE.test(id)) {
        onLoadError(`Aviso: diretório de skill ignorado (${id}): id fora do padrão de slug.`);
        continue;
      }
      try {
        records.set(id, { id, valid: true, manifest: loadEntry(id) });
      } catch (error) {
        records.set(id, { id, valid: false, errors: [String(error?.message || error)] });
        onLoadError(`Aviso: skill ${id} inválida (${error?.message || error}).`);
      }
    }
    return { skills: list() };
  }

  function list() {
    return [...records.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(evaluate);
  }

  function get(id) {
    const record = records.get(id);
    if (!record) return { ok: false, notFound: true };
    const skill = evaluate(record);
    return { ok: true, skill: record.valid ? { ...skill, manifest: { ...record.manifest } } : skill };
  }

  return { load, list, get };
}
