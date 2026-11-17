import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  parseRelativeOrAbsoluteDue,
  createTimerService,
} from '../src/timer-service.js';
import {
  notifyWindows,
  notifyDiscord,
  broadcastNotification,
} from '../src/notifier.js';
import { createTimerTools, TIMER_TOOL_NAMES } from '../src/timer-tools.js';
import { createTimerHandler } from '../server.mjs';

function mockReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8787', ...headers };
  req[Symbol.asyncIterator] = async function* () {
    if (body) {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    }
  };
  process.nextTick(() => {
    if (body) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function mockRes() {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk || '');
      resolveDone(this);
    },
  };
  return { res, done };
}

test('parseRelativeOrAbsoluteDue: calcula prazos relativos, absolutos e fallback', () => {
  const fixedNow = new Date('2026-11-17T12:00:00.000Z').getTime();

  // Relativo
  const dueIn20Min = parseRelativeOrAbsoluteDue(20, null, fixedNow);
  assert.equal(dueIn20Min, fixedNow + 20 * 60_000);

  // Absoluto: HH:MM hoje
  const todayDue = parseRelativeOrAbsoluteDue(null, '20:30', fixedNow);
  const targetDate = new Date(todayDue);
  assert.equal(targetDate.getHours(), 20);
  assert.equal(targetDate.getMinutes(), 30);

  // Fallback seguro de 10 min
  const fallbackDue = parseRelativeOrAbsoluteDue(null, null, fixedNow);
  assert.equal(fallbackDue, fixedNow + 10 * 60_000);
});

test('timer-service: pomodoro ciclo de vida, fases foco/pausa e notificações', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-timer-test-'));
  const filePath = join(tmpDir, 'reminders.json');

  let simulatedNow = 1_000_000;
  const dispatched = [];
  const fakeNotifier = async (payload) => {
    dispatched.push(payload);
    return { ok: true };
  };

  const service = createTimerService({
    dataDir: tmpDir,
    filePath,
    now: () => simulatedNow,
    notifier: fakeNotifier,
  });

  // 1. Inicia Pomodoro
  const pom = service.startPomodoro({ task: 'estudar typescript', focusMinutes: 25, breakMinutes: 5 });
  assert.equal(pom.status, 'running');
  assert.equal(pom.phase, 'focus');
  assert.equal(pom.focusMinutes, 25);
  assert.equal(pom.breakMinutes, 5);

  let status = service.getStatus();
  assert.equal(status.activePomodoro.task, 'estudar typescript');
  assert.equal(status.activePomodoro.remainingMinutes, 25);

  // 2. Tick antes do fim do foco -> nenhuma notificação
  simulatedNow += 10 * 60_000; // 10 min se passaram
  await service.tick();
  assert.equal(dispatched.length, 0);

  // 3. Tick no fim do foco (25 min se passaram) -> Notificação de foco concluído e transição para pausa
  simulatedNow += 15 * 60_000 + 1000;
  await service.tick();
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].title, /Pomodoro Concluído/);
  assert.match(dispatched[0].message, /pausa de 5 minutos/);

  status = service.getStatus();
  assert.equal(status.activePomodoro.phase, 'break');
  assert.equal(status.activePomodoro.completedPomodoros, 1);

  // 4. Tick no fim da pausa (5 min) -> Notificação de pausa finalizada e encerramento
  simulatedNow += 5 * 60_000 + 1000;
  await service.tick();
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1].title, /Pausa Finalizada/);

  status = service.getStatus();
  assert.equal(status.activePomodoro, null);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('timer-service: lembretes com persistência em disco e tick de conclusão', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-reminders-test-'));
  const filePath = join(tmpDir, 'reminders.json');

  let simulatedNow = 1_000_000;
  const dispatched = [];
  const fakeNotifier = async (payload) => {
    dispatched.push(payload);
    return { ok: true };
  };

  const service = createTimerService({
    dataDir: tmpDir,
    filePath,
    now: () => simulatedNow,
    notifier: fakeNotifier,
  });

  // Cria lembrete para daqui a 15 min
  const rem = service.createReminder({
    text: 'Reunião de alinhamento com a equipe',
    inMinutes: 15,
    channels: ['windows', 'discord'],
  });

  assert.equal(rem.status, 'pending');
  assert.equal(rem.text, 'Reunião de alinhamento com a equipe');

  let status = service.getStatus();
  assert.equal(status.totalPending, 1);
  assert.equal(status.pendingReminders[0].text, 'Reunião de alinhamento com a equipe');

  // Recarrega novo serviço a partir do mesmo arquivo para verificar persistência
  const reloadedService = createTimerService({
    dataDir: tmpDir,
    filePath,
    now: () => simulatedNow,
    notifier: fakeNotifier,
  });

  let reloadedStatus = reloadedService.getStatus();
  assert.equal(reloadedStatus.totalPending, 1);

  // Avança tempo em 16 minutos e chama tick()
  simulatedNow += 16 * 60_000;
  await reloadedService.tick();

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].title, /Lembrete/);
  assert.equal(dispatched[0].message, 'Reunião de alinhamento com a equipe');
  assert.deepEqual(dispatched[0].channels, ['windows', 'discord']);

  reloadedStatus = reloadedService.getStatus();
  assert.equal(reloadedStatus.totalPending, 0);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('timer-service: cancelamento de pomodoro e lembretes específicos', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-cancel-test-'));
  const filePath = join(tmpDir, 'reminders.json');

  const service = createTimerService({
    dataDir: tmpDir,
    filePath,
    now: () => 1_000_000,
  });

  service.startPomodoro({ task: 'codar' });
  const rem1 = service.createReminder({ text: 'tarefa 1', inMinutes: 10 });
  const rem2 = service.createReminder({ text: 'tarefa 2', inMinutes: 20 });

  assert.equal(service.getStatus().totalPending, 2);

  // Cancela apenas o lembrete 1
  const cancelRes = service.cancel({ target: 'reminder', id: rem1.id });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled.length, 1);
  assert.equal(cancelRes.cancelled[0].id, rem1.id);
  assert.equal(service.getStatus().totalPending, 1);

  // Cancela tudo
  const cancelAllRes = service.cancel({ target: 'all' });
  assert.equal(cancelAllRes.ok, true);
  assert.equal(service.getStatus().totalPending, 0);
  assert.equal(service.getStatus().activePomodoro, null);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('notifier: notifyWindows executa powershell com XML escapado', () => {
  let executedCmd = null;
  let executedArgs = null;

  const mockExec = (cmd, args, opts, cb) => {
    executedCmd = cmd;
    executedArgs = args;
    cb(null);
  };

  const ok = notifyWindows({
    title: 'Teste <&> "Aspas"',
    message: 'Mensagem de teste',
    execFileImpl: mockExec,
  });

  if (process.platform === 'win32') {
    assert.equal(ok, true);
    assert.equal(executedCmd, 'powershell');
    assert.ok(executedArgs.includes('-Command'));
    // Garante que caracteres foram escapados
    assert.ok(executedArgs.some(arg => arg.includes('&amp;') && arg.includes('&lt;')));
  } else {
    assert.equal(ok, false);
  }
});

