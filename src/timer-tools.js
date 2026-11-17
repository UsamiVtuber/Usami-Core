/**
 * Ferramentas de Temporizador, Pomodoro e Lembretes (S10 Extension / RFC-001).
 *
 * Registra `timer.pomodoro`, `timer.reminder`, `timer.status` e `timer.cancel`
 * no Tool Registry no contrato `usami.agent.tool.v1`.
 */

export const TIMER_TOOL_NAMES = Object.freeze([
  'timer.pomodoro',
  'timer.reminder',
  'timer.status',
  'timer.cancel',
]);

export function createTimerTools({ timerService }) {
  if (!timerService) {
    throw new Error('createTimerTools: timerService é obrigatório.');
  }

  const pomodoroTool = {
    schema: 'usami.agent.tool.v1',
    name: 'timer.pomodoro',
    version: '1.0.0',
    description: 'Inicia um temporizador Pomodoro de foco e intervalo para estudos ou trabalho com notificações multicanal.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 4000,
    parameters: [
      { name: 'task', type: 'string', required: false, description: 'Meta ou atividade de foco (ex: "estudos", "codar backend").' },
      { name: 'focusMinutes', type: 'number', required: false, description: 'Minutos da sessão de foco (padrão: 25).' },
      { name: 'breakMinutes', type: 'number', required: false, description: 'Minutos do intervalo de descanso (padrão: 5).' },
    ],
    execute: async (args = {}) => {
      try {
        const res = timerService.startPomodoro(args);
        return {
          ok: true,
          status: 'started',
          task: res.task,
          focusMinutes: res.focusMinutes,
          breakMinutes: res.breakMinutes,
          endsAt: new Date(res.phaseEndsAtMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          message: `Pomodoro de ${res.focusMinutes} minutos iniciado para "${res.task}". Bom foco!`,
        };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    verify: res => Boolean(res && res.ok === true),
  };

  const reminderTool = {
    schema: 'usami.agent.tool.v1',
    name: 'timer.reminder',
    version: '1.0.0',
    description: 'Agenda um lembrete com notificação no Windows, Discord e voz da Usami.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 4000,
    parameters: [
      { name: 'text', type: 'string', required: true, description: 'Mensagem do lembrete (ex: "tirar a pizza do forno", "reunião diária").' },
      { name: 'inMinutes', type: 'number', required: false, description: 'Minutos até o disparo do lembrete (ex: 20).' },
      { name: 'atTime', type: 'string', required: false, description: 'Horário específico para o lembrete (formato HH:MM, ex: "18:30").' },
    ],
    execute: async (args = {}) => {
      try {
        const res = timerService.createReminder(args);
        return {
          ok: true,
          status: 'scheduled',
          id: res.id,
          text: res.text,
          dueAt: new Date(res.dueAtMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          message: `Lembrete agendado para as ${new Date(res.dueAtMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}: "${res.text}".`,
        };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    verify: res => Boolean(res && res.ok === true),
  };

  const statusTool = {
    schema: 'usami.agent.tool.v1',
    name: 'timer.status',
    version: '1.0.0',
    description: 'Consulta o status atual do Pomodoro (tempo restante de foco ou pausa) e lista lembretes pendentes.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 3000,
    parameters: [],
    execute: async () => {
      try {
        const status = timerService.getStatus();
        return { ok: true, ...status };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    verify: res => Boolean(res && res.ok === true),
  };

  const cancelTool = {
    schema: 'usami.agent.tool.v1',
    name: 'timer.cancel',
    version: '1.0.0',
    description: 'Cancela o Pomodoro em andamento ou remove lembretes pendentes.',
    origin: 'runtime',
    permissionLevel: 1,
    timeoutMs: 3000,
    parameters: [
      { name: 'target', type: 'string', required: false, enum: ['all', 'pomodoro', 'reminder'], description: 'O que cancelar: pomodoro, reminder ou all.' },
      { name: 'id', type: 'string', required: false, description: 'ID específico do lembrete a ser cancelado.' },
    ],
    execute: async (args = {}) => {
      try {
        const res = timerService.cancel(args);
        return { ok: true, ...res };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    verify: res => Boolean(res && res.ok === true),
  };

  return [pomodoroTool, reminderTool, statusTool, cancelTool];
}
