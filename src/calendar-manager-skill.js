/**
 * Skill operacional Calendar Manager (Google Calendar API v3).
 *
 * Publica `skills/calendar-manager` em `dataDir/skills` quando ausente e
 * registra:
 *  - `calendar.list` (nível 3): lista eventos no Google Calendar;
 *  - `calendar.create` (nível 3): cria evento no Google Calendar;
 *  - `calendar.delete` (nível 4): remove evento (exige confirmação humana S5).
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { createGoogleAuthClient } from './google-auth.js';
import { publishSkillPackage } from './skill-package.js';
import {
  CALENDAR_SCHEMA,
  buildCreateEventPayload,
  buildListEventsQuery,
  normalizeCalendarEvent,
  sanitizeCalendarId,
  sanitizeEventId,
} from '../skills/calendar-manager/calendar-core.mjs';

export const CALENDAR_MANAGER_SKILL_ID = 'calendar-manager';
export const CALENDAR_MANAGER_TOOLS = Object.freeze(['calendar.list', 'calendar.create', 'calendar.delete']);

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishCalendarManagerSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: CALENDAR_MANAGER_SKILL_ID, dataDir, bundledDir });
}

export function createCalendarManagerTools({
  googleAuth = createGoogleAuthClient(),
  now = () => Date.now(),
} = {}) {
  const listTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'calendar.list',
    version: '1.0.0',
    description: 'Lista eventos do Google Calendar em uma janela de datas.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 12000,
    parameters: [
      { name: 'calendarId', type: 'string', required: false, description: 'ID da agenda (padrão primary).' },
      { name: 'timeMin', type: 'string', required: false, description: 'Início ISO-8601 ou YYYY-MM-DD (padrão agora).' },
      { name: 'timeMax', type: 'string', required: false, description: 'Fim ISO-8601 ou YYYY-MM-DD.' },
      { name: 'maxResults', type: 'number', required: false, description: 'Máximo de eventos (1 a 50).' },
      { name: 'query', type: 'string', required: false, description: 'Filtro textual opcional.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === CALENDAR_SCHEMA
        && Array.isArray(result.events);
    },
    async execute(args = {}) {
      const calId = sanitizeCalendarId(args.calendarId);
      const qs = buildListEventsQuery({
        timeMin: args.timeMin ?? null,
        timeMax: args.timeMax ?? null,
        maxResults: args.maxResults ?? 20,
        query: args.query ?? null,
        nowMs: now(),
      });
      const data = await googleAuth.requestJson(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calId)}/events?${qs}`,
      );
      const events = (Array.isArray(data.items) ? data.items : [])
        .map(normalizeCalendarEvent)
        .filter(Boolean);
      return {
        ok: true,
        schema: CALENDAR_SCHEMA,
        provider: 'google-calendar',
        calendarId: calId,
        count: events.length,
        events,
      };
    },
  };

  const createTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'calendar.create',
    version: '1.0.0',
    description: 'Cria um evento no Google Calendar.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 12000,
    parameters: [
      { name: 'summary', type: 'string', required: true, description: 'Título do evento.' },
      { name: 'start', type: 'string', required: true, description: 'Início ISO-8601 (ex.: 2026-11-12T10:00:00-03:00) ou YYYY-MM-DD.' },
      { name: 'end', type: 'string', required: false, description: 'Término (padrão +1h ou +1 dia).' },
      { name: 'description', type: 'string', required: false, description: 'Descrição curta.' },
      { name: 'location', type: 'string', required: false, description: 'Local ou link.' },
      { name: 'calendarId', type: 'string', required: false, description: 'ID da agenda (padrão primary).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === CALENDAR_SCHEMA
        && isPlainObject(result.event)
        && typeof result.event.id === 'string'
        && result.event.id.length > 0;
    },
    async execute(args = {}) {
      const calId = sanitizeCalendarId(args.calendarId);
      const payload = buildCreateEventPayload({
        summary: args.summary,
        start: args.start,
        end: args.end ?? null,
        description: args.description ?? null,
        location: args.location ?? null,
      });
      const created = await googleAuth.requestJson(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calId)}/events`,
        { method: 'POST', body: payload },
      );
      const event = normalizeCalendarEvent(created);
      if (!event?.id) throw new Error('Google Calendar não retornou id do evento criado.');
      return {
        ok: true,
        schema: CALENDAR_SCHEMA,
        provider: 'google-calendar',
        calendarId: calId,
        event,
      };
    },
  };

  const deleteTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'calendar.delete',
    version: '1.0.0',
    description: 'Remove um evento do Google Calendar (exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 12000,
    parameters: [
      { name: 'eventId', type: 'string', required: true, description: 'ID do evento no Google Calendar.' },
      { name: 'calendarId', type: 'string', required: false, description: 'ID da agenda (padrão primary).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === CALENDAR_SCHEMA
        && result.deleted === true
        && typeof result.eventId === 'string';
    },
    async execute(args = {}) {
      const calId = sanitizeCalendarId(args.calendarId);
      const eventId = sanitizeEventId(args.eventId);
      await googleAuth.requestJson(
        `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE' },
      );
      return {
        ok: true,
        schema: CALENDAR_SCHEMA,
        provider: 'google-calendar',
        calendarId: calId,
        eventId,
        deleted: true,
      };
    },
  };

  return [listTool, createTool, deleteTool];
}

