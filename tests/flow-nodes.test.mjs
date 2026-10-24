import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, createFlow, executeFlow, createInputNode, createOutputNode, createTransformNode, createAsyncNode, FlowExecutionError } from '../src/flow-nodes.js';

test('createNode valida campos obrigatórios', () => {
  assert.throws(() => createNode({}), /Node id is required/);
  assert.throws(() => createNode({ id: 'x' }), /Node type is required/);
  assert.throws(() => createNode({ id: 'x', type: 't', inputs: 'not-array' }), /inputs must be array/);
  assert.throws(() => createNode({ id: 'x', type: 't', outputs: 'not-array' }), /outputs must be array/);
  assert.throws(() => createNode({ id: 'x', type: 't', process: 'not-fn' }), /process must be function/);
  const n = createNode({ id: 'ok', type: 'test', inputs: [], outputs: ['out'], process: async () => ({ out: 1 }) });
  assert.equal(n.id, 'ok');
  assert.equal(n.type, 'test');
});

test('createFlow valida ids duplicados', () => {
  const n1 = createNode({ id: 'a', type: 't', inputs: [], outputs: ['o'], process: async () => ({}) });
  const n2 = createNode({ id: 'a', type: 't', inputs: [], outputs: ['o'], process: async () => ({}) });
  assert.throws(() => createFlow([n1, n2]), /Duplicate node ids/);
});

test('createFlow valida referência inexistente', () => {
  const n = createNode({ id: 'a', type: 't', inputs: [{ source: 'missing', key: 'x' }], outputs: ['o'], process: async () => ({}) });
  assert.throws(() => createFlow([n]), /references unknown source missing/);
});

test('createFlow detecta ciclo', () => {
  const n1 = createNode({ id: 'a', type: 't', inputs: [{ source: 'b', key: 'x' }], outputs: ['o'], process: async () => ({}) });
  const n2 = createNode({ id: 'b', type: 't', inputs: [{ source: 'a', key: 'y' }], outputs: ['o'], process: async () => ({}) });
  assert.throws(() => createFlow([n1, n2]), /Cycle detected/);
});

test('executeFlow ordem topológica simples', async () => {
  const n1 = createNode({ id: 'a', type: 't', inputs: [], outputs: ['x'], process: async () => ({ x: 1 }) });
  const n2 = createNode({ id: 'b', type: 't', inputs: [{ source: 'a', key: 'x' }], outputs: ['y'], process: async ({ x }) => ({ y: x + 1 }) });
  const flow = createFlow([n1, n2]);
  const { result } = await executeFlow(flow, {});
  assert.equal(result.y, 2);
});

test('executeFlow paralelismo independente', async () => {
  const n1 = createNode({ id: 'a', type: 't', inputs: [], outputs: ['x'], process: async () => ({ x: 1 }) });
  const n2 = createNode({ id: 'b', type: 't', inputs: [], outputs: ['y'], process: async () => ({ y: 2 }) });
  const n3 = createNode({ id: 'c', type: 't', inputs: [{ source: 'a', key: 'x' }, { source: 'b', key: 'y' }], outputs: ['z'], process: async ({ x, y }) => ({ z: x + y }) });
  const flow = createFlow([n1, n2, n3]);
  const { result } = await executeFlow(flow, {});
  assert.equal(result.z, 3);
});

test('executeFlow entrada externa', async () => {
  const n = createNode({ id: 'a', type: 't', inputs: [{ source: 'external', key: 'in' }], outputs: ['out'], process: async ({ in: v }) => ({ out: v * 2 }) });
  const flow = createFlow([n]);
  const { result } = await executeFlow(flow, { in: 5 });
  assert.equal(result.out, 10);
});

test('executeFlow erro de entrada faltando', async () => {
  const n = createNode({ id: 'a', type: 't', inputs: [{ source: 'external', key: 'missing' }], outputs: ['out'], process: async () => ({}) });
  const flow = createFlow([n]);
  await assert.rejects(executeFlow(flow, {}), /Missing input missing/);
});

test('createInputNode / createOutputNode helpers', () => {
  const inNode = createInputNode({ id: 'in', outputKey: 'val' });
  assert.equal(inNode.type, 'input');
  assert.deepEqual(inNode.outputs, ['val']);
  const outNode = createOutputNode({ id: 'out', inputKey: 'val' });
  assert.equal(outNode.type, 'output');
  assert.deepEqual(outNode.inputs, [{ source: 'external', key: 'val' }]);
});

test('createTransformNode', async () => {
  const n = createTransformNode({ id: 't', type: 'map', inputKey: 'a', outputKey: 'b', fn: (v) => v + 1 });
  const flow = createFlow([n]);
  const { result } = await executeFlow(flow, { a: 5 });
  assert.equal(result.b, 6);
});

test('createAsyncNode', async () => {
  const n = createAsyncNode({ id: 't', type: 'async', inputKeys: ['a', 'b'], outputKey: 'sum', fn: async ({ a, b }) => a + b });
  const flow = createFlow([n]);
  const { result } = await executeFlow(flow, { a: 2, b: 3 });
  assert.equal(result.sum, 5);
});

test('FlowExecutionError carrega nodeId e cause', async () => {
  const n = createNode({ id: 'bad', type: 't', inputs: [], outputs: ['x'], process: async () => { throw new Error('boom'); } });
  const flow = createFlow([n]);
  try {
    await executeFlow(flow, {});
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof FlowExecutionError);
    assert.equal(e.nodeId, 'bad');
    assert.ok(e.cause instanceof Error);
  }
});