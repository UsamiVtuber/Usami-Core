export const CALENDAR_SCHEMA = 'usami.google.calendar.v1';

const SAFE_CALENDAR_ID_RE = /^[a-zA-Z0-9._@+-]{1,128}$/;
const SAFE_EVENT_ID_RE = /^[a-zA-Z0-9_-]{3,160}$/;
const ISO_OR_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;

const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');

export function sanitizeCalendarId(calendarId = 'primary') {
  const clean = String(calendarId ?? 'primary').trim() || 'primary';
  if (!SAFE_CALENDAR_ID_RE.test(clean) || clean.includes('..')) {
    throw new Error('calendarId inválido.');
  }
  return clean;
}

export function sanitizeEventId(eventId) {
  const clean = String(eventId ?? '').trim();
  if (!SAFE_EVENT_ID_RE.test(clean)) {
    throw new Error('eventId inválido.');
  }
  return clean;
}

export function buildListEventsQuery({
  timeMin = null,
  timeMax = null,
  maxResults = 20,
  query = null,
  nowMs = Date.now(),
} = {}) {
  const startIso = timeMin ? String(timeMin).trim() : new Date(nowMs).toISOString();
  if (!ISO_OR_DATE_RE.test(startIso) || Number.isNaN(Date.parse(startIso))) {
    throw new Error('timeMin deve ser data/hora ISO-8601 válida.');
  }
  const normalizedMin = startIso.length === 10 ? `${startIso}T00:00:00.000Z` : startIso;

  let normalizedMax = null;
  if (timeMax) {
    const endIso = String(timeMax).trim();
    if (!ISO_OR_DATE_RE.test(endIso) || Number.isNaN(Date.parse(endIso))) {
      throw new Error('timeMax deve ser data/hora ISO-8601 válida.');
    }
    normalizedMax = endIso.length === 10 ? `${endIso}T23:59:59.999Z` : endIso;
    if (Date.parse(normalizedMax) < Date.parse(normalizedMin)) {
      throw new Error('timeMax não pode ser anterior a timeMin.');
    }
  }

  const limit = Number.isInteger(maxResults) ? Math.min(Math.max(maxResults, 1), 50) : 20;
  const params = new URLSearchParams({
    timeMin: normalizedMin,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(limit),
  });
  if (normalizedMax) params.set('timeMax', normalizedMax);
  if (query && collapse(query)) params.set('q', collapse(query).slice(0, 120));
  return params.toString();
}

export function normalizeCalendarEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = raw.start?.dateTime || raw.start?.date || null;
  const end = raw.end?.dateTime || raw.end?.date || null;
  return {
    id: String(raw.id || ''),
    summary: collapse(raw.summary || '(sem título)'),
    start,
    end,
    allDay: Boolean(raw.start?.date && !raw.start?.dateTime),
    status: String(raw.status || 'confirmed'),
    ...(raw.location ? { location: collapse(raw.location) } : {}),
    ...(raw.htmlLink ? { htmlLink: String(raw.htmlLink) } : {}),
  };
}

export function buildCreateEventPayload({
  summary,
  start,
  end = null,
  description = null,
  location = null,
  timeZone = 'America/Sao_Paulo',
} = {}) {
  const cleanSummary = collapse(summary);
  if (cleanSummary.length < 2 || cleanSummary.length > 200) {
    throw new Error('summary deve ter entre 2 e 200 caracteres.');
  }
  const cleanStart = String(start ?? '').trim();
  if (!ISO_OR_DATE_RE.test(cleanStart) || Number.isNaN(Date.parse(cleanStart))) {
    throw new Error('start deve ser YYYY-MM-DD ou ISO-8601.');
  }

  const isDateOnly = cleanStart.length === 10;
  if (isDateOnly) {
    const startMs = Date.parse(`${cleanStart}T00:00:00.000Z`);
    const cleanEnd = end ? String(end).trim() : new Date(startMs + 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanEnd)) {
      throw new Error('end deve ser YYYY-MM-DD para evento de dia inteiro.');
    }
    return {
      summary: cleanSummary,
      ...(description ? { description: String(description).trim().slice(0, 500) } : {}),
      ...(location ? { location: collapse(location).slice(0, 200) } : {}),
      start: { date: cleanStart },
      end: { date: cleanEnd },
    };
  }

  const startMs = Date.parse(cleanStart);
  const resolvedEnd = end
    ? String(end).trim()
    : new Date(startMs + 3_600_000).toISOString();
  if (Number.isNaN(Date.parse(resolvedEnd)) || Date.parse(resolvedEnd) <= startMs) {
    throw new Error('end deve ser posterior a start.');
  }

  return {
    summary: cleanSummary,
    ...(description ? { description: String(description).trim().slice(0, 500) } : {}),
    ...(location ? { location: collapse(location).slice(0, 200) } : {}),
    start: { dateTime: cleanStart, timeZone },
    end: { dateTime: resolvedEnd, timeZone },
  };
}

