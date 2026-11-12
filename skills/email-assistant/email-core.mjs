export const EMAIL_SCHEMA = 'usami.google.gmail.v1';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SAFE_HEADER_TEXT = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export function validateRecipient(to) {
  const clean = SAFE_HEADER_TEXT(to);
  if (!EMAIL_RE.test(clean) || clean.length > 200) {
    throw new Error('destinatário (to) inválido.');
  }
  return clean;
}

export function encodeMimeMessage({ to, subject, body, cc = null } = {}) {
  const safeTo = validateRecipient(to);
  const safeSubject = SAFE_HEADER_TEXT(subject);
  if (!safeSubject || safeSubject.length > 200) {
    throw new Error('subject deve ter entre 1 e 200 caracteres.');
  }
  const cleanBody = String(body ?? '').trim();
  if (!cleanBody || cleanBody.length > 10000) {
    throw new Error('body deve ter entre 1 e 10000 caracteres.');
  }

  const headers = [
    `To: ${safeTo}`,
    ...(cc ? [`Cc: ${validateRecipient(cc)}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    cleanBody,
  ];
  const raw = headers.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function normalizeGmailMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const headerList = Array.isArray(msg.payload?.headers) ? msg.payload.headers : [];
  const header = name => {
    const found = headerList.find(h => String(h?.name || '').toLowerCase() === name.toLowerCase());
    return found ? SAFE_HEADER_TEXT(found.value) : '';
  };
  return {
    id: String(msg.id || ''),
    threadId: String(msg.threadId || ''),
    from: header('From'),
    to: header('To'),
    subject: header('Subject') || '(sem assunto)',
    date: header('Date'),
    snippet: SAFE_HEADER_TEXT(msg.snippet || '').slice(0, 240),
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds.map(String) : [],
  };
}

