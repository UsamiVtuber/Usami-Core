/**
 * Usami Core — roteamento de intenção e orquestração do domínio agêntico (S9).
 *
 * Classifica a mensagem de forma determinística primeiro (`conversation`,
 * `operational` ou `complex`) e aceita `classifyWithLlm` injetável apenas para
 * casos ambíguos. Encaminha pedidos operacionais ao Tool Executor (S4/S5) e
 * tarefas complexas ao Planner Engine (S6), sem nunca substituir o caminho ativo
 * de `createChatHandler` nem bloquear o balão da companion.
 */
import { randomBytes } from 'node:crypto';
import { AGENT_LIMITS, AGENT_SCHEMAS, INTENT_KINDS, validateIntent } from './agent-contracts.js';
import { redactSecrets } from './self-introspection.js';

export const DEFAULT_TURN_LIMIT = 50;
export const DEFAULT_TURN_DEADLINE_MS = 40_000;
const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.7;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = ms => new Date(ms).toISOString();
const collapseText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const normalizeText = value => collapseText(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const CALENDAR_LIST_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|abr\w*|quais|tenho|tem|como\s+(?:esta|ta)|o\s+que\s+(?:tem|tenho|ha))\b(?!.*\b(?:cria\w*|adiciona\w*|coloc\w*|agendar|agende|agendo|agendei|marca\w*|marcacao)\b).*\b(?:google calendar|calendario|eventos?(?:\s+da\s+agenda)?|compromissos?(?:\s+(?:na|da)\s+agenda|\s+hoje|\s+amanha|\s+essa\s+semana)?|minha\s+agenda|agenda\s+(?:de\s+)?(?:hoje|amanha|semana))\b/;
const CALENDAR_CREATE_RE = /\b(?:cria\w*|adiciona\w*|coloc\w*|agendar|agende|agendo|agendei|marca\w*|salva\w*)\b.*\b(?:google calendar|calendario|evento|compromisso|agenda)\b|\b(?:no\s+calendario|na\s+agenda)\b.*\b(?:cria\w*|adiciona\w*|coloc\w*|agendar|agende|agendo|agendei|marca\w*)\b/;
const EMAIL_LIST_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|chec\w*|confer\w*|ler|leia|olh\w*|busc\w*|procur\w*|abr\w*|acess\w*|chegou|tem|tenho|como\s+(?:esta|ta)|o\s+que\s+(?:tem|ha|chegou)|quais)\b(?!.*\b(?:envi\w*|mand\w*|escrev\w*|respond\w*)\b).*\b(?:e-?mails?|gmail|caixa de entrada|inbox)\b|\b(?:meu\s+gmail|minha\s+caixa\s+de\s+entrada|meus\s+e-?mails?)\b/;
const FINANCE_ACCOUNTS_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|como\s+(?:esta|ta)|qual|quais|quanto)\b.*\b(?:contas?|saldos?|open\s*finance|pluggy|belvo|banco)\b|\b(?:meu\s+saldo|minhas?\s+contas?|quanto\s+tenho\s+(?:no\s+banco|na\s+conta|de\s+saldo))\b/;
const FINANCE_TX_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|como\s+(?:esta|ta)|quais|quanto)\b.*\b(?:transacoes|extrato|gastos|despesas|compras|movimentacoes|gastei|fatura)\b|\b(?:meu\s+extrato|meus\s+gastos|minhas\s+transacoes)\b/;
const RESEARCH_SEARCH_RE = /\b(?:pesquis\w*|busc\w*|procur\w*)\s+(?:na\s+web|na\s+internet|online|via\s+(?:tinyfish|firecrawl))\b|\b(?:pesquis\w*|busc\w*|procur\w*)\b.*\b(?:na\s+web|na\s+internet|via\s+(?:tinyfish|firecrawl))\b|\b(?:pesquis\w*|busc\w*|procur\w*|ach\w*|veja|ver|v[eê]|traz\w*|traga|trouxe|quais(?:\s+as)?|tem|saiu)\b(?!.*\b(?:e-?mails?|gmail|agenda|calendario|git|memoria)\b).*\b(?:noticias?|manchetes?|novidades?(?:\s+(?:de|sobre|do|da|em|no|na)))\b|\b(?:noticias?|manchetes?)\b(?!.*\b(?:e-?mails?|gmail|agenda|calendario|git|memoria)\b).*\b(?:ver|v[eê]|veja|pesquis\w*|bus(?:c|qu)\w*|procur\w*|ach\w*|mostr\w*)\b|\b(?:pesquis\w*|googl\w*)\s+(?:sobre|por|a\s+respeito\s+de)\s+(?!.*\b(?:memoria|fatos|historico|resumos?|mim|eu|meu|minha|e-?mails?|gmail|agenda|calendario|arquivo|codigo|git|repo(?:sitorio)?)\b).+/;
const RESEARCH_FETCH_RE = /\b(?:extrai\w*|ler|scrape|fetch)\b.*\bhttps?:\/\/\S+/;
const GIT_LOG_RE = /\b(?:commits?|historico|log)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?)\b|\b(?:ultimos?|recentes?)\s+commits?\b/;
const GIT_DIFF_RE = /\b(?:diff|mudancas?|alteracoes)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?|locais?|pendentes?)\b|\bo que (?:esta|tem) (?:modificado|alterado)\b/;
const GITHUB_REPOS_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|quais(?:\s+sao)?|como\s+(?:esta|ta|estao))\b.*\b(?:repositorios?(?:\s+(?:no\s+|do\s+)?github)?|github)\b|\b(?:meus\s+repositorios?|repositorios?\s+do\s+github)\b/;
const GIT_STATUS_RE = /\b(?:status|branch|estado|situacao)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?(?:\s+local)?|projeto)\b|\b(?:em\s+qual|qual)\s+(?:a\s+)?branch\b|\b(?:mostr\w*|us\w*|test\w*|execut\w*|rod\w*|acion\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|como\s+(?:esta|ta))\b.*\b(?:git-assistant|git\s+assistant|status\s+do\s+git|meu\s+git)\b|\b(?:ver|v[eê]|veja|olh\w*|chec\w*|confer\w*)\b.*\b(?:repos?|repositorios?|arquivos?|mudancas?|commits?|alteracoes)?\s*(?:locais|local)\b/;
const SELF_DESCRIBE_RE = /\b(?:quais|lista\w*|mostr\w*|descrev\w*|resum\w*|sab\w*|conhec\w*|tem|ganh\w*|receb\w*)\b.*\b(?:ferramentas?|skills?|habilidades?|modulos?|limitacoes?|integracoes?|capacidades?|novidades?|erros?\s+recentes?)\b|\b(?:novas?|novos?|recentes?)\s+(?:skills?|habilidades?|ferramentas?|capacidades?|integracoes?)\b|\b(?:skills?|habilidades?|ferramentas?)\s+(?:novas?|novos?|atuais|disponiveis|ativas|instaladas)\b|\b(?:o que (?:voce|vc|tu) (?:tem|faz|sabe fazer|consegue fazer)|o que mudou(?:\s+em\s+(?:voce|vc|tu))?|suas? limitacoes?|seu status)\b/;

