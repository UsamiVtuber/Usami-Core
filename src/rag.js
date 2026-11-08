// Leitura RAG do vault Obsidian.
//
// Lê arquivos recentes de Inbox/Responses/ (gravados pelo workflow n8n
// "Usami - Receber Respostas") e devolve como contexto de texto para o
// prompt do LLM. Assim cada resposta da Usami fica gravada no vault e as
// próximas respostas têm acesso ao histórico.
//
// Puro: lê do disco, não chama rede, não tem estado mutável global.
// O caminho do vault é configurável via USAMI_RAG_VAULT (padrão:
// ../vault/Usami Obsidian/Usami/Inbox/Responses relativo ao server.mjs).

import { readFile } from 'node:fs/promises';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_VAULT_RELATIVE = '../vault/Usami Obsidian/Usami/Inbox/Responses';
const MAX_FILES = 10;        // quantos arquivos recentes ler
const MAX_CHARS_PER_FILE = 2000; // quantos caracteres de cada arquivo
const MAX_TOTAL_CHARS = 6000;    // teto total de contexto

export { DEFAULT_VAULT_RELATIVE };

export function resolveVaultDir(relative) {
  // server.mjs vive em usami/, então o vault está em ../vault/...
  return join(process.cwd(), relative || DEFAULT_VAULT_RELATIVE);
}

async function listRecentFiles(dir, limit = MAX_FILES) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(async (entry) => {
      const full = join(dir, entry.name);
      try {
        const stats = await stat(full);
        return { name: entry.name, path: full, mtimeMs: stats.mtimeMs };
      } catch {
        // Arquivo sumiu/ficou inacessível entre o readdir e o stat: descarta só
        // ele. Um stat que falha não pode derrubar a lista inteira do RAG.
        return null;
      }
    });
  const resolved = (await Promise.all(files)).filter(Boolean);
  resolved.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return resolved.slice(0, limit).map(entry => entry.path);
}

export function stripFrontmatter(markdown) {
  // Remove bloco --- ... --- do início, se existir.
  const without = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
  return without.trim();
}

export async function readRagContext({ vaultRelative, maxFiles = MAX_FILES, maxCharsPerFile = MAX_CHARS_PER_FILE, maxTotalChars = MAX_TOTAL_CHARS } = {}) {
  const dir = resolveVaultDir(vaultRelative);
  const paths = await listRecentFiles(dir, maxFiles);

  const parts = [];
  let total = 0;

  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    text = stripFrontmatter(text);
    if (!text) continue;

    // Trunca cada arquivo
    if (text.length > maxCharsPerFile) {
      text = text.slice(0, maxCharsPerFile) + '…';
    }

    const header = `\n### ${path.split(/[/\\]/).pop()}\n`;
    const block = header + text + '\n';
    // Sempre inclui pelo menos um arquivo; só para de adicionar se já tem algo
    // e excede o limite total.
    if (total + block.length > maxTotalChars && parts.length > 0) break;
    parts.push(block);
    total += block.length;
  }

  if (parts.length === 0) return null;

  return parts.join('\n---\n');
}
