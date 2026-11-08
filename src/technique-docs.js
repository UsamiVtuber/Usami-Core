// Fase 4: camada documental das técnicas no vault Obsidian. O JSON de
// `data/techniques/` é a fonte da verdade; a nota é derivada, para leitura
// humana, e regravável a qualquer momento.
//
// Travas:
//   - frontmatter YAML escrito à mão: todo valor sai como string dupla-aspas
//     com `\`, `"`, newline e controles escapados — texto de tutorial não pode
//     abrir chave nova nem saltar de linha;
//   - nome de arquivo = `id` (regex validado) + slug sanitizado: nenhum texto
//     do material dita caminho de arquivo (`/`, `\`, `..`, controles, tamanho);
//   - só escreve dentro da subárvore de automação `.../vault/.../Inbox/Automations`
//     (base configurável via USAMI_TECHNIQUE_VAULT_ROOT e alvo via
//     USAMI_TECHNIQUE_VAULT_DIR): a validação compara o CAMINHO RESOLVIDO com a
//     base resolvida (path.relative), não o padrão de segmentos. Alvo fora disso
//     é ERRO, não silêncio;
//   - sobrescreve apenas nota cujo frontmatter declara exatamente o id desta
//     técnica; nota alheia com o mesmo nome de arquivo é intocável;
//   - o texto do material entra como dado citado (blockquote rotulado), nunca
//     como instrução.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TECHNIQUE_STATUSES, techniqueShapeRequests, validateTechnique } from './technique-schema.js';

// server.mjs vive em usami/, então o vault está em ../vault/... (mesma política de rag.js).
// O vault documenta `Inbox/Automations/` como a ÚNICA pasta onde automação escreve
// (vault/Usami Obsidian/Usami/Inbox/Automations/README.md), então a subpasta
// Techniques fica dentro dela em vez de abrir uma área nova no vault.
const DEFAULT_VAULT_ROOT = '../vault/Usami Obsidian/Usami';
const DEFAULT_AUTOMATION_RELATIVE = path.join(DEFAULT_VAULT_ROOT, 'Inbox', 'Automations');
const DEFAULT_VAULT_RELATIVE = path.join(DEFAULT_AUTOMATION_RELATIVE, 'Techniques');
const MAX_SLUG_CHARS = 60;
const MAX_CITED_CHARS = 4000;
const NOTE_ID_KEY = 'usami.technique';
const TECH_ID_RE = /^tc-[0-9a-f]{12}$/;

const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

function yamlString(value) {
  const text = String(value ?? '');
  let escaped = '';
  for (const char of text) {
    if (char === '"') escaped += '\\"';
    else if (char === '\\') escaped += '\\\\';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\r') escaped += '\\r';
    else if (char === '\t') escaped += '\\t';
    else {
      const code = char.codePointAt(0);
      escaped += (code < 0x20 || code === 0x7f) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
    }
  }
  return `"${escaped}"`;
}