const COMPLEX_PATTERNS = [
  /\b(planej\w*|cronograma|roteiro|plano|etapas?|passo a passo|checklist|decompor|roadmap)\b/,
  /\b(organiz\w*|estrutur\w*|prepar\w*|mont\w*)\s+(?:a|o|minha|meu|as|os|uma|um)?\s*(?:semana|mes|dia|projeto|rotina|viagem|estudos?|sprint|entrega|tarefas?|agenda)\b/,
  /\b(primeiro|antes)\b.*\b(depois|em seguida|por fim)\b/,
];

const OPERATIONAL_PATTERNS = [
  /\b(bus(?:c|qu)\w*|procur\w*|pesquis\w*|consult\w*)\b.*\b(memoria|fatos|historico|resumos?)\b/,
  /\bo que (?:voce|vc|tu) (?:sabe|lembra)\b/,
  /\b(lembr\w*|record\w*)\b.*\b(te falei|eu disse|eu gosto|sobre mim|memoria)\b/,
  /\b(list\w*|mostr\w*|quais|adicion\w*|cri\w*|anot\w*|registr\w*|mar(?:c|qu)\w*|atualiz\w*|conclu\w*|prioriz\w*|orden\w*)\b.*\b(tarefas?|pendencias?|compromissos?|projetos?|prazos?|agenda)\b/,
  SELF_DESCRIBE_RE,
  /\bbriefing\b/,
  /\bresumo\s+(?:do\s+dia|diario)\b/,
  /\b(revis\w*|resum\w*)\b.*\b(estudos?|aprendizado|revisao espacada)\b/,
  /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?(?:trilha\s+de\s+estudos?|rascunho|documento|nota|checklist|adr)\b/,
  /\b(?:inspecion\w*|ler|ver|mostr\w*|busc\w*|procur\w*)\b.*\b(?:arquivo|codigo|src\/|docs\/|skills\/|desktop\/|usami-desktop\/|cargo\.toml)\b/,
  /\b(?:projet\w*|desenh\w*|blueprint)\b.*\bskill\b/,
  GIT_LOG_RE,
  GIT_DIFF_RE,
  GITHUB_REPOS_RE,
  GIT_STATUS_RE,
  CALENDAR_CREATE_RE,
  CALENDAR_LIST_RE,
  EMAIL_LIST_RE,
  FINANCE_ACCOUNTS_RE,
  FINANCE_TX_RE,
  RESEARCH_SEARCH_RE,
  RESEARCH_FETCH_RE,
  /\bexecuta\w*\s+(?:a\s+)?ferramenta\b/,
];

const CONVERSATION_PATTERNS = [
  /^(?:oi+|ola+|hey+|ei+|bom dia|boa tarde|boa noite|tudo bem|como vai|e ai)\b/,
  /\b(vamos conversar|conta uma piada|te amo|saudade|estou triste|estou feliz|estou cansad[oa])\b/,
];

const MEMORY_QUERY_LEAD_IN_RE = /^(?:(?:por favor|usami|ei|oi)[,\s]+)*(?:(?:o que (?:voce|vc|tu) (?:sabe|lembra))|(?:(?:busca|buscar|busque|procure|procurar|pesquisa|pesquisar|pesquise|consulta|consultar|consulte|lembra|lembrar|lembre|mostra|mostrar|mostre|veja|ver)(?:\s+(?:na|nos|no)\s+(?:memoria|fatos|historico|resumos?))?))(?:\s+(?:sobre|por|de|a respeito de|do que))?\s*[:\-]?\s*/i;

export function extractMemoryQuery(message) {
  const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
  const normalizedLead = normalizeText(clean);
  const match = MEMORY_QUERY_LEAD_IN_RE.exec(normalizedLead);
  if (!match) return clean;
  const sliced = clean.slice(match[0].length)
    .replace(/^(?:o que eu (?:disse|falei|gosto)\s*(?:sobre|de)?\s*)/i, '')
    .replace(/^(?:(?:o|a|os|as)\s+)?(?:meu|minha|meus|minhas)\s+|^(?:o|a|os|as)\s+/i, '')
    .trim();
  return sliced || clean;
}

function buildIntent({ kind, goal, confidence, origin, now }) {
  const trimmedGoal = collapseText(goal).slice(0, AGENT_LIMITS.maxGoalChars);
  const safeGoal = trimmedGoal.length >= 3 ? trimmedGoal : trimmedGoal.padEnd(3, '.');
  const candidate = {
    schema: AGENT_SCHEMAS.intent,
    id: `int-${randomBytes(6).toString('hex')}`,
    kind,
    goal: safeGoal,
    confidence,
    origin,
    createdAt: iso(now()),
  };
  const checked = validateIntent(candidate);
  if (!checked.ok) throw new Error(`intent inválida: ${checked.errors.join('; ')}`);
  return checked.value;
}

/**
 * Classificação determinística síncrona (primeiro estágio).
 * Devolve `{ kind, confidence, ambiguous, matchedToolName? }`.
 */
export function classifyDeterministic(message, { toolNames = [] } = {}) {
  const clean = collapseText(message);
  const normalized = normalizeText(clean);
  if (!normalized) return { kind: 'conversation', confidence: 0.9, ambiguous: false };

  for (const toolName of toolNames) {
    if (normalized.includes(toolName.toLowerCase())) {
      return { kind: 'operational', confidence: 0.95, ambiguous: false, matchedToolName: toolName };
    }
  }

  if (COMPLEX_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'complex', confidence: 0.9, ambiguous: false };
  }

  if (OPERATIONAL_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'operational', confidence: 0.88, ambiguous: false };
  }

  if (CONVERSATION_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { kind: 'conversation', confidence: 0.92, ambiguous: false };
  }

  // Pedidos curtos ou vagos sem marcadores claros são sinalizados como
  // ambíguos para que um classificador LLM opcional possa desempatar; sem
  // LLM, caem em conversa com segurança.
  const words = normalized.split(/\s+/).filter(Boolean);
  const looksVagueQuestion = words.length <= 6 && /\b(faz|faca|resolve|ajuda|isso|aquilo|agora)\b/.test(normalized);
  return {
    kind: 'conversation',
    confidence: looksVagueQuestion ? 0.55 : 0.78,
    ambiguous: looksVagueQuestion,
  };
}

