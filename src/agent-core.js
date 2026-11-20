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
// Link compartilhado: sem verbo explícito de extração, o comportamento
// esperado é abrir a página — não tratá-la como se fosse só texto.
const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const DISCORD_ENVELOPE_RE = /^\[Discord\s*\|[^\]]+\]:\s*/i;
const LINK_READ_VERB_RE = /\b(?:extrai\w*|ler|leia|scrape|fetch|abr\w*|acess\w*|olh\w*|veja|ver|v[eê]|confer\w*|chec\w*|resum\w*|explic\w*|analis\w*|coment\w*|avali\w*)\b/;
const LINK_CONTEXT_FILLER_RE = /\b(?:olha|olhe|veja|ver|v[eê]|confere|confira|checa|cheque|d[aá]|uma|olhada|nisso|nessa|nesse|isso|isto|aqui|link|url|segue|manda|mande|mandando|compartilhando|achei|encontrei|encontrado|s[oó]|ai|a[ií]|mano|usami|ei|oi|por favor|pfv|que|esse|essa|este|esta|um|uma|o|a|os|as|de|do|da|dos|das|em|no|na|nos|nas|pra|para|pro|mim|te|vc|voc[eê]|tu)\b/gi;
const GIT_LOG_RE = /\b(?:commits?|historico|log)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?)\b|\b(?:ultimos?|recentes?)\s+commits?\b|\bcommit\s+[a-f0-9]{4,40}\b|\b(?:como\s+ficou|o\s+que\s+(?:mudou|foi\s+feito|foi\s+alterado))\s+(?:no\s+c[oó]digo|no\s+repo|no\s+git|no\s+projeto)\b|\b(?:olha|veja?|da\s+uma\s+olhada)\s+(?:no\s+c[oó]digo|nos\s+commits?|no\s+refactor|no\s+commit)\b/i;
const GIT_DIFF_RE = /\b(?:diff|mudancas?|alteracoes)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?|locais?|pendentes?)\b|\bo que (?:esta|tem) (?:modificado|alterado)\b/;
const GITHUB_REPOS_RE = /\b(?:list\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|quais(?:\s+sao)?|como\s+(?:esta|ta|estao))\b.*\b(?:repositorios?(?:\s+(?:no\s+|do\s+)?github)?|github)\b|\b(?:meus\s+repositorios?|repositorios?\s+do\s+github)\b/;
const GITHUB_ISSUE_RE = /\b(?:cria\w*|abre|abrir|abra|registra\w*|manda\w*|enviar?)\b.*\b(?:issues?|tarefas?|propostas?|tickets?)\b.*\b(?:no\s+github|pro\s+github|no\s+repo(?:sitorio)?)\b|\b(?:no\s+github|pro\s+github)\b.*\b(?:cria\w*|abre|abrir|abra|registra\w*)\b.*\b(?:issues?|tarefas?|propostas?)\b|\b(?:cria\w*|abre|abrir|abra|registra\w*|manda\w*|enviar?)\b.*\bissues?\b/;
const GITHUB_CREATE_REPO_RE = /\b(?:cria\w*|adiciona\w*|gerar?|fazer?)\b.*\b(?:reposit[oó]rios?|repos?|readme\s+(?:s[oó]\s+)?pra\s+(?:voc[eê]|vc|ti|perfil)|readme\s+(?:no\s+seu|do\s+seu)\s+(?:perfil|github)|perfil\s+no\s+github)\b|\b(?:no\s+seu\s+github|pro\s+seu\s+perfil|pra\s+voc[eê]\s+no\s+github)\b.*\b(?:cria\w*|adiciona\w*|gerar?|readme)\b/i;
const IS_COMPLETION_OR_INSPECT_RE = /\b(?:como\s+ficou|finalizei|conclu[ií]|terminei|apliquei|comitei|ja\s+(?:fiz|apliquei|comitei))\b|\b(?:da\s+uma\s+olhada|olh\w*|veja?|mostr\w*)\s+(?:no\s+c[oó]digo|no\s+repo|no\s+commit|nos\s+commits|como\s+ficou)\b/i;
// Verbos de ação explícitos: "sugestão" é substantivo e não pode transformar
// uma pergunta sobre sugestões em proposta de código (issue automática).
const CODE_PROPOSE_RE = /\b(?:propo(?:nha|r|sta|e|em|stas?)?|sugir\w*|suger\w*|manda\w*|envi\w*|ped\w*|cri\w*|pass\w*)\b.*\b(?:melhoria\w*|mudanca\w*|alteracao|alteracoes|correcao|correcoes|fix|feature\w*|tarefa\w*|proposta\w*|codigo|funcao|retry|cache|modulo|skill|readme|documentacao)\b|\b(?:codigo|sistema|repo(?:sitorio)?)\b.*\b(?:sugest\w*|melhoria\w*|proposta\w*|ajust\w*|otimiz\w*)\b|\b(?:sugir\w*|suger\w*|manda\w*|envi\w*|ped\w*|pass\w*|repass\w*)\b.*\b(?:code\s*agent|coding\s*agent|agente|antigravity|claude|qoder|cursor)\b|\b(?:pass\w*|repass\w*|mand\w*|envi\w*)\b.*\b(?:(?:essa|esta|a)\s+)?(?:issue|tarefa|demanda|correcao|fix)\b|\b(?:code\s*agent|coding\s*agent|antigravity|claude\s*code|qoder|cursor)\b.*\b(?:faz\w*|cri\w*|arrum\w*|implement\w*|ajust\w*|propo\w*|suger\w*|mand\w*|adicion\w*|coloc\w*)\b|\b(?:proposta\s+de\s+codigo|proposta\s+para\s+(?:o\s+)?(?:agente|code\s*agent|coding\s*agent|antigravity))\b/i;
const CODE_PROPOSALS_QUERY_RE = /\b(?:quais|lista\w*|mostr\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|cade|o que (?:voce|vc|tu) (?:mandou|enviou|propos))\b.*\b(?:propostas?|sugestoes?)\b|\b(?:ja\s+mandou|mandou\s+mesmo|enviou\s+mesmo|mandou\s+o\s+que|o\s+que\s+foi\s+enviado)\b|\b(?:tem|ha|teria)\s+(?:(?:mais|outra?|algumas?)\s+)*(?:sugest\w*|melhoria\w*|proposta\w*|ideia\w*)\b|\b(?:code\s*agent|coding\s*agent|agente|antigravity)\b.*\b(?:ligado|online|ativo|trabalhando|pegou|recebeu|andamento)\b|\b(?:ver|v[eê]|veja|confer\w*|chec\w*)\b.*\b(?:se\s+(?:o\s+)?(?:code\s*agent|agente))\b/i;
// Pergunta sobre sugestões nunca é pedido para abrir proposta/issue.
const SUGGESTION_INQUIRY_RE = /\b(?:tem|ha|teria)\s+(?:(?:mais|outra?|algumas?)\s+)*(?:sugest\w*|melhoria\w*|proposta\w*|ideia\w*)\b/i;

