/**
 * Registry de ferramentas do domínio agêntico.
 *
 * Guarda ToolSpecs já validados por `agent-contracts.js` e responde pela
 * descoberta por nome e pela validação dos argumentos. Não executa nada — o
 * timeout e o histórico ficam no `tool-executor.js`; a permissão fica em S5.
 */
import { validateToolSpec } from './agent-contracts.js';

// Limite genérico para strings de entrada: nenhuma ferramenta precisa de mais
// que isso e evita payload gigante chegando ao execute().
export const MAX_STRING_ARG_CHARS = 500;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function checkValue(param, value, errors) {
  const typeOk = {
    string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value),
    boolean: typeof value === 'boolean',
    array: Array.isArray(value),
    object: isPlainObject(value),
  }[param.type];
  if (!typeOk) {
    errors.push(`arguments.${param.name}: esperado ${param.type}`);
    return;
  }
  if (param.type === 'string') {
    if (!value.trim()) errors.push(`arguments.${param.name}: não pode ser vazio`);
    else if (value.length > MAX_STRING_ARG_CHARS) errors.push(`arguments.${param.name}: excede ${MAX_STRING_ARG_CHARS} caracteres`);
  }
  if (param.enum && !param.enum.includes(value)) {
    errors.push(`arguments.${param.name}: deve ser um de ${param.enum.join('|')}`);
  }
}

/** Valida os argumentos contra os `parameters` do ToolSpec. */
export function validateToolArguments(tool, input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['arguments: deve ser um objeto JSON'], value: null };
  const errors = [];
  const known = new Set(tool.parameters.map(param => param.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`arguments.${key}: parâmetro desconhecido`);
  }
  const value = {};
  for (const param of tool.parameters) {
    const provided = Object.prototype.hasOwnProperty.call(input, param.name) && input[param.name] !== null && input[param.name] !== undefined;
    if (!provided) {
      if (param.required) errors.push(`arguments.${param.name}: obrigatório`);
      continue;
    }
    checkValue(param, input[param.name], errors);
    value[param.name] = input[param.name];
  }
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value };
}

const describe = tool => ({
  schema: tool.schema,
  name: tool.name,
  version: tool.version,
  description: tool.description,
  origin: tool.origin,
  permissionLevel: tool.permissionLevel,
  timeoutMs: tool.timeoutMs,
  parameters: tool.parameters.map(param => ({ ...param, ...(param.enum ? { enum: [...param.enum] } : {}) })),
});

export function createToolRegistry() {
  const toolsByName = new Map();

  return {
    /** Registra um ToolSpec executável; recusa spec inválida ou nome repetido. */
    register(spec) {
      const checked = validateToolSpec(spec);
      if (!checked.ok) return checked;
      const tool = checked.value;
      if (typeof tool.execute !== 'function') {
        return { ok: false, errors: ['execute: ferramenta sem execute não pode ser registrada'], value: null };
      }
      if (toolsByName.has(tool.name)) {
        return { ok: false, errors: [`name: já registrada (${tool.name})`], value: null };
      }
      toolsByName.set(tool.name, tool);
      return { ok: true, errors: [], tool };
    },

    get(name) {
      return toolsByName.get(name) || null;
    },

    has(name) {
      return toolsByName.has(name);
    },

    names() {
      return [...toolsByName.keys()];
    },

    /** Descritores sem funções (para API/UI futura). */
    list() {
      return [...toolsByName.values()].map(describe);
    },

    /** Converte os ToolSpecs registrados para o formato OpenAI function-calling. */
    toOpenAiTools() {
      return [...toolsByName.values()].map(toolToOpenAi);
    },
  };
}

/** Converte um ToolSpec em definição OpenAI function-calling. */
export function toolToOpenAi(tool) {
  const properties = {};
  const required = [];
  for (const param of tool.parameters || []) {
    const prop = { type: param.type };
    if (param.description) prop.description = param.description;
    if (param.enum) prop.enum = [...param.enum];
    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }
  return {
    type: 'function',
    function: {
      name: tool.name.replace(/\./g, '_'),
      description: tool.description || tool.name,
      parameters: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      },
    },
  };
}

/** Helper standalone para montar a lista a partir de um registry. */
export function buildOpenAiTools(registry) {
  if (!registry || typeof registry.toOpenAiTools !== 'function') return [];
  return registry.toOpenAiTools();
}