export const DEFAULT_TOOL_MATCHERS = Object.freeze([
  {
    toolName: 'self.describe',
    matches: normalized => SELF_DESCRIBE_RE.test(normalized),
    buildArgs: message => {
      const normalized = normalizeText(message);
      if (/\berros?\b/.test(normalized)) return { focus: 'errors' };
      if (/\blimitacoes?\b/.test(normalized)) return { focus: 'limitations' };
      if (/\b(skills?|habilidades?|capacidades?|novidades?|mudou)\b/.test(normalized)) return { focus: 'skills' };
      if (/\bmodulos?\b/.test(normalized)) return { focus: 'modules' };
      if (/\bferramentas?\b/.test(normalized)) return { focus: 'tools' };
      return { focus: 'all' };
    },
  },
  {
    toolName: 'memory.search',
    matches: normalized => (
      !SELF_DESCRIBE_RE.test(normalized)
      && !RESEARCH_SEARCH_RE.test(normalized)
      && !/\b(?:na\s+web|na\s+internet|online|tinyfish|firecrawl|git|github|commits?|repositorios?|branch|diff|skills?|habilidades?|ferramentas?)\b/.test(normalized)
      && (
        /\b(busca\w*|procur\w*|pesquis\w*|consult\w*|lembra\w*|record\w*)\b.*\b(memoria|fatos|historico|resumos?|sobre\s+mim|te\s+falei|eu\s+(?:disse|falei|gosto))\b/.test(normalized)
        || /\bo que (?:voce|vc|tu) (?:sabe|lembra)\b/.test(normalized)
      )
    ),
    buildArgs: message => ({ query: extractMemoryQuery(message) }),
  },
  {
    toolName: 'planner.prioritize',
    matches: normalized => /\b(prioriz\w*|orden\w*)\b.*\b(tarefas?|pendencias?|compromissos?|agenda)\b/.test(normalized),
    buildArgs: () => ({}),
  },
  {
    toolName: 'briefing.build',
    matches: normalized => (
      /\bbriefing\b/.test(normalized)
      || /\bresumo\s+(?:do\s+dia|diario)\b/.test(normalized)
    ),
    buildArgs: message => {
      const dateMatch = String(message ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
      return dateMatch ? { date: dateMatch[1] } : {};
    },
  },
  {
    toolName: 'study.review',
    matches: normalized => /\b(revis\w*|resum\w*)\b.*\b(estudos?|aprendizado|revisao espacada)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message);
      const match = /(?:sobre|de)\s+([a-zA-Z0-9À-ÿ _-]{2,80})[?!.]*$/i.exec(clean);
      const topic = match?.[1]?.trim();
      return topic && !/^estudos?$/i.test(topic) ? { topic } : {};
    },
  },
  {
    toolName: 'study.plan',
    matches: normalized => /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?trilha\s+de\s+estudos?\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const match = /trilha\s+de\s+estudos?\s*(?:sobre|de|para)?\s*(.+)$/i.exec(clean);
      return { topic: (match?.[1]?.trim() || clean).slice(0, 160) };
    },
  },
  {
    toolName: 'document.draft',
    matches: normalized => /\b(?:criar|gerar|montar)\s+(?:uma?\s+)?(?:rascunho|documento|nota|checklist|adr)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const norm = normalizeText(clean);
      const format = /\bchecklist\b/.test(norm)
        ? 'checklist'
        : (/\badr\b/.test(norm) ? 'adr' : (/\bresumo\b/.test(norm) ? 'summary' : 'note'));
      const match = /(?:rascunho|documento|nota|checklist|adr)\s*(?:sobre|de|para|com titulo)?\s*(.+)$/i.exec(clean);
      return {
        title: (match?.[1]?.trim() || clean).slice(0, 180),
        format,
      };
    },
  },
  {
    toolName: 'code.inspect',
    matches: normalized => /\b(?:inspecion\w*|ler|ver|mostr\w*)\b.*\b(?:src\/|docs\/|skills\/|desktop\/|usami-desktop\/|package\.json|server\.mjs|cargo\.toml)\b/.test(normalized),
    buildArgs: message => {
      const pathMatch = String(message ?? '').match(/\b((?:(?:usami-)?desktop\/)?(?:src|docs|skills|tests)\/[a-zA-Z0-9._/-]+|(?:(?:usami-)?desktop\/)?Cargo\.toml|(?:(?:usami-)?desktop\/)?README\.md|package\.json|server\.mjs)\b/);
      return { path: pathMatch ? pathMatch[1] : 'package.json' };
    },
  },
  {
    toolName: 'code.search',
    matches: normalized => /\b(?:busc\w*|procur\w*|pesquis\w*)\b.*\b(?:codigo|src\/|docs\/|skills\/|desktop\/|usami-desktop\/)\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const norm = normalizeText(clean);
      const match = /(?:por|sobre|termo|simbolo)\s+([a-zA-Z0-9_.-]{2,80})$/i.exec(clean);
      const args = { query: (match?.[1] || clean).slice(0, 80) };
      if (/\b(?:usami-)?desktop\b/.test(norm)) args.scope = 'desktop';
      return args;
    },
  },
  {
    toolName: 'architect.blueprint',
    matches: normalized => /\b(?:projet\w*|desenh\w*|blueprint)\b.*\bskill\b/.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message).replace(/[?!.]+$/, '').trim();
      const match = /skill\s*(?:de|para|chamada)?\s*(.+)$/i.exec(clean);
      const name = (match?.[1]?.trim() || 'Nova Skill').slice(0, 60);
      return {
        name,
        description: `Skill projetada para ${name}.`,
      };
    },
  },
  {
    toolName: 'calendar.create',
    matches: normalized => CALENDAR_CREATE_RE.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message);
      const titleMatch = /\b(?:evento|compromisso|chamada|reuniao)?\s*["“']([^"”']+)["”']/i.exec(clean)
        || /\b(?:evento|compromisso)\s+([A-Za-z0-9À-ÿ _-]+?)(?:\s+(?:pra|para|hoje|amanha|as|\d{1,2}:))/i.exec(clean);
      const summary = (titleMatch?.[1]?.trim() || clean.replace(/^(?:(?:ok+|por favor|adiciona|marca|cria|agenda)[,\s]+)*/i, '')).slice(0, 80);
      
      const now = new Date();
      const isTomorrow = /\bamanha\b/i.test(clean);
      const targetDate = new Date(now);
      if (isTomorrow) targetDate.setDate(targetDate.getDate() + 1);
      
      const timeMatch = /\b(?:as|às)?\s*(\d{1,2})(?::(\d{2}))?\b/i.exec(clean);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const mins = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        targetDate.setHours(hours, mins, 0, 0);
      } else {
        targetDate.setHours(targetDate.getHours() + 1, 0, 0, 0);
      }
      
      const durationMins = /\bmeia\s+hora\b/i.test(clean)
        ? 30
        : (/\b(\d+)\s*(?:minutos?|min)\b/i.exec(clean) ? parseInt(/\b(\d+)\s*(?:minutos?|min)\b/i.exec(clean)[1], 10) : 60);
      
      const endDate = new Date(targetDate.getTime() + durationMins * 60_000);
      
      return {
        summary: summary || 'Novo evento',
        start: targetDate.toISOString(),
        end: endDate.toISOString(),
      };
    },
  },
  {
    toolName: 'calendar.list',
    matches: normalized => CALENDAR_LIST_RE.test(normalized),
    buildArgs: message => {
      const queryMatch = /\bsobre\s+(.+?)$/i.exec(collapseText(message).replace(/[?!.]+$/, ''));
      const args = { maxResults: 10 };
      if (queryMatch?.[1]) args.query = queryMatch[1].trim().slice(0, 120);
      return args;
    },
  },
  {
    toolName: 'email.list',
    matches: normalized => EMAIL_LIST_RE.test(normalized),
    buildArgs: message => {
      const queryMatch = /\b(?:de|sobre|com)\s+(.+?)$/i.exec(collapseText(message).replace(/[?!.]+$/, ''));
      const args = { maxResults: 10 };
      if (queryMatch?.[1]) args.query = queryMatch[1].trim().slice(0, 120);
      return args;
    },
  },
  {
    toolName: 'finance.accounts',
    matches: normalized => FINANCE_ACCOUNTS_RE.test(normalized),
    buildArgs: () => ({}),
  },
  {
    toolName: 'finance.transactions',
    matches: normalized => FINANCE_TX_RE.test(normalized),
    buildArgs: () => ({ limit: 20 }),
  },
  {
    toolName: 'research.search',
    matches: normalized => !SELF_DESCRIBE_RE.test(normalized) && RESEARCH_SEARCH_RE.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message);
      const provider = /\btinyfish\b/i.test(clean) && !/\bfirecrawl\b/i.test(clean)
        ? 'tinyfish'
        : /\bfirecrawl\b/i.test(clean) && !/\btinyfish\b/i.test(clean)
          ? 'firecrawl'
          : 'both';
      return {
        query: buildResearchQuery(clean),
        provider,
        limit: 5,
      };
    },
  },
  {
    toolName: 'research.fetch',
    matches: normalized => RESEARCH_FETCH_RE.test(normalized),
    buildArgs: message => {
      const urlMatch = /https?:\/\/\S+/.exec(collapseText(message));
      const url = (urlMatch?.[0] || '').replace(/[),.;!?]+$/, '');
      const provider = /\btinyfish\b/i.test(message)
        ? 'tinyfish'
        : /\bfirecrawl\b/i.test(message)
          ? 'firecrawl'
          : 'auto';
      return {
        url,
        provider,
      };
    },
  },
  {
    toolName: 'git.log',
    matches: normalized => GIT_LOG_RE.test(normalized),
    buildArgs: message => {
      const norm = normalizeText(message);
      const target = /\bdesktop\b/.test(norm) ? 'desktop' : (/\bworkspace\b/.test(norm) ? 'workspace' : 'usami');
      return { target, limit: 10 };
    },
  },
  {
    toolName: 'git.diff',
    matches: normalized => GIT_DIFF_RE.test(normalized),
    buildArgs: message => {
      const norm = normalizeText(message);
      const target = /\bdesktop\b/.test(norm) ? 'desktop' : (/\bworkspace\b/.test(norm) ? 'workspace' : 'usami');
      return { target };
    },
  },
  {
    toolName: 'github.repos',
    matches: normalized => GITHUB_REPOS_RE.test(normalized),
    buildArgs: message => {
      const slugMatch = /\b([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/.exec(collapseText(message));
      if (slugMatch?.[1] && !slugMatch[1].startsWith('src/')) {
        return { repo: slugMatch[1] };
      }
      return { limit: 10 };
    },
  },
  {
    toolName: 'git.status',
    matches: normalized => GIT_STATUS_RE.test(normalized),
    buildArgs: message => {
      const norm = normalizeText(message);
      const target = /\bdesktop\b/.test(norm) ? 'desktop' : (/\bworkspace\b/.test(norm) ? 'workspace' : 'usami');
      return { target };
    },
  },
]);

