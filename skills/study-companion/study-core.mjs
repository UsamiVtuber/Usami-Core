export const STUDY_SCHEMA = 'usami.study.session.v1';
export const STUDY_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);

const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const normalize = value => collapse(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const STUDY_KEYWORDS_RE = /\b(estud\w*|aprend\w*|revis\w*|curso|prova|aula|exercicio|leitura|livro|modulo|pratica)\b/;

export function isStudyRelatedText(text) {
  return STUDY_KEYWORDS_RE.test(normalize(text));
}

function pickRelevantFacts(topic, memoryFacts = []) {
  const words = normalize(topic)
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);
  const list = Array.isArray(memoryFacts) ? memoryFacts.map(collapse).filter(Boolean) : [];
  if (!words.length) return list.slice(0, 5);

  const matched = list.filter(fact => {
    const norm = normalize(fact);
    return words.some(word => norm.includes(word));
  });
  return matched.slice(0, 5);
}

const LEVEL_TEMPLATES = Object.freeze({
  beginner: [
    { phase: 'Fundamentos', focus: 'conceitos essenciais, vocabulário base e exemplos guiados', ratio: 0.35, effort: 'low' },
    { phase: 'Prática inicial', focus: 'exercícios curtos passo a passo para fixar a base', ratio: 0.35, effort: 'medium' },
    { phase: 'Mini-projeto', focus: 'aplicação simples reunindo os conceitos iniciais', ratio: 0.2, effort: 'medium' },
    { phase: 'Revisão espaçada', focus: 'resumo ativo e checagem de dúvidas pendentes', ratio: 0.1, effort: 'low' },
  ],
  intermediate: [
    { phase: 'Diagnóstico', focus: 'mapear lacunas e revisar pré-requisitos críticos', ratio: 0.2, effort: 'low' },
    { phase: 'Aprofundamento', focus: 'padrões principais, casos de borda e resolução dirigida', ratio: 0.35, effort: 'medium' },
    { phase: 'Prática deliberada', focus: 'exercícios de dificuldade progressiva sem consulta', ratio: 0.3, effort: 'high' },
    { phase: 'Síntese e revisão', focus: 'flashcards/perguntas-chave e plano de retomada', ratio: 0.15, effort: 'low' },
  ],
  advanced: [
    { phase: 'Arquitetura e nuances', focus: 'trade-offs, limitações e cenários complexos', ratio: 0.3, effort: 'medium' },
    { phase: 'Desafio prático', focus: 'estudo de caso ou implementação completa sob restrições', ratio: 0.45, effort: 'high' },
    { phase: 'Crítica e consolidação', focus: 'análise de erros, benchmarks e síntese final', ratio: 0.25, effort: 'medium' },
  ],
});

export function buildStudyPlan({
  topic,
  level = 'intermediate',
  hoursPerWeek = 4,
  deadline = null,
  memoryFacts = [],
  nowMs = Date.now(),
} = {}) {
  const cleanTopic = collapse(topic);
  if (cleanTopic.length < 2 || cleanTopic.length > 160) {
    throw new Error('topic deve ter entre 2 e 160 caracteres.');
  }
  const safeLevel = STUDY_LEVELS.includes(level) ? level : 'intermediate';
  const safeHours = Number.isFinite(hoursPerWeek) ? Math.min(Math.max(Math.round(hoursPerWeek * 10) / 10, 1), 40) : 4;
  const cleanDeadline = deadline ? collapse(deadline) : null;
  if (cleanDeadline && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(cleanDeadline)) {
    throw new Error('deadline deve seguir YYYY-MM-DD ou ISO-8601.');
  }

  const template = LEVEL_TEMPLATES[safeLevel];
  const relevantFacts = pickRelevantFacts(cleanTopic, memoryFacts);
  const modules = template.map((entry, index) => {
    const hours = Math.max(0.5, Math.round(safeHours * entry.ratio * 10) / 10);
    return {
      order: index + 1,
      title: `${entry.phase}: ${cleanTopic}`,
      focus: entry.focus,
      suggestedHours: hours,
      effort: entry.effort,
      priority: Math.min(5, index + 1),
    };
  });

  const summary = `Trilha de estudos (${safeLevel}, ${safeHours}h/semana) para ${cleanTopic} em ${modules.length} etapas.`;

  return {
    schema: STUDY_SCHEMA,
    mode: 'plan',
    createdAt: new Date(nowMs).toISOString(),
    topic: cleanTopic,
    level: safeLevel,
    hoursPerWeek: safeHours,
    ...(cleanDeadline ? { deadline: cleanDeadline } : {}),
    relevantFacts,
    modules,
    summary,
  };
}

export function buildStudyReview({
  topic = null,
  operationalRecords = [],
  plans = [],
  memoryFacts = [],
  nowMs = Date.now(),
} = {}) {
  const cleanTopic = topic ? collapse(topic) : null;
  const normTopic = cleanTopic ? normalize(cleanTopic) : '';

  const matchesTopic = text => {
    const norm = normalize(text);
    if (normTopic) return norm.includes(normTopic);
    return isStudyRelatedText(norm);
  };

  const activeItems = (Array.isArray(operationalRecords) ? operationalRecords : [])
    .filter(item => item && item.status !== 'done' && item.status !== 'cancelled')
    .filter(item => matchesTopic(item.title))
    .map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.dueAt ? { dueAt: item.dueAt } : {}),
    }));

  const activePlans = (Array.isArray(plans) ? plans : [])
    .filter(plan => plan && plan.status !== 'done' && plan.status !== 'cancelled')
    .filter(plan => matchesTopic(plan.goal))
    .map(plan => ({
      id: plan.id,
      goal: plan.goal,
      status: plan.status,
      pendingSteps: Array.isArray(plan.steps) ? plan.steps.filter(s => s.status === 'pending').length : 0,
    }));

  const subject = cleanTopic || activeItems[0]?.title || activePlans[0]?.goal || 'estudos em aberto';
  const relevantFacts = cleanTopic ? pickRelevantFacts(cleanTopic, memoryFacts) : [];

  const prompts = [
    `Explique com suas palavras o conceito central de ${subject} sem consultar anotações.`,
    `Qual foi o ponto de maior dúvida ou erro recente em ${subject}?`,
    `Defina um exercício curto de 15 minutos para praticar ${subject} hoje.`,
  ];

  const summary = activeItems.length === 0 && activePlans.length === 0 && !cleanTopic
    ? 'Nenhuma trilha ou tarefa de estudo ativa encontrada na base local.'
    : `Revisão preparada para ${subject}: ${activeItems.length} tarefa(s) e ${activePlans.length} plano(s) ativo(s).`;

  return {
    schema: STUDY_SCHEMA,
    mode: 'review',
    createdAt: new Date(nowMs).toISOString(),
    ...(cleanTopic ? { topic: cleanTopic } : {}),
    activeItems,
    activePlans,
    relevantFacts,
    prompts,
    summary,
  };
}

