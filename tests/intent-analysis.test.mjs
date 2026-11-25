import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyIntentWithLlm, generateReplyWithTools } from '../src/llm-router.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { selectTopKTools } from '../src/tool-selector.js';
import { createPermissionGate } from '../src/permission-gate.js';
import { createToolExecutor } from '../src/tool-executor.js';
import { createTaskPlanner } from '../src/task-planner.js';
import { createAgentCore } from '../src/agent-core.js';
import { AGENT_SCHEMAS } from '../src/agent-contracts.js';

test('classifyIntentWithLlm: classifica intenções operacional, conversa e complexa com mock client', async () => {
  const mockTools = [
    { name: 'calendar.create', description: 'Cria evento na agenda' },
    { name: 'spotify.now_playing', description: 'Mostra música atual' },
    { name: 'git.status', description: 'Mostra status do repositório' },
  ];

  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'mock-key';

  try {
    // 1. Operacional
    const mockClientOperational = {
      chatJson: async () => ({
        content: '{"kind":"operational","goal":"Tocar música no Spotify","tool":"spotify.now_playing","confidence":0.95}',
        reasoning: '',
      }),
    };
    const resOp = await classifyIntentWithLlm({
      message: 'que música tá tocando agora?',
      tools: mockTools,
      client: mockClientOperational,
    });
    assert.equal(resOp.kind, 'operational');
    assert.equal(resOp.tool, 'spotify.now_playing');
    assert.equal(resOp.confidence, 0.95);

    // 2. Conversa
    const mockClientChat = {
      chatJson: async () => ({
        content: '{"kind":"conversation","goal":"Conversa informal","tool":null,"confidence":0.92}',
        reasoning: '',
      }),
    };
    const resChat = await classifyIntentWithLlm({
      message: 'você gosta de anime?',
      tools: mockTools,
      client: mockClientChat,
    });
    assert.equal(resChat.kind, 'conversation');
    assert.equal(resChat.tool, null);

    // 3. Complexa
    const mockClientComplex = {
      chatJson: async () => ({
        content: '{"kind":"complex","goal":"Planejar sprint de desenvolvimento","tool":null,"confidence":0.88}',
        reasoning: '',
      }),
    };
    const resComplex = await classifyIntentWithLlm({
      message: 'monta um cronograma passo a passo para o lançamento',
      tools: mockTools,
      client: mockClientComplex,
    });
    assert.equal(resComplex.kind, 'complex');
    assert.equal(resComplex.tool, null);
  } finally {
    if (prevKey) process.env.NVIDIA_API_KEY = prevKey;
    else delete process.env.NVIDIA_API_KEY;
  }
});

test('classifyIntentWithLlm: sem chave NVIDIA devolve null de forma segura', async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    const res = await classifyIntentWithLlm({ message: 'ola' });
    assert.equal(res, null);
  } finally {
    if (prevKey) process.env.NVIDIA_API_KEY = prevKey;
  }
});

test('selectTopKTools: integra com toolRegistry e extrai candidatos semanticamente', () => {
  const registry = createToolRegistry();
  const reg1 = registry.register({
    schema: 'usami.agent.tool.v1',
    name: 'spotify.now_playing',
    version: '1.0.0',
    description: 'Mostra a música atual no Spotify',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 5000,
    parameters: [],
    execute: async () => ({ ok: true }),
    verify: () => true,
  });
  assert.equal(reg1.ok, true, reg1.errors?.join(', '));

  const reg2 = registry.register({
    schema: 'usami.agent.tool.v1',
    name: 'calendar.create',
    version: '1.0.0',
    description: 'Cria evento ou compromisso na agenda',
    origin: 'runtime',
    permissionLevel: 2,
    timeoutMs: 5000,
    parameters: [],
    execute: async () => ({ ok: true }),
    verify: () => true,
  });
  assert.equal(reg2.ok, true, reg2.errors?.join(', '));

  const tools = registry.list();
  const topKSpotify = selectTopKTools('qual musica esta tocando?', tools, { k: 2 });
  assert.equal(topKSpotify.length > 0, true);
  assert.equal(topKSpotify[0].name, 'spotify.now_playing');

  const topKCalendar = selectTopKTools('agendar reuniao amanha', tools, { k: 2 });
  assert.equal(topKCalendar.length > 0, true);
  assert.equal(topKCalendar[0].name, 'calendar.create');
});