const CONFIRMATION_REPLY_RE = /^(?:(?:ok+|okay|e\s+ai|entao|hm+)[,\s]+)*(?:sim+|s+|yes|yep|yeah|uhum|aham|claro|com certeza|pode(?:\s+sim|\s+(?:pesquisar|buscar|fazer|ver|olhar|ir|mandar))?|por favor|pfv|pls|ok+|okay|beleza|blz|fechou|manda ver|vai la|manda|quero(?:\s+sim)?|faz isso|faca isso|pode ir|bora|ta bom|show|(?:e\s+)?o\s+que\s+(?:(?:voce|vc)\s+)?(?:achou|encontrou|viu|trouxe|deu)|achou\s+o\s+que|ja\s+(?:viu|olhou|achou)|conseguiu\s+(?:ver|olhar|achar)|me\s+(?:diz|fala|mostra|conta)|qual\s+(?:foi\s+)?o\s+resultado|cade)(?:\s+(?:mais\s+detalhes|mais\s+sobre(?:\s+isso)?|mais\s+info\w*|disso|isso|agora))?(?:[,\s]+(?:por favor|sim|pode|usami|va|vai|manda|la))*$/;
const ASSISTANT_OFFER_ACTION_RE = /\b(?:quer(?:e|o)?\s+que\s+eu|posso|devo|vou|deixa\s+eu|(?:ainda\s+)?(?:estou|to)\s+(?:olhando|buscando|pesquisando|verificando|checando))\s*(?:pesquis\w*|busc\w*|procur\w*|consult\w*|chec\w*|ver|olh\w*|list\w*|mostr\w*|confer\w*|d[ae]r\s+uma\s+olhada)?\b|^(?:procurando|buscando|pesquisando|olhando|verificando|checando)\b/;
const GENERIC_RESEARCH_QUERY_RE = /^(?:noticias?|manchetes?|novidades?|isso|agora(?:\s+de\s+verdade)?|de\s+verdade)$|\b(?:que\s+(?:eu\s+)?pedi|consegue\s+ver\s+ela)\b/i;

export const DEFERRED_TOOL_PROMISE_RE = /\b(?:vou\s+(?:dar\s+uma\s+olhada|olh\w*|ver|verificar|chec\w*|confer\w*|busc\w*|pesquis\w*|procur\w*|consult\w*|list\w*|mostrar)|deixa\s+eu\s+(?:ver|olh\w*|chec\w*|busc\w*|pesquis\w*|confer\w*)|(?:ainda\s+)?(?:estou|to)\s+(?:olhando|buscando|pesquisando|verificando|checando)|espera\s+um\s+pouquinho.*(?:olhando|buscando|pesquisando))\b|^(?:procurando|buscando|pesquisando|olhando|verificando|checando)\b/i;

export function isDeferredToolPromise(text) {
  return DEFERRED_TOOL_PROMISE_RE.test(normalizeText(text));
}

