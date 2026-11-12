import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeMimeMessage,
  normalizeGmailMessage,
  validateRecipient,
} from '../email-core.mjs';

test('validateRecipient bloqueia injeção de cabeçalho e e-mail inválido', () => {
  assert.equal(validateRecipient('user@example.com'), 'user@example.com');
  assert.throws(() => validateRecipient('invalido'), /inválido/);
  assert.throws(() => validateRecipient('a@b.com\r\nBcc: evil@x.com'), /inválido/);
});

test('encodeMimeMessage codifica base64url e normalizeGmailMessage extrai headers', () => {
  const raw = encodeMimeMessage({
    to: 'amiga@example.com',
    subject: 'Resumo do dia',
    body: 'Oi! Segue o resumo.',
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^To: amiga@example\.com/m);
  assert.match(decoded, /Oi! Segue o resumo\./);

  const msg = normalizeGmailMessage({
    id: 'msg-1',
    threadId: 'thr-1',
    snippet: 'Olá mundo',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Ana <ana@example.com>' },
        { name: 'Subject', value: 'Alinhamento' },
        { name: 'Date', value: 'Wed, 11 Nov 2026 10:00:00 -0300' },
      ],
    },
  });
  assert.equal(msg.subject, 'Alinhamento');
  assert.equal(msg.from, 'Ana <ana@example.com>');
  assert.deepEqual(msg.labelIds, ['INBOX', 'UNREAD']);
});