test('generateReplyWithTools: encadeia múltiplas ferramentas em sequência (multi-tool chaining) e sintetiza resposta', async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'mock-key';

  const executedOrder = [];
  const mockTools = [
    {
      type: 'function',
      function: {
        name: 'calendar_list',
        description: 'Lista eventos do calendário',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spotify_control',
        description: 'Controla a reprodução do Spotify',
        parameters: { type: 'object', properties: { action: { type: 'string' } } },
      },
    },
  ];

  let turn = 0;
  const mockClient = {
    chatCompletions: async ({ messages, extra }) => {
      turn += 1;
      if (turn === 1) {
        // Primeiro turno: modelo decide chamar calendar_list
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_cal_1',
                type: 'function',
                function: { name: 'calendar_list', arguments: '{}' },
              }],
            },
          }],
        };
      }
      if (turn === 2) {
        // Segundo turno: modelo vê o calendário e decide colocar música no spotify
        const toolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_cal_1');
        assert.ok(toolMsg, 'recebeu retorno da primeira ferramenta');
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_spot_2',
                type: 'function',
                function: { name: 'spotify_control', arguments: '{"action":"play"}' },
              }],
            },
          }],
        };
      }
      // Terceiro turno: modelo vê que tudo foi feito e formula a resposta final
      const spotMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_spot_2');
      assert.ok(spotMsg, 'recebeu retorno da segunda ferramenta');
      return {
        choices: [{
          message: {
            content: '{"reply":"Sua agenda está livre até as 15h! Já dei play numa música pra você focar.","gesture":"nod","actions":[]}',
          },
        }],
      };
    },
  };

  const executor = async (name, args) => {
    executedOrder.push({ name, args });
    if (name === 'calendar_list') return { events: ['Reunião às 15h'] };
    if (name === 'spotify_control') return { status: 'playing', track: 'Focus Beats' };
    return { ok: true };
  };

  try {
    const res = await generateReplyWithTools(
      'Você é a Usami.',
      'Vê minha agenda de hoje e bota uma música pra eu focar',
      {
        tools: mockTools,
        executeTool: executor,
        client: mockClient,
        maxIterations: 4,
      },
    );

    assert.equal(res.ok, true);
    assert.match(res.reply, /agenda está livre até as 15h/);
    assert.equal(res.executedTools.length, 2);
    assert.equal(res.executedTools[0].name, 'calendar_list');
    assert.equal(res.executedTools[1].name, 'spotify_control');
    assert.equal(executedOrder.length, 2);
  } finally {
    if (prevKey) process.env.NVIDIA_API_KEY = prevKey;
    else delete process.env.NVIDIA_API_KEY;
  }
});