function buildResearchQuery(message) {
  const clean = collapseText(message)
    .replace(/[?!.]\s*(?:vou\s+dar\s+uma\s+olhada|espera\s+a[ií]|aguarde).*$/i, '')
    .replace(/[?!.]+$/, '')
    .trim();
  const stripped = clean
    .replace(/^(?:(?:hmph|ah+|e\s+a[ií]|oi+|ei+|ol[aá]|usami|baka|por\s+favor)[,!?\s]+)*/i, '')
    .replace(/^(?:(?:eu\s+)?acabei\s+me\s+distraindo\b[^?!.]*[!?.]\s*)/i, '')
    .replace(/^(?:(?:eu\s+)?quer(?:o|ia)\s+que\s+(?:voc[eê]|vc)|voc[eê]\s+(?:pode|consegue)|pode(?:ria)?|consegue|tenta|tente|me\s+faz\s+o\s+favor\s+de)\s+/i, '')
    .replace(/^(?:quer(?:e|o)?\s+que\s+eu|posso|devo|vou)\s+/i, '')
    .replace(/^(?:o\s+que\s+(?:(?:voc[eê]|vc)\s+)?(?:achou|encontrou|trouxe|viu|descobriu)\s+(?:de|sobre)\s+)/i, '')
    .replace(/^(?:pesquis\w*|busc\w*|procur\w*|googl\w*)(?:\s+(?:na\s+web|na\s+internet|online|via\s+(?:tinyfish|firecrawl)))?\s*(?:sobre|por|de|a\s+respeito\s+de)?\s*/i, '')
    .replace(/\s*,?\s*(?:e|pra|para)\s+(?:depois\s+)?(?:me\s+)?(?:resum\w*|cont\w*|fal\w*|explic\w*|mostr\w*|mand\w*)(?:\s+(?:tudo|isso|pra\s+mim|depois))?$/i, '')
    .replace(/\s+(?:pra|para)\s+(?:voc[eê]|vc|ti|mim)(?:\s+agora)?$/i, '')
    .replace(/\s+(?:na\s+web|na\s+internet|online|via\s+(?:tinyfish|firecrawl)|agora(?:\s+de\s+verdade)?)$/i, '')
    .trim();
  return (stripped || clean).slice(0, 200);
}

const isScheduleGoal = normalized => /\b(semana|agenda|cronograma|tarefas?|compromissos?|prioriz\w*|conflit\w*|rotina)\b/.test(normalized);

function resolveToolCall(message, registry, toolMatchers, hintedToolName, isToolActive = () => true) {
  const normalized = normalizeText(message);

  if (hintedToolName && registry.has(hintedToolName) && isToolActive(hintedToolName)) {
    const matcher = toolMatchers.find(item => item.toolName === hintedToolName);
    if (matcher) return { toolName: hintedToolName, args: matcher.buildArgs(message) };
    const clean = collapseText(message).replace(new RegExp(hintedToolName.replace('.', '\\.'), 'ig'), '').trim() || collapseText(message);
    const spec = registry.get(hintedToolName);
    const firstStringParam = spec?.parameters?.find(param => param.type === 'string' && param.required);
    return {
      toolName: hintedToolName,
      args: firstStringParam ? { [firstStringParam.name]: clean } : {},
    };
  }

  for (const matcher of toolMatchers) {
    if (!registry.has(matcher.toolName) || !isToolActive(matcher.toolName)) continue;
    if (matcher.matches(normalized)) {
      return { toolName: matcher.toolName, args: matcher.buildArgs(message) };
    }
  }
  return null;
}

