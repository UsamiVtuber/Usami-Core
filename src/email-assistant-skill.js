/**
 * Skill operacional Email Assistant (Gmail API v1 via Google OAuth2).
 *
 * Publica `skills/email-assistant` em `dataDir/skills` quando ausente e
 * registra:
 *  - `email.list` (nível 3): lista mensagens e metadados no Gmail;
 *  - `email.draft` (nível 3): cria rascunho reversível no Gmail;
 *  - `email.send` (nível 4): envia e-mail (exige confirmação humana S5).
 */
import { AGENT_SCHEMAS } from './agent-contracts.js';
import { createGoogleAuthClient } from './google-auth.js';
import { publishSkillPackage } from './skill-package.js';
import {
  EMAIL_SCHEMA,
  encodeMimeMessage,
  normalizeGmailMessage,
  validateRecipient,
} from '../skills/email-assistant/email-core.mjs';

export const EMAIL_ASSISTANT_SKILL_ID = 'email-assistant';
export const EMAIL_ASSISTANT_TOOLS = Object.freeze(['email.list', 'email.draft', 'email.send']);

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function publishEmailAssistantSkill({ dataDir, bundledDir } = {}) {
  return publishSkillPackage({ skillId: EMAIL_ASSISTANT_SKILL_ID, dataDir, bundledDir });
}

export function createEmailAssistantTools({
  googleAuth = createGoogleAuthClient(),
} = {}) {
  const listTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'email.list',
    version: '1.0.0',
    description: 'Lista mensagens recentes ou filtradas na caixa do Gmail (somente metadados e snippet).',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 15000,
    parameters: [
      { name: 'query', type: 'string', required: false, description: 'Query de busca Gmail (ex.: is:unread).' },
      { name: 'maxResults', type: 'number', required: false, description: 'Máximo de mensagens (1 a 20, padrão 10).' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === EMAIL_SCHEMA
        && Array.isArray(result.messages);
    },
    async execute(args = {}) {
      if (typeof googleAuth.callN8nAssistant === 'function' && googleAuth.isN8nConfigured?.()) {
        const res = await googleAuth.callN8nAssistant({
          action: 'list_emails',
          params: { query: args.query, maxResults: args.maxResults },
        });
        if (res && res.ok && Array.isArray(res.messages)) {
          return {
            ok: true,
            schema: EMAIL_SCHEMA,
            provider: 'gmail-n8n',
            count: res.messages.length,
            messages: res.messages,
          };
        }
      }
      const limit = Number.isInteger(args.maxResults) ? Math.min(Math.max(args.maxResults, 1), 20) : 10;
      const params = new URLSearchParams({ maxResults: String(limit) });
      if (typeof args.query === 'string' && args.query.trim()) {
        params.set('q', args.query.trim().slice(0, 200));
      }
      const listed = await googleAuth.requestJson(`${GMAIL_API_BASE}/messages?${params.toString()}`);
      const refs = Array.isArray(listed.messages) ? listed.messages.slice(0, limit) : [];

      const messages = [];
      for (const ref of refs) {
        if (!ref?.id) continue;
        const meta = await googleAuth.requestJson(
          `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        const normalized = normalizeGmailMessage(meta);
        if (normalized) messages.push(normalized);
      }

      return {
        ok: true,
        schema: EMAIL_SCHEMA,
        provider: 'gmail',
        count: messages.length,
        messages,
      };
    },
  };

  const draftTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'email.draft',
    version: '1.0.0',
    description: 'Cria um rascunho de e-mail no Gmail sem enviar.',
    origin: 'skill',
    permissionLevel: 3,
    timeoutMs: 12000,
    parameters: [
      { name: 'to', type: 'string', required: true, description: 'E-mail do destinatário.' },
      { name: 'subject', type: 'string', required: true, description: 'Assunto da mensagem.' },
      { name: 'body', type: 'string', required: true, description: 'Texto do corpo (até 500 chars).' },
      { name: 'cc', type: 'string', required: false, description: 'Cópia opcional.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === EMAIL_SCHEMA
        && typeof result.draftId === 'string'
        && result.draftId.length > 0;
    },
    async execute(args = {}) {
      const to = validateRecipient(args.to);
      const raw = encodeMimeMessage({
        to,
        subject: args.subject,
        body: args.body,
        cc: args.cc ?? null,
      });
      const created = await googleAuth.requestJson(`${GMAIL_API_BASE}/drafts`, {
        method: 'POST',
        body: { message: { raw } },
      });
      if (!created?.id) throw new Error('Gmail não retornou id do rascunho.');
      return {
        ok: true,
        schema: EMAIL_SCHEMA,
        provider: 'gmail',
        draftId: String(created.id),
        to,
        subject: String(args.subject).trim(),
      };
    },
  };

  const sendTool = {
    schema: AGENT_SCHEMAS.tool,
    name: 'email.send',
    version: '1.0.0',
    description: 'Envia um e-mail via Gmail (ação externa irreversível, exige confirmação humana nível 4).',
    origin: 'skill',
    permissionLevel: 4,
    timeoutMs: 12000,
    parameters: [
      { name: 'to', type: 'string', required: true, description: 'E-mail do destinatário.' },
      { name: 'subject', type: 'string', required: true, description: 'Assunto da mensagem.' },
      { name: 'body', type: 'string', required: true, description: 'Texto do corpo (até 500 chars).' },
      { name: 'cc', type: 'string', required: false, description: 'Cópia opcional.' },
    ],
    verify(result) {
      return isPlainObject(result)
        && result.ok === true
        && result.schema === EMAIL_SCHEMA
        && result.sent === true
        && typeof result.messageId === 'string'
        && result.messageId.length > 0;
    },
    async execute(args = {}) {
      const to = validateRecipient(args.to);
      const raw = encodeMimeMessage({
        to,
        subject: args.subject,
        body: args.body,
        cc: args.cc ?? null,
      });
      const sent = await googleAuth.requestJson(`${GMAIL_API_BASE}/messages/send`, {
        method: 'POST',
        body: { raw },
      });
      if (!sent?.id) throw new Error('Gmail não retornou id da mensagem enviada.');
      return {
        ok: true,
        schema: EMAIL_SCHEMA,
        provider: 'gmail',
        sent: true,
        messageId: String(sent.id),
        to,
        subject: String(args.subject).trim(),
      };
    },
  };

  return [listTool, draftTool, sendTool];
}