test('notifier: notifyDiscord suporta webhook, DM e canal com fallback', async () => {
  const fetchCalls = [];
  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url.includes('/users/@me/channels')) {
      return { ok: true, status: 200, json: async () => ({ id: 'dm_channel_999' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg_123' }) };
  };

  // 1. Webhook
  const webhookRes = await notifyDiscord({
    content: 'Olá via Webhook',
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    fetchImpl: fakeFetch,
  });
  assert.equal(webhookRes.ok, true);
  assert.equal(webhookRes.mode, 'webhook');

  // 2. DM com userId
  const dmRes = await notifyDiscord({
    content: 'Olá via DM',
    botToken: 'fake-token',
    userId: 'user_456',
    fetchImpl: fakeFetch,
  });
  assert.equal(dmRes.ok, true);
  assert.equal(dmRes.mode, 'dm');

  // 3. Canal sem userId
  const channelRes = await notifyDiscord({
    content: 'Olá no Canal',
    botToken: 'fake-token',
    userId: null,
    channelId: 'channel_789',
    fetchImpl: fakeFetch,
  });
  assert.equal(channelRes.ok, true);
  assert.equal(channelRes.mode, 'channel');
});

test('timer-tools: declarativas, validação de schema v1 e execução', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-tools-test-'));
  const service = createTimerService({ dataDir: tmpDir });
  const tools = createTimerTools({ timerService: service });

  assert.equal(tools.length, 4);
  for (const tool of tools) {
    assert.equal(tool.schema, 'usami.agent.tool.v1');
    assert.ok(TIMER_TOOL_NAMES.includes(tool.name));
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.verify, 'function');
  }

  // Executa timer.pomodoro
  const pomTool = tools.find(t => t.name === 'timer.pomodoro');
  const pomRes = await pomTool.execute({ task: 'estudo de física', focusMinutes: 20 });
  assert.equal(pomRes.ok, true);
  assert.equal(pomRes.task, 'estudo de física');
  assert.equal(pomTool.verify(pomRes), true);

  // Executa timer.reminder
  const remTool = tools.find(t => t.name === 'timer.reminder');
  const remRes = await remTool.execute({ text: 'beber água', inMinutes: 5 });
  assert.equal(remRes.ok, true);
  assert.match(remRes.message, /Lembrete agendado/);

  // Executa timer.status
  const statusTool = tools.find(t => t.name === 'timer.status');
  const statusRes = await statusTool.execute();
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.activePomodoro.task, 'estudo de física');
  assert.equal(statusRes.totalPending, 1);

  // Executa timer.cancel
  const cancelTool = tools.find(t => t.name === 'timer.cancel');
  const cancelRes = await cancelTool.execute({ target: 'all' });
  assert.equal(cancelRes.ok, true);
  assert.equal(service.getStatus().totalPending, 0);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('HTTP API: endpoints /api/timer/status e /api/timer/cancel', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'usami-http-timer-test-'));
  const service = createTimerService({ dataDir: tmpDir });
  service.createReminder({ text: 'almoço', inMinutes: 30 });

  const handleTimer = createTimerHandler({ timerService: service });

  // 1. GET /api/timer/status
  {
    const req = mockReq({ method: 'GET', url: '/api/timer/status' });
    const { res, done } = mockRes();
    await handleTimer(req, res);
    await done;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.totalPending, 1);
  }

  // 2. POST /api/timer/cancel
  {
    const req = mockReq({
      method: 'POST',
      url: '/api/timer/cancel',
      body: JSON.stringify({ target: 'all' }),
    });
    const { res, done } = mockRes();
    await handleTimer(req, res);
    await done;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(service.getStatus().totalPending, 0);
  }

  rmSync(tmpDir, { recursive: true, force: true });
});