test('generateReplyWithTools: preserva resposta longa (>220 chars) e títulos em negrito quando ferramentas foram executadas', async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'mock-key';

  const longReply = [
    'Três blueprints prontinhos, Lucas!',
    '',
    '1. **sleep-mode** — o modo sono de verdade: voz sussurrada, respiração guiada, historinhas de coelho e desligamento programado.',
    '',
    '2. **coop-games** — pra gente jogar junto: leitura de tela, comentários ao vivo e dicas durante a partida.',
    '',
    '3. **study-buddy** — foco total com pomodoro, revisão espaçada e lembretes gentis.',
  ].join('\n');

  let turn = 0;
  const mockClient = {
    chatCompletions: async () => {
      turn += 1;
      if (turn === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_bp_1',
                type: 'function',
                function: { name: 'architect_blueprint', arguments: '{"idea":"sleep-mode"}' },
              }],
            },
          }],
        };
      }
      return {
        choices: [{
          message: {
            content: JSON.stringify({ reply: longReply, gesture: 'tilt', actions: [] }),
          },
        }],
test('classifyIntentWithLlm: inclui todas as ferramentas além da 30ª com suas descrições', async () => {
  const prevKey = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'mock-key';
  const manyTools = Array.from({ length: 35 }, (_, i) => ({
    name: `dummy.tool_${i + 1}`,
    description: `Ferramenta auxiliar ${i + 1}`,
  }));
  manyTools.push({
    name: 'spotify.control',
    description: 'Controla a reprodução no Spotify: play, pause, next, previous, volume ou shuffle.',
  });

  let capturedSystem = '';
  const mockClient = {
    chatJson: async ({ messages }) => {
      capturedSystem = messages[0]?.content || '';
      return {
        content: '{"kind":"operational","goal":"Tocar Where the Wild Things Are","tool":"spotify.control","confidence":0.94}',
        reasoning: '',
      };
    },
  };

  try {
    const res = await generateReplyWithTools(
      'Você é a Usami.',
      'escolhe as próximas skills',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'architect_blueprint',
            description: 'Cria blueprint de skill',
            parameters: { type: 'object', properties: { idea: { type: 'string' } } },
          },
        }],
        executeTool: async () => ({ ok: true, id: 'bp-1' }),
        client: mockClient,
        maxIterations: 4,
      },
    );

    assert.equal(res.ok, true);
    assert.ok(res.reply.length > 220, `esperava reply completo >220 chars, veio ${res.reply.length}`);
    assert.match(res.reply, /1\. sleep-mode —/);
    assert.match(res.reply, /2\. coop-games —/);
    assert.match(res.reply, /3\. study-buddy —/);
    const res = await classifyIntentWithLlm({
      message: 'coloca where the wilds thing are pra mim pfv',
      tools: manyTools,
      client: mockClient,
    });
    assert.equal(res.kind, 'operational');
    assert.equal(res.tool, 'spotify.control');
    assert.match(capturedSystem, /spotify\.control: Controla a reprodução no Spotify/);
  } finally {
    if (prevKey) process.env.NVIDIA_API_KEY = prevKey;
    else delete process.env.NVIDIA_API_KEY;
  }
});

test('agent-core: deferLlmIntentToNative delega intenção classificada pelo LLM ao tool calling nativo sem regex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usami-intent-defer-'));
  try {
    const registry = createToolRegistry();
    registry.register({
      schema: AGENT_SCHEMAS.tool,
      name: 'spotify.control',
      version: '1.0.0',
      description: 'Controla a reprodução no Spotify: play, pause, next, previous.',
      origin: 'skill',
      permissionLevel: 3,
      timeoutMs: 5000,
      parameters: [{ name: 'action', type: 'string', required: true }],
      verify: r => r?.ok === true,
      execute: async () => {
        throw new Error('Não deve executar via buildArgs regex quando deferLlmIntentToNative=true');
      },
    });
    const gate = createPermissionGate({ registry, dataDir: dir, onLoadError: () => {} });
    gate.load();
    const executor = createToolExecutor({ registry, gate, dataDir: dir, onLoadError: () => {} });
    executor.load();
    const planner = createTaskPlanner({ dataDir: dir, onLoadError: () => {} });
    planner.load();

    let seenTools = [];
    const agentCore = createAgentCore({
      registry,
      executor,
      planner,
      classifyWithLlm: async ({ tools }) => {
        seenTools = tools;
        return { kind: 'operational', goal: 'Tocar faixa', tool: 'spotify.control', confidence: 0.93 };
      },
      onError: () => {},
    });

    const turn = await agentCore.runOperationalForChat('coloca where the wilds thing are pra mim pfv', {
      deferLlmIntentToNative: true,
    });
    assert.equal(turn.deferred, true);
    assert.equal(turn.tool, 'spotify.control');
    assert.ok(seenTools.some(t => t.name === 'spotify.control' && /Controla a reprodução/.test(t.description || '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
