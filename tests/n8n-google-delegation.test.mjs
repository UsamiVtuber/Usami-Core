import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAuthClient } from '../src/google-auth.js';
import { createEmailAssistantTools } from '../src/email-assistant-skill.js';
import { createCalendarManagerTools } from '../src/calendar-manager-skill.js';

test('n8n-google-delegation: email.list e calendar.list delegam para webhook do n8n com sucesso', async () => {
  const mockCalls = [];

  const mockFetch = async (url, options) => {
    mockCalls.push({ url, body: JSON.parse(options.body) });
    const payload = JSON.parse(options.body);

    if (payload.action === 'list_emails') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          action: 'list_emails',
          count: 1,
          messages: [
            {
              id: 'msg-n8n-1',
              threadId: 'th-1',
              from: 'chefe@empresa.com',
              to: 'usuario@empresa.com',
              subject: 'Reunião de Alinhamento',
              date: '2026-11-12T10:00:00Z',
              snippet: 'Podemos alinhar o projeto hoje às 14h?',
            },
          ],
        }),
      };
    }

    if (payload.action === 'list_events') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          action: 'list_events',
          count: 1,
          events: [
            {
              id: 'evt-n8n-1',
              summary: 'Daily Scrum',
              start: '2026-11-12T14:00:00Z',
              end: '2026-11-12T14:30:00Z',
              description: 'Alinhamento rápido da sprint',
              location: 'Google Meet',
            },
          ],
        }),
      };
    }

    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };

  const googleAuth = createGoogleAuthClient({
    envProvider: (name) => (name === 'N8N_GOOGLE_WEBHOOK_URL' ? 'http://localhost:5678/webhook/usami-google' : null),
    fetchImpl: mockFetch,
  });

  assert.equal(googleAuth.isN8nConfigured(), true);
  assert.equal(googleAuth.isConfigured(), true);

  const [emailListTool] = createEmailAssistantTools({ googleAuth });
  const emailRes = await emailListTool.execute({ maxResults: 5 });

  assert.equal(emailRes.ok, true);
  assert.equal(emailRes.provider, 'gmail-n8n');
  assert.equal(emailRes.count, 1);
  assert.equal(emailRes.messages[0].subject, 'Reunião de Alinhamento');
  assert.equal(emailListTool.verify(emailRes), true);

  const [calendarListTool] = createCalendarManagerTools({ googleAuth });
  const calRes = await calendarListTool.execute({});

  assert.equal(calRes.ok, true);
  assert.equal(calRes.provider, 'google-calendar-n8n');
  assert.equal(calRes.count, 1);
  assert.equal(calRes.events[0].summary, 'Daily Scrum');
  assert.equal(calendarListTool.verify(calRes), true);

  assert.equal(mockCalls.length, 2);
  assert.equal(mockCalls[0].body.action, 'list_emails');
  assert.equal(mockCalls[1].body.action, 'list_events');
});

