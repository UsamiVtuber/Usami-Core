import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateEventPayload,
  buildListEventsQuery,
  normalizeCalendarEvent,
  sanitizeCalendarId,
  sanitizeEventId,
} from '../calendar-core.mjs';

test('buildListEventsQuery valida datas e monta query Google Calendar', () => {
  const qs = buildListEventsQuery({
    timeMin: '2026-11-11',
    timeMax: '2026-11-12',
    maxResults: 10,
    query: 'reunião',
  });
  assert.match(qs, /timeMin=2026-11-11T00%3A00%3A00\.000Z/);
  assert.match(qs, /singleEvents=true/);
  assert.match(qs, /maxResults=10/);

  assert.throws(() => buildListEventsQuery({ timeMin: '2026-11-12', timeMax: '2026-11-11' }), /anterior/);
  assert.throws(() => sanitizeCalendarId('../etc'), /inválido/);
  assert.throws(() => sanitizeEventId('a/b'), /inválido/);
});

test('buildCreateEventPayload e normalizeCalendarEvent suportam evento com horário e dia inteiro', () => {
  const timed = buildCreateEventPayload({
    summary: 'Sync Usami',
    start: '2026-11-11T15:00:00-03:00',
  });
  assert.equal(timed.start.dateTime, '2026-11-11T15:00:00-03:00');
  assert.ok(timed.end.dateTime);

  const normalized = normalizeCalendarEvent({
    id: 'evt12345',
    summary: 'Sync Usami',
    start: { dateTime: '2026-11-11T15:00:00-03:00' },
    end: { dateTime: '2026-11-11T16:00:00-03:00' },
    status: 'confirmed',
  });
  assert.equal(normalized.id, 'evt12345');
  assert.equal(normalized.allDay, false);
});