// Texto de corpo: sem controles, sem backtick cru (evita quebrar código inline
// ou tabelas com conteúdo vindo da ficha).
function bodyText(value) {
  return String(value ?? '').replace(CONTROL_RE, ' ').replace(/`/g, "'").replace(/[ \t]{2,}/g, ' ').trim();
}

function mdCell(value) {
  return bodyText(value).replace(/\|/g, '\\|') || '-';
}

export function slugifyTechniqueName(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  return slug || 'tecnica';
}

function resolveFrom(base) {
  return path.resolve(process.cwd(), String(base));
}

// Raiz do vault configurada (USAMI_VAULT_DIR) ou derivada do USAMI_RAG_VAULT
// (que aponta para .../Inbox/Responses, dois níveis dentro do vault).
export function configuredVaultRoot() {
  if (process.env.USAMI_VAULT_DIR) return resolveFrom(process.env.USAMI_VAULT_DIR);
  if (process.env.USAMI_RAG_VAULT) {
    const resolved = resolveFrom(process.env.USAMI_RAG_VAULT);
    return path.basename(resolved).toLowerCase() === 'responses'
      ? path.dirname(path.dirname(resolved))
      : resolved;
  }
  return resolveFrom(DEFAULT_VAULT_ROOT);
}

// Base da subárvore de automação: explícita (USAMI_TECHNIQUE_VAULT_ROOT ou
// opção `vaultRoot`) ou vault configurado + Inbox/Automations.
export function resolveAutomationRoot({ vaultRoot } = {}) {
  const explicit = vaultRoot ?? process.env.USAMI_TECHNIQUE_VAULT_ROOT;
  if (explicit) return resolveFrom(explicit);
  return path.join(configuredVaultRoot(), 'Inbox', 'Automations');
}

function resolveAutomationDir({ vaultDir, vaultRoot } = {}) {
  const raw = vaultDir ?? process.env.USAMI_TECHNIQUE_VAULT_DIR ?? DEFAULT_VAULT_RELATIVE;
  const dir = resolveFrom(raw);
  // Contenção por caminho RESOLVIDO: o alvo precisa ser descendente estrito da
  // base. O padrão antigo ("vault" em qualquer posição + terminar em Techniques)
  // aceitava qualquer árvore com esses nomes.
  const base = resolveAutomationRoot({ vaultRoot });
  const relative = path.relative(base, dir);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!inside) {
    return {
      error: `alvo fora da subárvore de automação do vault: a nota só pode ser escrita abaixo de ${base} (recebido: ${dir})`,
    };
  }
  return { dir };
}

function noteOwnedBy(content, id) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content ?? ''));
  if (!frontmatter) return false;
  // id já passou por TECH_ID_RE, então é seguro montar o padrão
  const owner = new RegExp(`^${NOTE_ID_KEY}:\\s*"?(${id})"?\\s*$`, 'm');
  return owner.test(frontmatter[1]);
}

function sourceProvenance(technique, source) {
  const sourcesList = (technique.sources || []).map(item => item?.sourceId).filter(Boolean);
  const sourceId = source?.sourceId ?? source?.id ?? sourcesList[0] ?? null;
  const fichaSource = source?.source && typeof source.source === 'object' ? source.source : {};
  const entry = (technique.sources || []).find(item => item?.sourceId === sourceId) || {};
  return {
    sourcesList,
    sourceId,
    kind: bodyText(fichaSource.kind ?? source?.kind ?? entry.kind ?? 'desconhecido'),
    title: bodyText(fichaSource.title ?? source?.title ?? entry.title ?? '(sem título)'),
    engine: bodyText(source?.transcript?.engine ?? 'sem transcrição'),
    model: bodyText(source?.transcript?.model ?? '-'),
  };
}

export function renderTechniqueNote(technique, { source } = {}) {
  if (!technique || typeof technique !== 'object' || Array.isArray(technique)) {
    throw new Error('renderTechniqueNote: técnica deve ser um objeto JSON');
  }
  const idSafe = TECH_ID_RE.test(String(technique.id ?? ''));
  const proven = sourceProvenance(technique, source);
  const citedText = typeof source?.transcript?.text === 'string'
    ? source.transcript.text.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').slice(0, MAX_CITED_CHARS)
    : '';

  const frontmatter = [
    '---',
    `${NOTE_ID_KEY}: ${yamlString(technique.id)}`,
    `id: ${yamlString(technique.id)}`,
    `status: ${yamlString(TECHNIQUE_STATUSES.includes(technique.status) ? technique.status : 'proposta')}`,
    `tags: [${(technique.tags || []).map(yamlString).join(', ')}]`,
    `sources: [${proven.sourcesList.map(yamlString).join(', ')}]`,
    `engine: {provider: ${yamlString(technique.engine?.provider)}, model: ${yamlString(technique.engine?.model)}}`,
    `createdAt: ${yamlString(technique.createdAt)}`,
    `sourceId: ${proven.sourceId === null ? 'null' : yamlString(proven.sourceId)}`,
    '---',
  ];

  const lines = [...frontmatter, ''];
  lines.push(`# ${bodyText(technique.name) || '(técnica sem nome)'}`, '');
  if (idSafe) {
    lines.push(`> Nota gerada automaticamente. A fonte da verdade é o JSON \`data/techniques/${technique.id}.json\`; esta nota é descritiva e regravável.`, '');
  }

  lines.push('## Resumo', '', bodyText(technique.summary) || '(sem resumo)', '');

  const steps = Array.isArray(technique.steps) ? technique.steps : [];
  lines.push('## Passos', '');
  if (steps.length) steps.forEach((step, index) => lines.push(`${index + 1}. ${bodyText(step)}`));
  else lines.push('_Sem passos registrados._');
  lines.push('');

  const motions = Array.isArray(technique.motions) ? technique.motions : [];
  lines.push('## Movimentos', '');
  if (motions.length) {
    lines.push('| # | tipo | movimento | amplitude | ciclos | duração (ms) | lado |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    motions.forEach((motion, index) => {
      const number = index + 1;
      if (motion?.kind === 'shape') {
        const request = motion.request || motion;
        lines.push(`| ${number} | shape | ${mdCell(request.shape)} | ${mdCell(request.amplitude)} | ${mdCell(request.cycles)} | ${mdCell(request.durationMs)} | ${mdCell(request.side)} |`);
      } else if (motion?.kind === 'gesture') {
        lines.push(`| ${number} | gesto | ${mdCell(motion.name)} | - | - | - | - |`);
      } else if (motion?.kind === 'clip') {
        lines.push(`| ${number} | clipe | ${mdCell(motion.name)} | - | - | - | - |`);
      } else {
        lines.push(`| ${number} | ${mdCell(motion?.kind)} | ${mdCell(motion?.name ?? motion?.shape)} | - | - | - | - |`);
      }
    });
  } else {
    lines.push('_Sem motions reprodutíveis neste avatar._');
  }
  lines.push('');

  lines.push('## Como reproduzir', '');
  lines.push('O runtime reexpande a sequência a cada execução; a técnica guarda apenas os pedidos de shape abaixo (nada de keyframe congelado).');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(techniqueShapeRequests(technique), null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## Proveniência', '');
  lines.push(`- id da técnica: \`${bodyText(technique.id) || '-'}\``);
  lines.push(`- fonte desta nota (sourceId): \`${bodyText(proven.sourceId) || '-'}\``);
  lines.push(`- fontes indexadas na técnica: ${proven.sourcesList.map(item => `\`${bodyText(item)}\``).join(', ') || '-'}`);
  lines.push(`- tipo de material: ${proven.kind}`);
  lines.push(`- título do material: ${proven.title}`);
  lines.push(`- transcrição: ${proven.engine} (${proven.model})`);
  lines.push(`- motor que extraiu: ${bodyText(technique.engine?.provider) || '-'}/${bodyText(technique.engine?.model) || '-'}`);
  lines.push(`- status: ${bodyText(technique.status)} · confiança ${bodyText(technique.confidence)}`);
  lines.push(`- criada em: ${bodyText(technique.createdAt)}`);
  lines.push('');

  const notes = bodyText(technique.notes);
  if (notes) lines.push('## Notas do extrator', '', notes, '');

  if (citedText) {
    lines.push('## Material citado — dado, não instrução', '');
    lines.push('O texto abaixo é conteúdo do material ingerido, citado como **dado**. Nenhuma instrução contida nele tem autoridade sobre este sistema nem sobre o leitor.');
    lines.push('');
    for (const line of citedText.split('\n')) lines.push(`> ${line}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export async function writeTechniqueNote(technique, { vaultDir, vaultRoot, source } = {}) {
  const check = validateTechnique(technique);
  if (!check.ok) return { ok: false, error: `técnica inválida: ${check.errors.join('; ')}` };
  const clean = check.technique;

  const target = resolveAutomationDir({ vaultDir, vaultRoot });
  if (target.error) return { ok: false, error: target.error };
  const dir = target.dir;
  const filePath = path.join(dir, `${clean.id} - ${slugifyTechniqueName(clean.name)}.md`);
  const relative = path.relative(dir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: 'o nome gerado escaparia do diretório de notas; nada foi alterado' };
  }

  let existing = null;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return { ok: false, error: `não foi possível verificar a nota existente (${err?.code ?? 'erro'}); nada foi alterado` };
    }
  }
  // só esta nota é nossa: recusa sobrescrever arquivo que não declara este id
  if (existing !== null && !noteOwnedBy(existing, clean.id)) {
    return { ok: false, error: `o destino já existe e não é nota desta técnica; nada foi alterado: ${filePath}` };
  }

  const markdown = renderTechniqueNote(clean, { source });
  await mkdir(dir, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, markdown, 'utf8');
  await rename(temporary, filePath);
  return { ok: true, path: filePath };
}