export function createAgentCore({
  registry,
  executor,
  planner,
  skillCatalog = null,
  classifyWithLlm = null,
  toolMatchers = DEFAULT_TOOL_MATCHERS,
  turnDeadlineMs = DEFAULT_TURN_DEADLINE_MS,
  turnLimit = DEFAULT_TURN_LIMIT,
  now = () => Date.now(),
  onError = message => console.error(message),
} = {}) {
  if (!registry || typeof registry.has !== 'function' || typeof registry.names !== 'function') {
    throw new Error('createAgentCore: registry é obrigatório.');
  }
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('createAgentCore: executor é obrigatório.');
  }
  if (!planner || typeof planner.create !== 'function') {
    throw new Error('createAgentCore: planner é obrigatório.');
  }

  function isToolActive(toolName) {
    if (!registry.has(toolName)) return false;
    if (!skillCatalog || typeof skillCatalog.list !== 'function' || typeof skillCatalog.get !== 'function') {
      return true;
    }
    const items = skillCatalog.list();
    for (const item of items) {
      if (!item.valid) continue;
      const detailed = skillCatalog.get(item.id);
      const tools = detailed?.ok ? detailed.skill?.manifest?.tools : null;
      if (Array.isArray(tools) && tools.includes(toolName)) {
        return detailed.skill.activation?.canActivate === true;
      }
    }
    return true;
  }

  const turns = [];
  const turnsById = new Map();

  function recordTurn(entry) {
    turns.push(entry);
    turnsById.set(entry.id, entry);
    if (turns.length > turnLimit) {
      const removed = turns.shift();
      if (removed) turnsById.delete(removed.id);
    }
    return entry;
  }

  function cloneTurn(entry) {
    return JSON.parse(JSON.stringify(entry));
  }

  async function classifyIntent(message, { signal } = {}) {
    const clean = collapseText(message);
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });

    if (!deterministic.ambiguous || typeof classifyWithLlm !== 'function') {
      return {
        intent: buildIntent({
          kind: deterministic.kind,
          goal: clean,
          confidence: deterministic.confidence,
          origin: 'classifier',
          now,
        }),
        matchedToolName: deterministic.matchedToolName || null,
      };
    }

    const llmAbort = new AbortController();
    const llmTimer = setTimeout(() => llmAbort.abort(), turnDeadlineMs);
    try {
      const llmSignal = signal ? AbortSignal.any([signal, llmAbort.signal]) : llmAbort.signal;
      const llmDecision = await classifyWithLlm({
        message: clean,
        tools: registry.list(),
        signal: llmSignal,
      });
      if (isPlainObject(llmDecision) && INTENT_KINDS.includes(llmDecision.kind)) {
        const confidence = typeof llmDecision.confidence === 'number' && Number.isFinite(llmDecision.confidence)
          ? Math.min(Math.max(llmDecision.confidence, 0), 1)
          : AMBIGUITY_CONFIDENCE_THRESHOLD;
        return {
          intent: buildIntent({
            kind: llmDecision.kind,
            goal: typeof llmDecision.goal === 'string' && llmDecision.goal.trim() ? llmDecision.goal : clean,
            confidence,
            origin: 'llm',
            now,
          }),
          matchedToolName: typeof llmDecision.tool === 'string' ? llmDecision.tool : null,
        };
      }
    } catch (error) {
      onError(`Aviso: classificador LLM falhou no turno (${error?.message || error}); usando fallback determinístico.`);
    } finally {
      clearTimeout(llmTimer);
    }

    return {
      intent: buildIntent({
        kind: deterministic.kind,
        goal: clean,
        confidence: deterministic.confidence,
        origin: 'classifier',
        now,
      }),
      matchedToolName: null,
    };
  }

  async function executeClassified({ turnId, intent, matchedToolName, message, confirmation, origin, startedMs }) {
    if (intent.kind === 'conversation') {
      return {
        id: turnId,
        intent,
        route: 'conversation',
        status: 'idle',
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    if (intent.kind === 'operational') {
      const resolved = resolveToolCall(message, registry, toolMatchers, matchedToolName, isToolActive);
      if (!resolved) {
        return {
          id: turnId,
          intent,
          route: 'unmatched',
          status: 'no_matching_tool',
          missingCapability: true,
          reason: 'nenhuma ferramenta registrada atende esta solicitação operacional',
          createdAt: intent.createdAt,
          durationMs: Math.max(0, now() - startedMs),
        };
      }

      const execution = await executor.execute(resolved.toolName, resolved.args, { origin, confirmation });
      const status = execution.ok
        ? 'executed'
        : (execution.denied ? 'awaiting_confirmation' : 'failed');
      return {
        id: turnId,
        intent,
        route: 'tool',
        status,
        tool: resolved.toolName,
        ...(execution.record ? { execution: execution.record } : {}),
        ...(execution.ok ? { result: execution.result } : {}),
        ...(!execution.ok && execution.errors ? { errors: execution.errors } : {}),
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    if (isToolActive('planner.schedule') && isScheduleGoal(normalizeText(intent.goal || message))) {
      const execution = await executor.execute(
        'planner.schedule',
        { goal: intent.goal },
        { origin, confirmation },
      );
      if (execution.ok) {
        return {
          id: turnId,
          intent,
          route: 'plan',
          status: 'planned',
          tool: 'planner.schedule',
          ...(execution.record ? { execution: execution.record } : {}),
          ...(execution.result.plan ? { plan: execution.result.plan } : {}),
          ...(execution.result.plan?.briefing ? { briefing: execution.result.plan.briefing } : {}),
          schedule: execution.result.schedule,
          conflicts: execution.result.conflicts,
          tasks: execution.result.tasks,
          summary: execution.result.summary,
          createdAt: intent.createdAt,
          durationMs: Math.max(0, now() - startedMs),
        };
      }
      return {
        id: turnId,
        intent,
        route: 'plan',
        status: execution.denied ? 'denied' : 'failed',
        tool: 'planner.schedule',
        ...(execution.record ? { execution: execution.record } : {}),
        ...(!execution.ok && execution.errors ? { errors: execution.errors } : {}),
        createdAt: intent.createdAt,
        durationMs: Math.max(0, now() - startedMs),
      };
    }

    const created = planner.create({ goal: intent.goal, origin: 'planner' });
    return {
      id: turnId,
      intent,
      route: 'plan',
      status: created.ok ? 'planned' : 'failed',
      ...(created.ok ? { plan: created.plan, ...(created.plan.briefing ? { briefing: created.plan.briefing } : {}) } : { errors: created.errors }),
      createdAt: intent.createdAt,
      durationMs: Math.max(0, now() - startedMs),
    };
  }

  /** Processa um turno completo (usado por `POST /api/agent/turn`). */
  async function processTurn(message, { confirmation, origin = 'agent', signal } = {}) {
    const clean = collapseText(message);
    if (clean.length < 1 || clean.length > 2000) {
      return { ok: false, invalidInput: true, error: 'Mensagem inválida (1 a 2000 caracteres).' };
    }
    const startedMs = now();
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const { intent, matchedToolName } = await classifyIntent(clean, { signal });
    const turn = await executeClassified({
      turnId,
      intent,
      matchedToolName,
      message: clean,
      confirmation,
      origin,
      startedMs,
    });
    recordTurn(turn);
    return { ok: true, turn: cloneTurn(turn) };
  }

  /**
   * Integração não-bloqueante para o `/api/chat`: classificação determinística
   * síncrona (<1 ms). Conversas normais devolvem `null` (contrato do chat
   * intacto); pedidos operacionais ou complexos disparam em background e
   * devolvem um resumo compacto para o campo opcional `agentTurn`.
   */
  function dispatchAsync(message, { origin = 'agent' } = {}) {
    const clean = collapseText(message);
    if (!clean) return null;
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });
    if (deterministic.kind === 'conversation' && !(deterministic.ambiguous && typeof classifyWithLlm === 'function')) {
      return null;
    }

    const startedMs = now();
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const provisionalIntent = buildIntent({
      kind: deterministic.kind,
      goal: clean,
      confidence: deterministic.confidence,
      origin: 'classifier',
      now,
    });
    const initialRoute = deterministic.kind === 'complex' ? 'plan' : (deterministic.kind === 'operational' ? 'tool' : 'conversation');
    recordTurn({
      id: turnId,
      intent: provisionalIntent,
      route: initialRoute,
      status: 'queued',
      createdAt: provisionalIntent.createdAt,
    });

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), turnDeadlineMs);
    void (async () => {
      try {
        const classified = deterministic.ambiguous && typeof classifyWithLlm === 'function'
          ? await classifyIntent(clean, { signal: controller.signal })
          : { intent: provisionalIntent, matchedToolName: deterministic.matchedToolName || null };
        const finished = await executeClassified({
          turnId,
          intent: classified.intent,
          matchedToolName: classified.matchedToolName,
          message: clean,
          origin,
          startedMs,
        });
        const existing = turnsById.get(turnId);
        if (existing) Object.assign(existing, finished);
      } catch (error) {
        onError(`Aviso: orquestração assíncrona do turno ${turnId} falhou (${error?.message || error}).`);
        const existing = turnsById.get(turnId);
        if (existing) {
          existing.status = 'failed';
          existing.error = String(error?.message || error);
          existing.durationMs = Math.max(0, now() - startedMs);
        }
      } finally {
        clearTimeout(deadline);
      }
    })();

    return {
      id: turnId,
      kind: provisionalIntent.kind,
      route: initialRoute,
      status: 'queued',
    };
  }

  function findRecentSpecificToolMatch(recent, preferredTool = null, excludeIdx = -1) {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (i === excludeIdx) continue;
      const content = collapseText(recent[i]?.content);
      if (!content) continue;
      const det = classifyDeterministic(content, { toolNames: registry.names() });
      const res = resolveToolCall(content, registry, toolMatchers, det.matchedToolName || null, isToolActive);
      if (!res) continue;
      if (preferredTool && res.toolName !== preferredTool) continue;
      if (res.toolName === 'research.search' && GENERIC_RESEARCH_QUERY_RE.test(normalizeText(res.args?.query || ''))) continue;
      return { ...res, goal: content };
    }
    return null;
  }

  function resolveFromHistoryConfirmation(clean, history) {
    if (!Array.isArray(history) || history.length === 0) return null;
    const recent = history.slice(-16).filter(item => item && typeof item.content === 'string' && collapseText(item.content));
    if (recent.length === 0) return null;

    let lastAssistantIdx = -1;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (recent[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return null;

    const lastAssistantContent = collapseText(recent[lastAssistantIdx].content);
    const normalizedReply = normalizeText(clean.replace(/[?!.]+$/, ''));
    if (!CONFIRMATION_REPLY_RE.test(normalizedReply)) return null;
    if (!ASSISTANT_OFFER_ACTION_RE.test(normalizeText(lastAssistantContent))) return null;

    const directDet = classifyDeterministic(lastAssistantContent, { toolNames: registry.names() });
    const directRes = resolveToolCall(lastAssistantContent, registry, toolMatchers, directDet.matchedToolName || null, isToolActive);
    if (directRes) {
      if (directRes.toolName === 'research.search' && GENERIC_RESEARCH_QUERY_RE.test(normalizeText(directRes.args?.query || ''))) {
        const specific = findRecentSpecificToolMatch(recent, 'research.search', lastAssistantIdx);
        if (specific) return specific;
      }
      return { ...directRes, goal: lastAssistantContent };
    }

    if (/\b(?:pesquis\w*|bus(?:c|qu)\w*|procur\w*|olh\w*|chec\w*)\b/.test(normalizeText(lastAssistantContent))) {
      return findRecentSpecificToolMatch(recent, null, lastAssistantIdx);
    }
    return null;
  }

  async function runOperationalForChat(message, { origin = 'agent', timeoutMs = 8000, history = [] } = {}) {
    const clean = collapseText(message);
    if (!clean) return null;
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });
    let resolved = deterministic.kind === 'operational'
      ? resolveToolCall(clean, registry, toolMatchers, deterministic.matchedToolName || null, isToolActive)
      : null;
    let intentGoal = clean;
    let intentConfidence = deterministic.confidence;

    if (resolved && resolved.toolName === 'research.search' && GENERIC_RESEARCH_QUERY_RE.test(normalizeText(resolved.args?.query || '')) && Array.isArray(history) && history.length > 0) {
      const recent = history.slice(-16).filter(item => item && typeof item.content === 'string' && collapseText(item.content));
      const specific = findRecentSpecificToolMatch(recent, 'research.search');
      if (specific?.args?.query) {
        resolved = { ...resolved, args: { ...resolved.args, query: specific.args.query } };
      }
    }

    if (!resolved) {
      const confirmed = resolveFromHistoryConfirmation(clean, history);
      if (!confirmed) return null;
      resolved = { toolName: confirmed.toolName, args: confirmed.args };
      intentGoal = confirmed.goal || clean;
      intentConfidence = 0.85;
    }

    const spec = registry.get(resolved.toolName);
    if (!spec || spec.permissionLevel > 3) return null;

    const startedMs = now();
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const intent = buildIntent({
      kind: 'operational',
      goal: intentGoal,
      confidence: intentConfidence,
      origin: 'classifier',
      now,
    });

    let execution;
    let timerId = null;
    try {
      const timeoutPromise = new Promise(resolve => {
        timerId = setTimeout(
          () => resolve({ ok: false, errors: ['tempo limite da ferramenta atingido no chat'] }),
          Math.max(500, timeoutMs),
        );
      });
      execution = await Promise.race([
        executor.execute(resolved.toolName, resolved.args, { origin }),
        timeoutPromise,
      ]);
    } catch (error) {
      execution = { ok: false, errors: [String(error?.message || error)] };
    } finally {
      if (timerId) clearTimeout(timerId);
    }

    const status = execution?.ok
      ? 'executed'
      : (execution?.denied ? 'awaiting_confirmation' : 'failed');
    const turn = {
      id: turnId,
      intent,
      route: 'tool',
      status,
      tool: resolved.toolName,
      ...(execution?.record ? { execution: execution.record } : {}),
      ...(execution?.ok ? { result: execution.result } : {}),
      ...(!execution?.ok && execution?.errors ? { errors: execution.errors } : {}),
      createdAt: intent.createdAt,
      durationMs: Math.max(0, now() - startedMs),
    };
    recordTurn(turn);
    return cloneTurn(turn);
  }

  function listTurns({ limit = 20 } = {}) {
    const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), turnLimit) : 20;
    return turns.slice(-max).reverse().map(cloneTurn);
  }

  function getTurn(id) {
    if (typeof id !== 'string' || !/^trn-[0-9a-f]{12}$/.test(id)) return { ok: false, notFound: true };
    const found = turnsById.get(id);
    if (!found) return { ok: false, notFound: true };
    return { ok: true, turn: cloneTurn(found) };
  }

  return {
    classifyIntent,
    processTurn,
    runOperationalForChat,
    dispatchAsync,
    listTurns,
    getTurn,
  };
}

function formatSelfDescribeForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const activeSkills = Array.isArray(result.skills)
    ? result.skills.filter(s => s?.activation?.canActivate || s?.state === 'active')
    : [];
  const activeTools = Array.isArray(result.tools)
    ? result.tools.filter(t => t?.active).map(t => t.name)
    : [];
  return {
    summary: result.summary,
    skills: activeSkills.map(s => ({
      id: s.id,
      ...(s.description ? { description: String(s.description).slice(0, 90) } : {}),
    })),
    tools: activeTools,
    ...(Array.isArray(result.integrations) ? { integrations: result.integrations } : {}),
    limitations: Array.isArray(result.limitations) ? result.limitations.slice(0, 3) : [],
    recentErrorsCount: Number(result.recentErrors?.totalFailures || 0),
  };
}

function formatResearchSearchForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const items = Array.isArray(result.results)
    ? result.results.slice(0, 5).map(item => ({
      title: String(item?.title || '').slice(0, 140),
      url: String(item?.url || '').slice(0, 180),
      ...(item?.snippet ? { snippet: String(item.snippet).slice(0, 220) } : {}),
    }))
    : [];
  return {
    query: result.query,
    count: Number(result.count ?? items.length),
    results: items,
    ...(result.partialErrors ? { partialErrors: result.partialErrors } : {}),
  };
}

function formatGithubReposForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const repos = Array.isArray(result.repositories)
    ? result.repositories
    : (Array.isArray(result.repos) ? result.repos : []);
  if (isPlainObject(result.repository)) {
    const r = result.repository;
    return {
      repository: {
        name: r.fullName || r.name,
        description: r.description ? String(r.description).slice(0, 120) : null,
        language: r.language || null,
      },
    };
  }
  return {
    count: repos.length,
    repositories: repos.slice(0, 5).map(r => ({
      name: r.fullName || r.name,
      description: r.description ? String(r.description).slice(0, 100) : null,
      language: r.language || null,
    })),
  };
}

function formatGitStatusForPrompt(result) {
  if (!isPlainObject(result)) return null;
  return {
    branch: result.branch,
    target: result.target,
    staged: Array.isArray(result.staged) ? result.staged.slice(0, 6) : [],
    modified: Array.isArray(result.modified) ? result.modified.slice(0, 6) : [],
    untracked: Array.isArray(result.untracked) ? result.untracked.slice(0, 6) : [],
  };
}