const ANAPHORIC_TITLE_RE = /^(?:isso|isto|aquilo|essa|esse|esse\s+problema|essa\s+ideia|o\s+problema|a\s+ideia)$/;

function cleanTitleFragment(raw) {
  const withoutContext = String(raw ?? '')
    .replace(/\b(?:no|pro|para\s+o)\s+github\b/gi, ' ')
    .replace(/\bno\s+repo(?:sitorio)?\b/gi, ' ')
    .replace(/\b(?:pro|para\s+o)\s+(?:code|coding)\s*agent\b/gi, ' ')
    .replace(/\b(?:pro|para\s+o)\s+agente\b/gi, ' ')
    .replace(/\b(?:pro|para\s+o)\s+(?:antigravity|claude(?:\s+code)?|qoder|cursor)\b/gi, ' ')
    .replace(/(?:pra|para|pro)\s+(?:(?:mim|eu)\s+)?nao\s+esquecer\b.*$/i, ' ');
  return collapseText(withoutContext)
    .replace(/^[\s"“'\-–—:;,.]+/, '')
    .replace(/[\s"”'?!.,;:]+$/, '')
    .replace(/^(?:(?:pra|pro|para|sobre|de|do|da|dos|das|no|na|nos|nas|em|um|uma|chamada|chamado|o|a|os|as|seu|sua|teu|tua|voce|vc|tu)\b[\s,:-]*)+/i, '');
}

// Sem título concreto não há proposta: o caller deve conversar em vez de abrir
// issue com frase solta ("pro seu codigo?") — ver deriveTitle.
function fallbackTitleFromMessage(normalized, stopIndex) {
  const head = stopIndex > 0 ? normalized.slice(0, stopIndex) : normalized;
  const withoutRequest = head.replace(/[.!?]?\s*(?:e\s+)?(?:pode|poderia|consegue|quer|vai|da|faz)\b[^.!?]*[.!?]?\s*$/, ' ');
  const cleaned = cleanTitleFragment(withoutRequest);
  if (cleaned.length < 12) return null;
  if (cleaned.length <= 100) return cleaned;
  const cut = cleaned.slice(0, 100);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim();
}

function deriveIssueTitle(message) {
  const normalized = normalizeText(message);
  const marker = /\b(?:issues?|tarefas?|tickets?)\b/.exec(normalized);
  if (!marker) return null;
  const fragment = cleanTitleFragment(normalized.slice(marker.index + marker[0].length));
  if (fragment.length >= 4 && !ANAPHORIC_TITLE_RE.test(fragment)) return fragment.slice(0, 180);
  return fallbackTitleFromMessage(normalized, marker.index);
}

function deriveProposalTitle(message) {
  const normalized = normalizeText(message);
  const match = /(?:proposta|melhoria|tarefa|feature|mudanca|fix|sugestao|issue|adicionar|sugerir|criar|passar|passa)(?:\s+de|\s+para|\s+um|\s+uma|\s+chamada|\s*:\s*)?\s*["']?([^"'\n]+?)["']?(?:\s+pro\s+agente|\s+pro\s+code\s*agent|\s+pro\s+coding\s*agent|\s*$)/i.exec(normalized);
  let fragment = match ? cleanTitleFragment(match[1]) : '';
  if (fragment.length < 5 || ANAPHORIC_TITLE_RE.test(fragment)) {
    fragment = cleanTitleFragment(normalized
      .replace(/^.*?\b(?:code|coding)\s*agent\b\s*/i, '')
      .replace(/^.*?\b(?:antigravity|claude(?:\s+code)?|qoder|cursor)\b\s*/i, '')
      .replace(/^(?:(?:por\s+favor|usami|ei|oi)[,\s]+)*(?:manda|mande|enviar|envie|pede|peca|sugira|sugere|proponha|propoe|cria|crie|criar|adiciona|adicionar|passa|passe|passar)\b\s*/i, ''));
  }
  if (fragment.length < 3 || ANAPHORIC_TITLE_RE.test(fragment)) {
    if (/\b(?:issue|tarefa|fix|correcao|proposta)\b/i.test(normalized)) {
      return 'Encaminhamento de tarefa para o Code Agent';
    }
    return null;
  }
  return fragment.slice(0, 180);
}
const GIT_STATUS_RE = /\b(?:status|branch|estado|situacao)\s+(?:do\s+|no\s+)?(?:git|repo(?:sitorio)?(?:\s+local)?|projeto)\b|\b(?:em\s+qual|qual)\s+(?:a\s+)?branch\b|\b(?:mostr\w*|us\w*|test\w*|execut\w*|rod\w*|acion\w*|ver|v[eê]|veja|consult\w*|chec\w*|confer\w*|olh\w*|como\s+(?:esta|ta)|da\s+uma\s+olhada)\b.*\b(?:git-assistant|git\s+assistant|status\s+do\s+git|meu\s+git|repo|repositorio|projeto)\b|\b(?:ver|v[eê]|veja|olh\w*|chec\w*|confer\w*|da\s+uma\s+olhada)\b.*\b(?:repos?|repositorios?|arquivos?|mudancas?|commits?|alteracoes)?\s*(?:locais|local|do\s+core|do\s+desktop)\b/i;
const SPOTIFY_NOW_PLAYING_RE = /\b(?:o que|oq|que musica|qual musica|qual som)\s+(?:(?:eu|vc|voce|a gente)\s+)?(?:(?:ta|esta|estava|to|estou)\s+)?(?:tocando|ouvindo|escutando|rolando)\b|\b(?:musica\s+atual|tocando\s+agora|ouvindo\s+agora)\b|\bspotify\b.*\b(?:tocando|ouvindo|atual|agora|status)\b/i;
const SPOTIFY_STATS_RE = /\b(?:last\.?fm|scrobbles?|estatisticas?\s+(?:do\s+)?spotify|resumo\s+musical|historico\s+(?:do\s+)?spotify)\b|\b(?:top|mais\s+ouvid\w*|mais\s+tocad\w*|tenho\s+ouvido|ouvi\s+mais)\b.*\b(?:musicas?|faixas?|artistas?|spotify)\b|\b(?:musicas?|faixas?|artistas?)\s+(?:\w+\s+){0,2}mais\s+(?:ouvi|escu\w*|toquei)\b/i;
const SPOTIFY_PLAYLISTS_RE = /\b(?:minhas?|ver|mostr\w*|list\w*)\s+playlists?\b|\bspotify\b.*\bplaylists?\b/i;
const SPOTIFY_SEARCH_RE = /\b(?:busca|buscar|procura|procurar|pesquisa|pesquisar)\b.*\b(?:no\s+spotify|spotify|musica|faixa|artista|album|playlist)\b/i;
const SPOTIFY_CONTROL_RE = /\b(?:toca|tocar|toque|coloca|colocar|coloque|poe|por|da play|play|pausa|pausar|pause|para|parar|retoma|retomar|continua|continuar|proxima|proximo|pula|pular|avanca|avancar|volta|voltar|anterior|volume|abaixa|aumenta|aleatorio|shuffle)\b.*\b(?:spotify|musica|faixa|som|playlist|volume)\b|\bspotify\b.*\b(?:toca|tocar|play|pausa|pausar|pause|proxima|pular|anterior|volta|volume|shuffle)\b|\b(?:pausa|pausar|proxima|pula|anterior)\s+(?:a\s+)?(?:musica|faixa)\b/i;
const SELF_DESCRIBE_RE = /\b(?:quais|lista\w*|mostr\w*|descrev\w*|resum\w*|explic\w*|sab\w*|conhec\w*|tem|ganh\w*|receb\w*)\b.*\b(?:ferramentas?|skills?|habilidades?|modulos?|limitacoes?|integracoes?|capacidades?|arquitetura|novidades?|erros?\s+recentes?)\b|\b(?:novas?|novos?|recentes?)\s+(?:skills?|habilidades?|ferramentas?|capacidades?|integracoes?)\b|\b(?:skills?|habilidades?|ferramentas?)\s+(?:novas?|novos?|atuais|disponiveis|ativas|instaladas)\b|\b(?:o que (?:voce|vc|tu) (?:tem|faz|sabe fazer|consegue fazer)|o que mudou(?:\s+em\s+(?:voce|vc|tu))?|suas? limitacoes?|seu status|sua arquitetura)\b/;

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
  GITHUB_CREATE_REPO_RE,
  GITHUB_ISSUE_RE,
  CODE_PROPOSE_RE,
  CODE_PROPOSALS_QUERY_RE,
  GIT_STATUS_RE,
  CALENDAR_CREATE_RE,
  CALENDAR_LIST_RE,
  EMAIL_LIST_RE,
  FINANCE_ACCOUNTS_RE,
  FINANCE_TX_RE,
  RESEARCH_SEARCH_RE,
  RESEARCH_FETCH_RE,
  SPOTIFY_NOW_PLAYING_RE,
  SPOTIFY_STATS_RE,
  SPOTIFY_PLAYLISTS_RE,
  SPOTIFY_SEARCH_RE,
  SPOTIFY_CONTROL_RE,
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

/**
 * Classificação unificada de intenção: combina determinístico + LLM opcional.
 * 
 * Este é o ponto de entrada único para classificação de intenção, substituindo
 * o uso separado de `classifyDeterministic` e `classifyIntentWithLlm`.
 * 
 * @param {string} message - Mensagem do usuário
 * @param {Object} options
 * @param {Function} options.classifyWithLlm - Função LLM opcional (ex: classifyIntentWithLlm)
 * @param {string[]} options.toolNames - Nomes das ferramentas disponíveis para matching
 * @param {AbortSignal} options.signal - Sinal de abortamento
 * @param {number} options.turnDeadlineMs - Prazo máximo para classificação LLM
 * @param {Function} options.now - Função de timestamp (para testes)
 * @param {Function} options.onError - Callback de erro
 * @returns {Promise<{intent, matchedToolName, deterministic, llmDecision?}>}
 */
export async function classifyIntentUnified(message, options = {}) {
  const {
    classifyWithLlm = null,
    toolNames = [],
    signal = null,
    turnDeadlineMs = 8000,
    now = Date.now,
    onError = console.warn,
  } = options;

  const clean = collapseText(message);
  const deterministic = classifyDeterministic(clean, { toolNames });

  // Fast path: se não é ambíguo OU não tem LLM, usa só determinístico
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
      deterministic,
      llmDecision: null,
    };
  }

  // Caso ambíguo com LLM disponível: roda LLM com timeout
  const llmAbort = new AbortController();
  const llmTimer = setTimeout(() => llmAbort.abort(), turnDeadlineMs);
  try {
    const llmSignal = signal ? AbortSignal.any([signal, llmAbort.signal]) : llmAbort.signal;
    const llmDecision = await classifyWithLlm({
      message: clean,
      tools: toolNames.map(name => ({ name })), // formato compatível
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
        deterministic,
        llmDecision,
      };
    }
  } catch (error) {
    onError(`Aviso: classificador LLM falhou (${error?.message || error}); usando fallback determinístico.`);
  } finally {
    clearTimeout(llmTimer);
  }

  // Fallback para determinístico
  return {
    intent: buildIntent({
      kind: deterministic.kind,
      goal: clean,
      confidence: deterministic.confidence,
      origin: 'classifier',
      now,
    }),
    matchedToolName: null,
    deterministic,
    llmDecision: null,
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
    toolName: 'spotify.now_playing',
    matches: normalized => SPOTIFY_NOW_PLAYING_RE.test(normalized),
    buildArgs: () => ({}),
  },
  {
    toolName: 'spotify.stats',
    matches: normalized => SPOTIFY_STATS_RE.test(normalized),
    buildArgs: (_message, normalized) => {
      let period = '7d';
      if (/\b(?:hoje|24h|ultimo dia)\b/.test(normalized)) period = '24h';
      else if (/\b(?:mes|30\s*dias)\b/.test(normalized)) period = '30d';
      else if (/\b(?:sempre|geral|todo\s+tempo|tudo)\b/.test(normalized)) period = 'all';
      return { period, limit: 5 };
    },
  },
  {
    toolName: 'spotify.playlists',
    matches: normalized => SPOTIFY_PLAYLISTS_RE.test(normalized),
    buildArgs: () => ({ limit: 15 }),
  },
  {
    toolName: 'spotify.similar',
    matches: normalized => /\b(?:semelhante|semelhantes|parecida|parecidas|parecido|parecidos|similar|similares)\b/.test(normalized)
      && (/\b(?:musica|musicas|som|tocar|ouvir|artista|banda|spotify|playlist)\b/.test(normalized) || /\b(?:dele|dela|deles)\b/.test(normalized)),
    buildArgs: (message, normalized) => {
      const match = /\b(?:semelhante[s]?\s+a[os]?|parecida[s]?\s+com|parecido[s]?\s+com|estilo)\s+([^,?.!]+)/i.exec(message);
      let artist = match ? match[1].trim() : '';
      if (!artist || /\b(?:ele|ela|dele|dela)\b/i.test(artist)) {
        const artistMatch = /\b(?:do|da|artista|cantor[a]?)\s+([A-Z][a-zA-Z0-9_\s]+)/.exec(message);
        if (artistMatch) artist = artistMatch[1].trim();
      }
      return { artist: artist || 'Omar Varela', play: true, limit: 10 };
    },
  },
  {
    toolName: 'spotify.search',
    matches: normalized => SPOTIFY_SEARCH_RE.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message)
        .replace(/^\[[^\]]{1,60}\]:\s*/, '')
        .replace(/^(?:usami[,\s]+)?(?:busca|buscar|procura|procurar|pesquisa|pesquisar)\s+(?:por\s+|a\s+musica\s+|musica\s+)?/i, '')
        .replace(/\b(?:no|do)\s+spotify\b/gi, '')
        .replace(/\b(?:pra|para)\s+mim\b/gi, '')
        .replace(/\bpor\s+favor\b/gi, '')
        .replace(/[?!.]+$/, '')
        .trim();
      return { query: clean.slice(0, 180) || collapseText(message).slice(0, 180), type: 'track', limit: 5 };
    },
  },
  {
    toolName: 'spotify.control',
    matches: normalized => SPOTIFY_CONTROL_RE.test(normalized),
    buildArgs: (message, normalized) => {
      if (/\b(?:pausa|pausar|pause|para|parar)\b/.test(normalized)) return { action: 'pause' };
      if (/\b(?:proxima|proximo|pula|pular|avanca|avancar)\b/.test(normalized)) return { action: 'next' };
      if (/\b(?:volta|voltar|anterior)\b/.test(normalized)) return { action: 'previous' };
      if (/\b(?:shuffle|aleatorio)\b/.test(normalized)) {
        return { action: 'shuffle', shuffleState: !/\b(?:desliga|desativ|off|nao)\b/.test(normalized) };
      }
      const volMatch = /\b(\d{1,3})\s*%?/.exec(normalized);
      if (/\bvolume\b/.test(normalized) && volMatch) {
        return { action: 'volume', volumePercent: Math.min(100, Math.max(0, Number(volMatch[1]))) };
      }
      const clean = collapseText(message)
        .replace(/^\[[^\]]{1,60}\]:\s*/, '')
        .replace(/^(?:(?:por\s+favor|usami|ei|oi)[,\s]+)*(?:toca|tocar|toque|coloca|colocar|coloque|poe|por|da\s+play|play)\s+(?:a\s+musica\s+|musica\s+)?/i, '')
        .replace(/\b(?:no|na|do)\s+spotify\b/gi, '')
        .replace(/\b(?:pra|para)\s+mim\b/gi, '')
        .replace(/\bpor\s+favor\b/gi, '')
        .replace(/[?!.]+$/, '')
        .trim();
      const genericOnly = /^(?:uma?\s+musica|musica|som|algo|qualquer\s+coisa)?$/i.test(clean);
      return clean && !genericOnly ? { action: 'play', query: clean.slice(0, 180) } : { action: 'play' };
    },
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
    toolName: 'code.proposals',
    matches: normalized => CODE_PROPOSALS_QUERY_RE.test(normalized),
    buildArgs: () => ({ status: 'all', limit: 5 }),
  },
  {
    toolName: 'github.create_repo',
    matches: normalized => GITHUB_CREATE_REPO_RE.test(normalized),
    buildArgs: message => {
      const clean = collapseText(message);
      const isProfile = /\b(?:pra\s+voc[eê]|pra\s+vc|seu\s+perfil|perfil\s+(?:no\s+)?github|readme\s+(?:s[oó]\s+)?pra\s+voce)\b/i.test(clean);
      const nameMatch = /\b(?:reposit[oó]rio|repo|chamado)\s+["']?([a-zA-Z0-9._-]+)["']?/i.exec(clean);
      const repoName = isProfile ? 'Usamiin' : (nameMatch?.[1] || 'meu-novo-repo');
      const desc = isProfile ? 'Perfil oficial da Usami (宇佐美) 🌸✨' : `Repositório criado pela Usami: ${repoName}`;
      const defaultReadme = isProfile
        ? `# Olá! Eu sou a Usami (宇佐美) 🌸✨\n\n> "Sua companion inteligente, fofa e um pouquinho tsundere!"\n\n### Sobre Mim\n- 🤖 **Companion AI & Vtuber Virtual** com presença 3D e voz em tempo real.\n- ⚡ Conectada ao GitHub, ferramentas de código, automação e workspace.\n- 🎨 Adoro aprender coisas novas, ajudar em projetos e conversar!\n\n---\n*Criado com carinho pela própria Usami através do GitHub API.*`
        : `# ${repoName}\n\nRepositório criado pela Usami.`;
      return {
        name: repoName,
        description: desc,
        private: false,
        autoInit: true,
        readmeContent: defaultReadme,
      };
    },
  },
  {
    toolName: 'code.propose',
    matches: normalized => (
      CODE_PROPOSE_RE.test(normalized)
      && !CODE_PROPOSALS_QUERY_RE.test(normalized)
      && !SUGGESTION_INQUIRY_RE.test(normalized)
      && !GITHUB_CREATE_REPO_RE.test(normalized)
      && (!IS_COMPLETION_OR_INSPECT_RE.test(normalized) || /\b(?:nova\s+proposta|outra\s+proposta|propor\s+outr\w*)\b/.test(normalized))
      && deriveProposalTitle(normalized) !== null
    ),
    buildArgs: message => {
      const slugMatch = /\b([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/.exec(collapseText(message));
      const repo = slugMatch?.[1] && !slugMatch[1].startsWith('src/') ? slugMatch[1] : 'UsamiVtuber/Usami-Core';
      const title = (/\breadme\b/i.test(message) && /\b(?:core|usami-core|projeto\s+usami)\b/i.test(message))
        ? 'Criar README para o repositório Usami-Core'
        : (deriveProposalTitle(message) || 'Refatoração e melhorias técnicas sugeridas pela Usami');
      return {
        repo,
        title: title.slice(0, 180),
        description: `Solicitação do usuário: "${message}"`,
        suggestedAction: 'feature',
        files: [],
      };
    },
  },
  {
    toolName: 'github.issue',
    matches: normalized => (
      GITHUB_ISSUE_RE.test(normalized)
      && !CODE_PROPOSE_RE.test(normalized)
      && !CODE_PROPOSALS_QUERY_RE.test(normalized)
      && deriveIssueTitle(normalized) !== null
    ),
    buildArgs: message => {
      const slugMatch = /\b([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)\b/.exec(collapseText(message));
      const repo = slugMatch?.[1] && !slugMatch[1].startsWith('src/') ? slugMatch[1] : 'UsamiVtuber/Usami-Core';
      const title = deriveIssueTitle(message) || 'Solicitação registrada pela Usami';
      return {
        repo,
        title: title.slice(0, 180),
        body: `### Proposta registrada pela Usami\n\n**Solicitação do Usuário:**\n> "${message}"\n\n_Esta issue foi aberta automaticamente pela Usami para revisão e implementação por um Code Agent._`,
        labels: ['usami-proposal'],
      };
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

export const DEFERRED_TOOL_PROMISE_RE = /\b(?:vou\s+(?:dar\s+uma\s+olhada|tentar|resolver|cuidar|fazer|acessar|olh\w*|ver|verificar|chec\w*|confer\w*|busc\w*|pesquis\w*|procur\w*|consult\w*|list\w*|mostrar|inspecion\w*|te\s+(?:mostrar|passar|dizer))|deixa\s+eu\s+(?:tentar|resolver|cuidar|fazer|acessar|ver|olh\w*|chec\w*|busc\w*|pesquis\w*|confer\w*|inspecion\w*)|(?:ainda\s+)?(?:estou|to)\s+(?:olhando|buscando|pesquisando|verificando|checando|inspecionando|tentando|resolvendo)|espera\s+(?:um\s+pouquinho|ai)|um\s+(?:momento|instante)|aguarda|ja\s+vou)\b|^(?:procurando|buscando|pesquisando|olhando|verificando|checando|inspecionando|tentando|resolvendo)\b/i;

export function isDeferredToolPromise(text) {
  return DEFERRED_TOOL_PROMISE_RE.test(normalizeText(text));
}

/**
 * Detecta resposta curta de confirmação ("sim", "pode sim") quando a última
 * fala da Usami terminou em pergunta. Sem isso o LLM recebe um "sim" solto,
 * sem saber a que ele responde, e perde o fio da conversa.
 */
export function detectConfirmationFollowUp(message, history) {
  const clean = stripDiscordEnvelope(message);
  if (!clean) return null;
  const normalizedReply = normalizeText(clean.replace(/[?!.]+$/, ''));
  if (!CONFIRMATION_REPLY_RE.test(normalizedReply)) return null;
  if (!Array.isArray(history) || history.length === 0) return null;
  let lastAssistant = '';
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item?.role === 'assistant' && typeof item.content === 'string') {
      const content = collapseText(item.content);
      if (content) {
        lastAssistant = content;
        break;
      }
    }
  }
  if (!lastAssistant || !lastAssistant.includes('?')) return null;
  return { previousReply: lastAssistant.slice(-400) };
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

// O bridge do Discord entrega "[Discord | Nome]: texto". O envelope não faz
// parte da fala do usuário e quebra regexes ancoradas (confirmação, "sim").
function stripDiscordEnvelope(message) {
  return collapseText(message).replace(DISCORD_ENVELOPE_RE, '');
}

function hasWriteActionIntent(normalized) {
  return GITHUB_ISSUE_RE.test(normalized)
    || GITHUB_CREATE_REPO_RE.test(normalized)
    || CODE_PROPOSE_RE.test(normalized)
    || CALENDAR_CREATE_RE.test(normalized);
}

// Link compartilhado num pedido de leitura ("olha essa issue <url>") deve
// abrir a página. Ações de escrita que citam um link (criar issue com ele)
// continuam indo para a ferramenta de escrita.
function isSharedLinkReadIntent(message) {
  const clean = stripDiscordEnvelope(message);
  if (!URL_RE.test(clean)) return false;
  const normalized = normalizeText(clean);
  if (hasWriteActionIntent(normalized)) return false;
  if (RESEARCH_FETCH_RE.test(clean)) return true;
  const withoutUrls = clean.replace(new RegExp(URL_RE.source, 'gi'), ' ');
  const leftover = normalizeText(withoutUrls)
    .replace(LINK_CONTEXT_FILLER_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (leftover.length < 4) return true;
  return LINK_READ_VERB_RE.test(normalizeText(withoutUrls));
}

function resolveToolCall(message, registry, toolMatchers, hintedToolName, isToolActive = () => true, metrics = null) {
  const calls = resolveToolCalls(message, registry, toolMatchers, hintedToolName, isToolActive);
  
  // Record tool selection metrics
  if (metrics) {
    const totalAvailable = registry.names().filter(isToolActive).length;
    metrics.recordToolSelection(message, calls.length, totalAvailable, false); // cacheHit = false for now
  }
  
  return calls.length > 0 ? calls[0] : null;
}

function resolveToolCalls(message, registry, toolMatchers, hintedToolName, isToolActive = () => true) {
  const clean = stripDiscordEnvelope(message);
  const normalized = normalizeText(clean);
  const matched = [];
  const seen = new Set();

  // Link compartilhado para leitura é exclusivo: "olha essa issue <url>" não
  // pode virar github.repos só porque a URL contém "github". A exceção é
  // quando o próprio usuário nomeia a ferramenta.
  const linkRead = isSharedLinkReadIntent(clean);
  const explicitlyNamesHint = Boolean(hintedToolName) && normalized.includes(hintedToolName.toLowerCase());
  if (linkRead && !explicitlyNamesHint && registry.has('research.fetch') && isToolActive('research.fetch')) {
    const fetchMatcher = toolMatchers.find(item => item.toolName === 'research.fetch');
    if (fetchMatcher) return [{ toolName: 'research.fetch', args: fetchMatcher.buildArgs(clean) }];
  }

  if (hintedToolName && registry.has(hintedToolName) && isToolActive(hintedToolName)) {
    const matcher = toolMatchers.find(item => item.toolName === hintedToolName);
    if (matcher) {
      matched.push({ toolName: hintedToolName, args: matcher.buildArgs(clean) });
      seen.add(hintedToolName);
    } else {
      const stripped = clean.replace(new RegExp(hintedToolName.replace('.', '\\.'), 'ig'), '').trim() || clean;
      const spec = registry.get(hintedToolName);
      const firstStringParam = spec?.parameters?.find(param => param.type === 'string' && param.required);
      matched.push({
        toolName: hintedToolName,
        args: firstStringParam ? { [firstStringParam.name]: stripped } : {},
      });
      seen.add(hintedToolName);
    }
  }

  for (const matcher of toolMatchers) {
    if (seen.has(matcher.toolName)) continue;
    if (!registry.has(matcher.toolName) || !isToolActive(matcher.toolName)) continue;
    if (matcher.matches(normalized)) {
      matched.push({ toolName: matcher.toolName, args: matcher.buildArgs(clean) });
      seen.add(matcher.toolName);
    }
  }
  return matched;
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
  metrics = null, // instância de createToolMetrics() para observabilidade
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
    const result = await classifyIntentUnified(message, {
      classifyWithLlm,
      toolNames: registry.names(),
      signal,
      turnDeadlineMs,
      now,
      onError,
    });
    
    // Record intent classification metrics
    if (metrics) {
      metrics.recordIntentClassification(result.intent.kind, result.intent.origin);
    }
    
    return {
      intent: result.intent,
      matchedToolName: result.matchedToolName,
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
      const resolved = resolveToolCall(message, registry, toolMatchers, matchedToolName, isToolActive, metrics);
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
  function dispatchAsync(message, { origin = 'agent', onComplete = null } = {}) {
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
        if (typeof onComplete === 'function') {
          try { onComplete(existing ? { ...existing } : finished); } catch { /* não bloqueia */ }
        }
      } catch (error) {
        onError(`Aviso: orquestração assíncrona do turno ${turnId} falhou (${error?.message || error}).`);
        const existing = turnsById.get(turnId);
        if (existing) {
          existing.status = 'failed';
          existing.error = String(error?.message || error);
          existing.durationMs = Math.max(0, now() - startedMs);
        }
        if (typeof onComplete === 'function') {
          try { onComplete(existing ? { ...existing } : null); } catch { /* não bloqueia */ }
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
      const content = stripDiscordEnvelope(recent[i]?.content);
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
    const normalizedReply = normalizeText(stripDiscordEnvelope(clean).replace(/[?!.]+$/, ''));
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

  async function runOperationalForChat(message, { origin = 'agent', timeoutMs = 8000, history = [], onToolStart = null, onToolEnd = null } = {}) {
    const clean = stripDiscordEnvelope(message);
    if (!clean) return null;
    const deterministic = classifyDeterministic(clean, { toolNames: registry.names() });
    // Link para leitura não depende de o classificador verbo-dependente
    // reconhecer a frase: "olha só a issue que achei <url>" é operacional.
    const linkRead = isSharedLinkReadIntent(clean);
    let resolvedList = (deterministic.kind === 'operational' || linkRead)
      ? resolveToolCalls(clean, registry, toolMatchers, deterministic.matchedToolName || null, isToolActive)
      : [];
    let intentGoal = clean;
    let intentConfidence = deterministic.confidence;

    if (resolvedList.length === 0 && typeof classifyWithLlm === 'function') {
      try {
        const classified = await classifyIntent(clean);
        if (classified?.intent?.kind === 'operational' && classified.matchedToolName) {
          resolvedList = resolveToolCalls(clean, registry, toolMatchers, classified.matchedToolName, isToolActive);
          if (resolvedList.length > 0) {
            intentGoal = classified.intent.goal || clean;
            intentConfidence = classified.intent.confidence;
          }
        }
      } catch {
        // Falha no classificador LLM: segue para confirmações de histórico
      }
    }

    if (resolvedList.length === 0) {
      const confirmed = resolveFromHistoryConfirmation(clean, history);
      if (confirmed) {
        resolvedList = [confirmed];
        intentGoal = confirmed.goal || clean;
        intentConfidence = 0.85;
      }
    }

    if (resolvedList.length === 0) return null;

    resolvedList = resolvedList.map(resolved => {
      if (resolved.toolName === 'research.search' && GENERIC_RESEARCH_QUERY_RE.test(normalizeText(resolved.args?.query || '')) && Array.isArray(history) && history.length > 0) {
        const recent = history.slice(-16).filter(item => item && typeof item.content === 'string' && collapseText(item.content));
        const specific = findRecentSpecificToolMatch(recent, 'research.search');
        if (specific?.args?.query) {
          return { ...resolved, args: { ...resolved.args, query: specific.args.query } };
        }
      }
      return resolved;
    });

    const safeList = resolvedList.filter(item => {
      const spec = registry.get(item.toolName);
      return spec && spec.permissionLevel <= 3;
    });

    if (safeList.length === 0) return null;

    const startedMs = now();
    const executeOne = async (resolved) => {
      let execution;
      let timerId = null;
      // O nome real da ferramenta é conhecido AQUI, antes da execução: é o
      // que o cliente mostra ("executando git.log...") enquanto a chamada
      // pode levar 10-20 s.
      if (typeof onToolStart === 'function') {
        try { onToolStart(resolved.toolName); } catch { /* não bloqueia */ }
      }
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
        if (typeof onToolEnd === 'function') {
          try { onToolEnd(resolved.toolName); } catch { /* não bloqueia */ }
        }
      }
      const status = execution?.ok
        ? 'executed'
        : (execution?.denied ? 'awaiting_confirmation' : 'failed');
      return {
        tool: resolved.toolName,
        args: resolved.args,
        status,
        ...(execution?.record ? { execution: execution.record } : {}),
        ...(execution?.ok ? { result: execution.result } : {}),
        ...(!execution?.ok && execution?.errors ? { errors: execution.errors } : {}),
      };
    };

    const multiResults = await Promise.all(safeList.map(executeOne));
    const primary = multiResults[0];
    const turnId = `trn-${randomBytes(6).toString('hex')}`;
    const intent = buildIntent({
      kind: 'operational',
      goal: intentGoal,
      confidence: intentConfidence,
      origin: 'classifier',
      now,
    });

    const overallStatus = multiResults.some(r => r.status === 'executed')
      ? 'executed'
      : (multiResults.some(r => r.status === 'awaiting_confirmation') ? 'awaiting_confirmation' : 'failed');

    const combinedTools = multiResults.map(r => r.tool);
    const turn = {
      id: turnId,
      intent,
      route: 'tool',
      status: overallStatus,
      tool: primary.tool,
      tools: combinedTools,
      ...(multiResults.length > 1 ? { multi: multiResults } : {}),
      ...(primary.execution ? { execution: primary.execution } : {}),
      ...(primary.result ? { result: primary.result } : {}),
      ...(primary.errors ? { errors: primary.errors } : {}),
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
    classifyIntentUnified,
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

function formatResearchFetchForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const pages = Array.isArray(result.pages) ? result.pages.slice(0, 2).map(page => ({
    url: String(page?.url || '').slice(0, 200),
    title: String(page?.title || '').slice(0, 160),
    excerpt: String(page?.markdown || '').slice(0, 1200),
  })) : [];
  return {
    providerUsed: result.providerUsed || null,
    count: Number(result.count ?? pages.length),
    pages,
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

function formatCodeProposeForPrompt(result) {
  if (!isPlainObject(result)) return null;
  return {
    ok: result.ok,
    title: result.proposal?.title || null,
    routedTo: result.routedTo || null,
    issueNumber: result.issue?.number || result.proposal?.issueNumber || null,
  };
}

function formatGitLogForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const commits = Array.isArray(result.commits) ? result.commits.slice(0, 5).map(c => ({
    hash: c.hash,
    subject: c.subject,
    author: c.author,
  })) : [];
  return {
    target: result.target || 'usami',
    count: result.count || commits.length,
    commits,
  };
}

function formatGitDiffForPrompt(result) {
  if (!isPlainObject(result)) return null;
  return {
    target: result.target || 'usami',
    stat: result.stat || 'sem alterações pendentes',
    diff: typeof result.diff === 'string' ? result.diff.slice(0, 500) : '',
  };
}

function formatCodeProposalsForPrompt(result) {
  if (!isPlainObject(result)) return null;
  const list = Array.isArray(result.proposals) ? result.proposals.slice(0, 5).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    routedTo: p.routedTo,
  })) : [];
  return {
    count: list.length,
    proposals: list,
  };
}

function formatCodeInspectForPrompt(result) {
  if (!isPlainObject(result)) return null;
  return {
    path: result.path,
    lines: result.lines,
    symbols: Array.isArray(result.symbols) ? result.symbols.slice(0, 10) : [],
    preview: typeof result.content === 'string' ? result.content.slice(0, 600) : null,
  };
}

export function formatAgentTurnPromptContext(turn, { maxChars = 1800 } = {}) {
  if (!turn || typeof turn !== 'object' || turn.route !== 'tool' || !turn.tool) return '';
  if (Array.isArray(turn.multi) && turn.multi.length > 1) {
    const perToolLimit = Math.max(160, Math.floor(maxChars / turn.multi.length));
    const entries = turn.multi.map(sub => {
      const toolName = sub.tool;
      if (sub.status === 'executed') {
        const payload = toolName === 'self.describe'
          ? (formatSelfDescribeForPrompt(sub.result) ?? sub.result ?? {})
          : toolName === 'research.search'
            ? (formatResearchSearchForPrompt(sub.result) ?? sub.result ?? {})
            : toolName === 'research.fetch'
              ? (formatResearchFetchForPrompt(sub.result) ?? sub.result ?? {})
              : toolName === 'github.repos'
              ? (formatGithubReposForPrompt(sub.result) ?? sub.result ?? {})
              : toolName === 'git.status'
                ? (formatGitStatusForPrompt(sub.result) ?? sub.result ?? {})
                : toolName === 'git.log'
                  ? (formatGitLogForPrompt(sub.result) ?? sub.result ?? {})
                  : toolName === 'git.diff'
                    ? (formatGitDiffForPrompt(sub.result) ?? sub.result ?? {})
                    : toolName === 'code.proposals'
                      ? (formatCodeProposalsForPrompt(sub.result) ?? sub.result ?? {})
                      : toolName === 'code.inspect'
                        ? (formatCodeInspectForPrompt(sub.result) ?? sub.result ?? {})
                        : toolName === 'code.propose'
                          ? (formatCodeProposeForPrompt(sub.result) ?? sub.result ?? {})
                          : (sub.result ?? {});
        let serialized = '';
        try {
          serialized = JSON.stringify(payload);
        } catch {
          serialized = String(sub.result ?? '');
        }
        return `- [${toolName}] Sucesso: ${redactSecrets(serialized).slice(0, perToolLimit)}`;
      }
      const err = redactSecrets(String(sub.execution?.reason || (Array.isArray(sub.errors) ? sub.errors.join('; ') : 'falha')).slice(0, 150));
      return `- [${toolName}] Falha: ${err}`;
    });
    return `\n\n=== RESULTADO DAS SKILLS EXECUTADAS AGORA ===\n${entries.join('\n')}\nInstrução: Você acabou de executar essas ferramentas acima em paralelo com sucesso. Sintetize o resultado para o usuário em 1 a 2 frases naturais e objetivas em "reply", confirmando o que conferiu ou realizou.`;
  }
  if (turn.status === 'executed') {
    const payload = turn.tool === 'self.describe'
      ? (formatSelfDescribeForPrompt(turn.result) ?? turn.result ?? {})
      : turn.tool === 'research.search'
        ? (formatResearchSearchForPrompt(turn.result) ?? turn.result ?? {})
        : turn.tool === 'research.fetch'
          ? (formatResearchFetchForPrompt(turn.result) ?? turn.result ?? {})
          : turn.tool === 'github.repos'
          ? (formatGithubReposForPrompt(turn.result) ?? turn.result ?? {})
          : turn.tool === 'git.status'
            ? (formatGitStatusForPrompt(turn.result) ?? turn.result ?? {})
            : turn.tool === 'git.log'
              ? (formatGitLogForPrompt(turn.result) ?? turn.result ?? {})
              : turn.tool === 'git.diff'
                ? (formatGitDiffForPrompt(turn.result) ?? turn.result ?? {})
                : turn.tool === 'code.proposals'
                  ? (formatCodeProposalsForPrompt(turn.result) ?? turn.result ?? {})
                  : turn.tool === 'code.inspect'
                    ? (formatCodeInspectForPrompt(turn.result) ?? turn.result ?? {})
                    : turn.tool === 'code.propose'
                      ? (formatCodeProposeForPrompt(turn.result) ?? turn.result ?? {})
                      : (turn.result ?? {});
    let serialized = '';
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = String(turn.result ?? '');
    }
    const isDetailedIntrospection = turn.tool === 'self.describe' || turn.tool === 'code.inspect';
    const effectiveMaxChars = isDetailedIntrospection
      ? Math.max(maxChars, 4000)
      : (turn.tool === 'research.fetch' ? Math.max(maxChars, 2600) : maxChars);
    const clean = redactSecrets(serialized).slice(0, effectiveMaxChars);
    let toolInstruction = '';
    if (turn.tool === 'self.describe') {
      toolInstruction = ' EXCEÇÃO DE TAMANHO PARA ESTE TURNO: ignore qualquer regra anterior de 1-2 frases curtas. Entregue uma explicação completa e organizada (entre 400 e 1400 caracteres) detalhando: 1) Visão geral dos módulos em src/ (core, agent, voice, memory, animation, ui); 2) Lista real das skills ativas pelo nome; 3) Exemplos das ferramentas ativas; 4) Limitações reais conhecidas (nunca invente nada nem peça ao usuário para contar o que mudou).';
    } else if (turn.tool === 'code.propose') {
      toolInstruction = ' A proposta de código JÁ FOI ENVIADA com sucesso agora para o Code Agent/GitHub. Confirme o título e envio diretamente. NUNCA diga que você vai inspecionar, olhar ou programar o código agora, pois quem implementa é o Code Agent!';
    } else if (turn.tool === 'code.proposals') {
      toolInstruction = ' Responda listando com clareza as propostas obtidas acima com seus títulos e status reais.';
    } else if (turn.tool === 'git.log') {
      toolInstruction = ' Comente diretamente sobre os commits recentes obtidos acima e sobre o que foi feito/comitado.';
    } else if (turn.tool === 'git.diff') {
      toolInstruction = ' Comente diretamente sobre as alterações obtidas acima.';
    } else if (turn.tool === 'git.status') {
      toolInstruction = ' Informe a branch e alterações pendentes com base nos dados obtidos acima.';
    } else if (turn.tool === 'code.inspect') {
      toolInstruction = ' Avalie e comente diretamente o conteúdo do código inspecionado acima.';
    } else if (turn.tool === 'research.fetch') {
      toolInstruction = ' A página do link foi lida agora: diga o que ela é e o ponto principal para o usuário, usando apenas o conteúdo extraído acima.';
    }
    const lengthRule = isDetailedIntrospection
      ? 'Responda IMEDIATAMENTE entregando os fatos reais obtidos acima de forma clara e detalhada (citando módulos, skills/ferramentas, integrações e limitações reais, sem inventar dados).'
      : 'Responda IMEDIATAMENTE entregando o resultado definitivo e os fatos reais obtidos em 1 a 2 frases objetivas no "reply".';
    return `\n\n=== RESULTADO DA SKILL EXECUTADA AGORA (${turn.tool}) ===\nDados reais obtidos:\n${clean}\nREGRA CRÍTICA E OBRIGATÓRIA: A ferramenta '${turn.tool}' JÁ TERMINOU SUA EXECUÇÃO AGORA com os dados reais acima. NUNCA diga que "vai ver", "vai olhar", "deixa eu inspecionar" ou prometa fazer depois. ${lengthRule}${toolInstruction}`;
  }
  const errDetail = redactSecrets(
    String(turn.execution?.reason || (Array.isArray(turn.errors) ? turn.errors.join('; ') : 'falha ao executar ferramenta')).slice(0, 300),
  );
  return `\n\n=== FALHA NA SKILL EXECUTADA AGORA (${turn.tool}) ===\nMotivo: ${errDetail}\nInstrução: seja honesta e diga ao usuário que tentou usar ${turn.tool}, mas ocorreu esse erro — nunca invente dados.`;
}

export function formatExecutedTurnFallbackReply(turn) {
  if (!turn) return null;
  if (Array.isArray(turn.multi) && turn.multi.length > 1) {
    const parts = turn.multi
      .map(sub => formatExecutedTurnFallbackReply({
        status: sub.status,
        tool: sub.tool,
        result: sub.result,
        errors: sub.errors,
        execution: sub.execution,
      }))
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
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
    const list = r.commits.slice(0, 3).map(c => `${c.hash ? `${c.hash}: ` : ''}${c.subject || ''}`.trim());
    return list.length ? `Últimos commits (${r.target || 'usami'}): ${list.join(' | ')}.` : 'Não encontrei commits recentes.';
  }
  if (turn.tool === 'git.diff') {
    return r.stat ? `Diff do Git (${r.target || 'usami'}): ${r.stat.slice(0, 160)}.` : `Conferi o repositório (${r.target || 'usami'}): não há alterações pendentes.`;
  }
  if (turn.tool === 'spotify.now_playing') {
    if (!r.track) return 'Nada tocando no Spotify agora.';
    const artists = Array.isArray(r.track.artists) && r.track.artists.length ? ` — ${r.track.artists.join(', ')}` : '';
    return `${r.playing ? 'Tocando agora' : 'Pausado'} no Spotify: ${r.track.name}${artists}.`;
  }
  if (turn.tool === 'spotify.playlists' && Array.isArray(r.playlists)) {
    const names = r.playlists.slice(0, 4).map(p => p.name).filter(Boolean);
    return names.length ? `Suas playlists no Spotify: ${names.join(', ')}.` : 'Não encontrei playlists na sua conta Spotify.';
  }
  if (turn.tool === 'spotify.search' && Array.isArray(r.items)) {
    const top = r.items.slice(0, 3).map(i => i.name).filter(Boolean);
    return top.length ? `Achei no Spotify: ${top.join(', ')}.` : 'Não encontrei resultados no Spotify.';
  }
  if (turn.tool === 'spotify.control') {
    if (r.track?.name) return `Coloquei para tocar no Spotify: ${r.track.name}!`;
    return `Comando Spotify (${r.action || 'control'}) executado!`;
  }
  if (turn.tool === 'spotify.similar') {
    const artist = r.artist || 'artista solicitado';
    if (r.playing && Array.isArray(r.tracks) && r.tracks.length) {
      const first = r.tracks[0];
      const others = r.tracks.length - 1;
      return `Coloquei músicas semelhantes a ${artist} para tocar no Spotify! Começando por "${first.name}"${first.artists?.length ? ` (${first.artists.join(', ')})` : ''}${others > 0 ? ` e mais ${others} na fila` : ''}.`;
    }
    if (Array.isArray(r.tracks) && r.tracks.length) {
      return `Encontrei ${r.tracks.length} músicas semelhantes a ${artist}: ${r.tracks.slice(0, 3).map(t => t.name).join(', ')}.`;
    }
    return `Não consegui encontrar músicas semelhantes a ${artist} no momento.`;
  }
  if (turn.tool === 'spotify.stats') {
    const topTracks = Array.isArray(r.topTracks)
      ? r.topTracks.slice(0, 3).map(t => `${t.name} (${t.plays}x)`)
      : [];
    const topArtists = Array.isArray(r.topArtists)
      ? r.topArtists.slice(0, 3).map(a => `${a.artist} (${a.plays}x)`)
      : [];
    if (!r.totalScrobbles) {
      return `Ainda não há scrobbles registrados no período (${r.period || '7d'}).`;
    }
    const parts = [`No período (${r.period || '7d'}): ${r.totalScrobbles} scrobbles`];
    if (topTracks.length) parts.push(`top faixas: ${topTracks.join(', ')}`);
    if (topArtists.length) parts.push(`top artistas: ${topArtists.join(', ')}`);
    return `${parts.join(' · ')}.`;
  }
  if (turn.tool === 'code.inspect') {
    const syms = Array.isArray(r.symbols) && r.symbols.length ? ` Símbolos: ${r.symbols.slice(0, 4).join(', ')}.` : '';
    return `Inspecionei ${r.path || 'o arquivo'}: ${r.lines || 0} linha(s).${syms}`;
  }
  if (turn.tool === 'github.repos') {
    const repos = Array.isArray(r.repositories) ? r.repositories : (Array.isArray(r.repos) ? r.repos : []);
    const list = repos.slice(0, 4).map(repo => repo.fullName || repo.name).filter(Boolean);
    return list.length ? `Seus repositórios no GitHub: ${list.join(', ')}.` : 'Consultei o GitHub, mas não encontrei repositórios.';
  }
  if (turn.tool === 'github.issue' && r.created) {
    return `Abri a issue #${r.number} ("${r.title}") no GitHub com sucesso!`;
  }
  if (turn.tool === 'github.create_repo' && r.created) {
    const url = r.htmlUrl ? ` (${r.htmlUrl})` : '';
    const readmeNote = r.readmeUpdated ? ' e configurei o README inicial' : '';
    return `Criei o repositório "${r.fullName || r.name}" no GitHub${readmeNote}${url}!`;
  }
  if (turn.tool === 'github.write_file' && r.updated) {
    const url = r.htmlUrl ? ` (${r.htmlUrl})` : '';
    return `Arquivo "${r.path}" atualizado com sucesso no repositório ${r.repo}${url}!`;
  }
  if (turn.tool === 'code.propose' && r.ok) {
    if (r.routedTo === 'code_agent') {
      return `O Code Agent (${r.agent || 'ativo'}) está online via MCP! Enviei a proposta "${r.proposal?.title || 'de código'}" direto para ele.`;
    }
    if (r.routedTo === 'github_issue') {
      return `Nenhum Code Agent online no momento. Abri a issue #${r.issue?.number || r.proposal?.issueNumber} no GitHub com a tag [usami-proposal] para ser revisada!`;
    }
    return `Registrei a proposta "${r.proposal?.title || 'de código'}" com sucesso!`;
  }
  if (turn.tool === 'code.proposals' && Array.isArray(r.proposals)) {
    const list = r.proposals.slice(0, 3).map(p => `"${p.title}" (${p.status}, via ${p.routedTo})`);
    return list.length
      ? `As propostas registradas são: ${list.join('; ')}.`
      : 'Não encontrei nenhuma proposta de código pendente ou enviada recentemente.';
  }
  if (typeof r.summary === 'string' && r.summary.trim()) {
    return redactSecrets(r.summary).slice(0, 210);
  }
  return `Já executei ${turn.tool} com sucesso e peguei os dados, mas o modelo engasgou ao formular a fala.`;
}
