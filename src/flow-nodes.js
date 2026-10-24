/**
 * Node system (n8n-style) — minimal, pure, testable.
 *
 * A flow is a directed acyclic graph of nodes. Each node:
 *   - declares its input/output keys
 *   - implements async process(inputs, context) -> outputs
 *   - receives a shared context (memory, config, services)
 *
 * Execution: topological sort, parallel where independent, single shared context.
 */

export class FlowExecutionError extends Error {
  constructor(message, { nodeId, cause } = {}) {
    super(message);
    this.name = 'FlowExecutionError';
    this.nodeId = nodeId;
    this.cause = cause;
  }
}

export function createNode({ id, type, inputs = [], outputs = [], process }) {
  if (!id || typeof id !== 'string') throw new Error('Node id is required');
  if (!type || typeof type !== 'string') throw new Error('Node type is required');
  if (!Array.isArray(inputs)) throw new Error('inputs must be array');
  if (!Array.isArray(outputs)) throw new Error('outputs must be array');
  if (typeof process !== 'function') throw new Error('process must be function');

  return { id, type, inputs, outputs, process };
}

export function createFlow(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  // Validate
  if (nodes.length === 0) throw new Error('Flow needs at least one node');
  const ids = nodes.map(n => n.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate node ids');
  for (const node of nodes) {
    for (const inp of node.inputs) {
      if (!byId.has(inp.source) && inp.source !== 'external') {
        throw new Error(`Node ${node.id}: input ${inp.key} references unknown source ${inp.source}`);
      }
    }
    // Check for cycles (simple DFS)
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Cycle detected at node ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    for (const inp of node.inputs) {
      if (inp.source !== 'external') visit(inp.source);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) if (!visited.has(id)) visit(id);

  return { nodes, byId };
}

export async function executeFlow(flow, externalInputs, context = {}) {
  const { nodes, byId } = flow;
  const values = new Map(); // nodeId -> output key -> value
  // Seed external inputs
  for (const [key, value] of Object.entries(externalInputs)) {
    values.set('external', { ...(values.get('external') || {}), [key]: value });
  }

  // Topological order (Kahn)
  const indegree = new Map();
  const adj = new Map();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const node of nodes) {
    for (const inp of node.inputs) {
      if (inp.source !== 'external') {
        indegree.set(node.id, (indegree.get(node.id) || 0) + 1);
        adj.get(inp.source).push(node.id);
      }
    }
  }
  const queue = [...nodes].filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id) || []) {
      const d = indegree.get(next) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new FlowExecutionError('Topological sort failed (cycle?)');

  // Execute in order
  for (const nodeId of order) {
    const node = byId.get(nodeId);
    const inputs = {};
    for (const inp of node.inputs) {
      const srcValues = inp.source === 'external' ? values.get('external') : values.get(inp.source);
      // Domain nodes may expose a structured result (for example,
      // `llmResult.reply`). Resolve that path here rather than flattening
      // every node's public output merely to satisfy the graph runner.
      const value = readInputValue(srcValues, inp.key);
      if (value === undefined) {
        throw new FlowExecutionError(`Missing input ${inp.key} from ${inp.source}`, { nodeId });
      }
      inputs[inp.key] = value;
    }
    try {
      const outputs = await node.process(inputs, context);
      if (!outputs || typeof outputs !== 'object') throw new Error('process must return object');
      values.set(nodeId, outputs);
    } catch (error) {
      throw new FlowExecutionError(error.message, { nodeId, cause: error });
    }
  }

  // Collect final outputs (nodes with no downstream consumers)
  const consumed = new Set();
  for (const node of nodes) {
    for (const inp of node.inputs) if (inp.source !== 'external') consumed.add(inp.source);
  }
  const final = {};
  for (const node of nodes) {
    if (!consumed.has(node.id)) {
      Object.assign(final, values.get(node.id) || {});
    }
  }
  return { result: final, nodeOutputs: Object.fromEntries(values) };
}

function readInputValue(source, key) {
  if (source === undefined || source === null) return undefined;
  if (Object.hasOwn(source, key)) return source[key];
  return String(key).split('.').reduce((value, segment) => (
    value === undefined || value === null ? undefined : value[segment]
  ), source);
}

// --- Built-in node types ---

export function createInputNode({ id = 'input', outputKey = 'payload' } = {}) {
  return createNode({
    id, type: 'input', inputs: [], outputs: [outputKey],
    process: async () => ({ [outputKey]: null }), // value injected via externalInputs
  });
}

export function createOutputNode({ id = 'output', inputKey = 'payload' } = {}) {
  return createNode({
    id, type: 'output', inputs: [{ source: 'external', key: inputKey }], outputs: [],
    process: async (inputs) => { return {}; }, // pass-through
  });
}

export function createTransformNode({ id, type, inputKey = 'in', outputKey = 'out', fn }) {
  return createNode({
    id, type, inputs: [{ source: 'external', key: inputKey }], outputs: [outputKey],
    process: async (inputs, context) => ({ [outputKey]: await fn(inputs[inputKey], context) }),
  });
}

export function createAsyncNode({ id, type, inputKeys = [], outputKey = 'out', fn }) {
  return createNode({
    id, type, inputs: inputKeys.map(k => ({ source: 'external', key: k })), outputs: [outputKey],
    process: async (inputs, context) => ({ [outputKey]: await fn(inputs, context) }),
  });
}