export function formatAgentTurnPromptContext(turn, { maxChars = 1800 } = {}) {
  if (!turn || typeof turn !== 'object' || turn.route !== 'tool' || !turn.tool) return '';
  if (turn.status === 'executed') {
    const payload = turn.tool === 'self.describe'
      ? (formatSelfDescribeForPrompt(turn.result) ?? turn.result ?? {})
      : turn.tool === 'research.search'
        ? (formatResearchSearchForPrompt(turn.result) ?? turn.result ?? {})
        : turn.tool === 'github.repos'
          ? (formatGithubReposForPrompt(turn.result) ?? turn.result ?? {})
          : turn.tool === 'git.status'
            ? (formatGitStatusForPrompt(turn.result) ?? turn.result ?? {})
            : (turn.result ?? {});
    let serialized = '';
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = String(turn.result ?? '');
    }
    const clean = redactSecrets(serialized).slice(0, maxChars);
    const extraRule = turn.tool === 'self.describe'
      ? ' Confirme diretamente quais skills/ferramentas reais você possui usando essa lista (nunca diga que não sabe nem peça ao usuário para contar o que mudou).'
      : '';
    return `\n\n=== RESULTADO DA SKILL EXECUTADA AGORA (${turn.tool}) ===\nDados reais obtidos:\n${clean}\nInstrução: responda diretamente usando esses dados reais obtidos agora (sem inventar números ou fatos ausentes), mantendo seu jeito natural e conciso (1 a 2 frases objetivas em "reply").${extraRule}`;
  }
  const errDetail = redactSecrets(
    String(turn.execution?.reason || (Array.isArray(turn.errors) ? turn.errors.join('; ') : 'falha ao executar ferramenta')).slice(0, 300),
  );
  return `\n\n=== FALHA NA SKILL EXECUTADA AGORA (${turn.tool}) ===\nMotivo: ${errDetail}\nInstrução: seja honesta e diga ao usuário que tentou usar ${turn.tool}, mas ocorreu esse erro — nunca invente dados.`;
}

export function formatExecutedTurnFallbackReply(turn) {
  if (!turn) return null;
  if (turn.status !== 'executed' || !turn.result) {
    const errDetail = redactSecrets(
      String(turn.execution?.reason || (Array.isArray(turn.errors) ? turn.errors.join('; ') : 'falha ao executar ferramenta')).slice(0, 180),
    );
    return `Tentei usar ${turn.tool || 'a ferramenta'} agora, mas falhou: ${errDetail}`;
  }
  const r = turn.result;
  if (turn.tool === 'self.describe') {
    const skills = Array.isArray(r.skills)
      ? r.skills.filter(s => s?.activation?.canActivate || s?.state === 'active').map(s => s.id)
      : [];
    return skills.length > 0
      ? `Claro que sei! Estou com ${skills.length} skills ativas agora: ${skills.slice(0, 6).join(', ')}...`
      : (r.summary || 'Consultei meu sistema e minhas ferramentas estão ativas.');
  }
  if (turn.tool === 'finance.accounts' && Array.isArray(r.accounts)) {
    const list = r.accounts.slice(0, 3).map(a => `${a.name || a.type || 'Conta'}: ${a.balance ?? '-'} ${a.currencyCode || 'BRL'}`);
    return list.length ? `Conferi suas contas no Open Finance: ${list.join('; ')}.` : 'Consultei o Open Finance, mas não encontrei contas listadas.';
  }
  if (turn.tool === 'finance.transactions' && Array.isArray(r.transactions)) {
    const list = r.transactions.slice(0, 3).map(t => `${t.description || t.category || 'Transação'}: ${t.amount ?? '-'}`);
    return list.length ? `Últimas transações no Open Finance: ${list.join('; ')}.` : 'Consultei o extrato no Open Finance e não há transações nesse período.';
  }
  if (turn.tool === 'calendar.create' && r.event) {
    const title = r.event.summary || 'Evento';
    const time = r.event.start?.dateTime || r.event.start?.date || '';
    return `Criei o evento "${title}" no seu Google Calendar${time ? ` para ${time}` : ''}!`;
  }
  if (turn.tool === 'calendar.list' && Array.isArray(r.events)) {
    const list = r.events.slice(0, 3).map(e => e.summary || '(sem título)');
    return list.length ? `Na sua agenda encontrei: ${list.join(', ')}.` : 'Olhei sua agenda e não há eventos nesse filtro.';
  }
  if (turn.tool === 'email.list' && Array.isArray(r.messages)) {
    const list = r.messages.slice(0, 2).map(m => m.subject || m.from || '(sem assunto)');
    return list.length ? `Encontrei ${r.messages.length} e-mail(s), incluindo: ${list.join('; ')}.` : 'Olhei sua caixa de entrada e não há mensagens nesse filtro.';
  }
  if (turn.tool === 'memory.search' && Array.isArray(r.results)) {
    const list = r.results.slice(0, 3).map(item => item.text).filter(Boolean);
    return list.length
      ? `Achei na memória (${r.results.length}): ${list.join(' | ').slice(0, 180)}`
      : 'Consultei minha memória e não achei registros sobre isso.';
  }
  if (turn.tool === 'research.search' && Array.isArray(r.results)) {
    const top = r.results.slice(0, 2).map(item => item.title || item.url).filter(Boolean);
    return top.length ? `Pesquisei na web e achei ${r.results.length} resultado(s), como: ${top.join('; ')}.` : 'Fiz a pesquisa na web, mas não vieram resultados.';
  }
  if (turn.tool === 'git.status' && typeof r.branch === 'string') {
    const dirty = (r.staged?.length || 0) + (r.modified?.length || 0) + (r.untracked?.length || 0);
    const head = r.head?.hash ? ` (commit ${r.head.hash})` : '';
    return `Git (${r.target || 'usami'}): branch ${r.branch}${head}, ${dirty} alteração(ões) pendente(s).`;
  }
  if (turn.tool === 'git.log' && Array.isArray(r.commits)) {
    const list = r.commits.slice(0, 3).map(c => `${c.hash || ''} ${c.subject || ''}`.trim());
    return list.length ? `Últimos commits (${r.target || 'usami'}): ${list.join(' | ')}.` : 'Não encontrei commits recentes.';
  }
  if (turn.tool === 'github.repos') {
    const repos = Array.isArray(r.repositories) ? r.repositories : (Array.isArray(r.repos) ? r.repos : []);
    const list = repos.slice(0, 4).map(repo => repo.fullName || repo.name).filter(Boolean);
    return list.length ? `Seus repositórios no GitHub: ${list.join(', ')}.` : 'Consultei o GitHub, mas não encontrei repositórios.';
  }
  if (typeof r.summary === 'string' && r.summary.trim()) {
    return redactSecrets(r.summary).slice(0, 210);
  }
  return `Já executei ${turn.tool} com sucesso e peguei os dados, mas o modelo engasgou ao formular a fala.`;
}
