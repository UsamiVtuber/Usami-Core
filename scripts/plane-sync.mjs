#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const API = 'https://api.plane.so/api/v1';
const args = parseArgs(process.argv.slice(2));
const workspace = args.workspace || process.env.PLANE_WORKSPACE || 'usami';
const projectName = args['project-name'] || 'USAMI 2.0';
const identifier = args.identifier || 'USAMI2';
const planPath = resolve(args.plan || '.agent/plan-usami-2.0.json');
const dryRun = Boolean(args['dry-run']);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = list[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function getKey() {
  if (process.env.PLANE_API_KEY) return process.env.PLANE_API_KEY.trim();
  const vault = join(homedir(), '.qoder', 'vault.ps1');
  const value = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', vault,
    '-Action', 'get', '-Name', 'plane-api-key',
  ], { encoding: 'utf8' });
  const key = value.trim();
  if (!key) throw new Error('Chave vazia no cofre.');
  return key;
}

const key = getKey();
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function api(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 429 && attempt < 3) {
      const retry = Number(response.headers.get('retry-after') || 2);
      await sleep(retry * 1000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }
}

async function listAll(path) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${path}${separator}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await api(url);
    items.push(...(data.results || []));
    if (!data.next_page_results || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return items;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDescription(story) {
  const tasks = story.tasks
    .map(task => `<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>${escapeHtml(task)}</p></div></li>`)
    .join('');
  const blocked = story.blockedBy.length ? story.blockedBy.join(', ') : 'Nenhuma';
  return `<h2>Objetivo</h2><p>${escapeHtml(story.demoBoundary)}</p>`
    + `<h2>Tarefas</h2><ul data-type="taskList">${tasks}</ul>`
    + `<h2>Escopo</h2><p>${escapeHtml(story.scopeNotes)}</p>`
    + `<h2>Dependencias</h2><p>Bloqueado por: ${escapeHtml(blocked)}</p>`
    + `<h2>Orientacao tecnica</h2><p>${escapeHtml(story.techGuidance)}</p>`
    + `<p><em>Requisitos: ${escapeHtml(story.covers.join(', '))} - fonte: .agent/plan-usami-2.0.json</em></p>`;
}

// Estado opcional por story no plano (`status` ausente = não mexe no board).
// Aceita o vocabulário curto do roadmap e também os grupos do Plane.
const STATUS_GROUPS = Object.freeze({
  backlog: 'backlog',
  todo: 'unstarted',
  unstarted: 'unstarted',
  in_progress: 'started',
  started: 'started',
  done: 'completed',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
});

function stateGroupFor(story) {
  if (story.status === undefined) return null;
  const group = STATUS_GROUPS[story.status];
  if (!group) {
    throw new Error(`story ${story.id}: status "${story.status}" inválido (use ${Object.keys(STATUS_GROUPS).join('|')})`);
  }
  return group;
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
for (const story of plan.stories) stateGroupFor(story);
const configPath = resolve(args.config || join(dirname(planPath), 'plane.json'));
let config = null;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  config = null;
}

let project = null;
const configuredId = args['project-id'] || config?.projectId;
if (configuredId) {
  project = await api(`/workspaces/${workspace}/projects/${configuredId}/`);
  console.log(`projeto: ${project.name} (${project.identifier}) ${project.id}`);
} else {
  const projects = await listAll(`/workspaces/${workspace}/projects/`);
  project = projects.find(item => item.name === projectName) || projects.find(item => item.identifier === identifier);

  if (!project) {
    if (dryRun) {
      console.log(`[dry-run] criaria projeto "${projectName}" (${identifier})`);
      project = { id: 'dry-run', name: projectName, identifier };
    } else {
      project = await api(`/workspaces/${workspace}/projects/`, {
        method: 'POST',
        body: {
          name: projectName,
          identifier,
          description: 'Roadmap e execucao do MVP do USAMI 2.0. Fonte da verdade: usami/.agent/plan-usami-2.0.json.',
        },
      });
      console.log(`projeto criado: ${project.name} (${project.identifier}) ${project.id}`);
    }
  } else {
    console.log(`projeto existente: ${project.name} (${project.identifier}) ${project.id}`);
  }
}

if (!dryRun && project.id !== 'dry-run') {
  const nextConfig = { workspace, projectId: project.id, projectName: project.name };
  if (!config || config.projectId !== project.id || config.workspace !== workspace) {
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }
}

// O dry-run também lê estados (GET), para validar o mapeamento sem escrever.
const states = project.id === 'dry-run' ? [] : await listAll(`/workspaces/${workspace}/projects/${project.id}/states/`);
const stateIdByGroup = new Map();
for (const state of states) {
  if (!stateIdByGroup.has(state.group)) stateIdByGroup.set(state.group, state.id);
}

function resolveStateId(group, story) {
  if (project.id === 'dry-run') return null;
  const stateId = stateIdByGroup.get(group);
  if (!stateId) throw new Error(`story ${story.id}: projeto sem estado no grupo "${group}"`);
  return stateId;
}

const issues = project.id === 'dry-run' ? [] : await listAll(`/workspaces/${workspace}/projects/${project.id}/issues/`);
const byExternalId = new Map();
const byStoryPrefix = new Map();
for (const issue of issues) {
  if (issue.external_id) byExternalId.set(issue.external_id, issue);
  const match = /^\[(S\d+)\]/.exec(issue.name || '');
  if (match) byStoryPrefix.set(match[1], issue);
}

const created = [];
for (const story of plan.stories) {
  const externalId = `usami-plan:${story.id}`;
  const name = `[${story.id}] ${story.title}`;
  const payload = {
    name,
    description_html: buildDescription(story),
    external_id: externalId,
    external_source: 'usami-plan',
  };

  // Sem `status` no plano, o estado do board é preservado (inclusive Done
  // marcado à mão); com `status`, o JSON vira a fonte da verdade.
  const statusGroup = stateGroupFor(story);
  const defaultLabel = story.blockedBy.length ? 'backlog' : 'todo';

  const existing = byExternalId.get(externalId) || byStoryPrefix.get(story.id);
  if (existing) {
    const updatePayload = { ...payload };
    if (statusGroup) {
      const stateId = resolveStateId(statusGroup, story);
      if (stateId) updatePayload.state = stateId;
    }
    if (!dryRun) {
      await api(`/workspaces/${workspace}/projects/${project.id}/issues/${existing.id}/`, { method: 'PATCH', body: updatePayload });
    }
    const suffix = statusGroup ? ` (estado: ${story.status})` : '';
    console.log(`${dryRun ? '[dry-run] atualizaria' : 'atualizado'} ${story.id} #${existing.sequence_id}${suffix}`);
  } else {
    const createPayload = { ...payload };
    const stateLabel = story.status ?? defaultLabel;
    const stateId = resolveStateId(statusGroup || (story.blockedBy.length ? 'backlog' : 'unstarted'), story);
    if (stateId) createPayload.state = stateId;
    if (dryRun) {
      console.log(`[dry-run] criaria ${name} (estado: ${stateLabel})`);
    } else {
      const issue = await api(`/workspaces/${workspace}/projects/${project.id}/issues/`, { method: 'POST', body: createPayload });
      created.push(issue);
      console.log(`criado ${story.id} #${issue.sequence_id} (estado: ${stateLabel})`);
    }
  }
  await sleep(250);
}

if (!dryRun) {
  console.log(`\nPronto: ${plan.stories.length} stories em ${project.name}. Criadas agora: ${created.length}.`);
  console.log(`https://app.plane.so/${workspace}/projects/${project.id}/issues/`);
}
