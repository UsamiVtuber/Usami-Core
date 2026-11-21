/**
 * Notificador Multicanal da Usami (Windows Toast, Discord, Companion).
 *
 * Dispara notificações visuais e sonoras no Windows (WinRT Toast via PowerShell),
 * no Discord (via DM ou canal de chat configurado) e na fila de comandos
 * proativos da companion para animação e fala do avatar.
 */
import { execFile } from 'node:child_process';

/**
 * Dispara notificação nativa do Windows 10/11 (Toast Notification).
 */
export function notifyWindows({
  title = 'Usami Companion',
  message = '',
  sound = true,
  execFileImpl = execFile,
} = {}) {
  if (process.platform !== 'win32') return false;

  const escapeXml = str => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const cleanTitle = escapeXml(title);
  const cleanMessage = escapeXml(message);
  const audioXml = sound ? '<audio src="ms-winsoundevent:Notification.Default" />' : '<audio silent="true" />';
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${cleanTitle}</text><text>${cleanMessage}</text></binding></visual>${audioXml}</toast>`;

  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('${xml}')`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)`,
  ].join('; ');

  try {
    execFileImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => {
      if (err) {
        // Fallback silencioso: log leve sem interromper o processo
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Envia notificação para o Discord (DM direta ou canal de chat).
 */
export async function notifyDiscord({
  content = '',
  embed = null,
  botToken = process.env.DISCORD_BOT_TOKEN,
  userId = process.env.DISCORD_USER_ID,
  channelId = process.env.DISCORD_CHAT_CHANNEL_ID,
  webhookUrl = process.env.DISCORD_WEBHOOK_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  // 1. Webhook se configurado
  if (webhookUrl) {
    try {
      const body = { content, ...(embed ? { embeds: [embed] } : {}) };
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, mode: 'webhook' };
    } catch (err) {
      console.warn('[notifier] falha ao enviar para Discord via webhook:', err?.message || err);
    }
  }

  if (!botToken) return { ok: false, error: 'DISCORD_BOT_TOKEN ausente' };

  const authHeader = {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  };

  // 2. DM direta para o usuário se userId estiver configurado
  if (userId) {
    try {
      const dmChannelRes = await fetchImpl('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (dmChannelRes.ok) {
        const dmData = await dmChannelRes.json();
        const dmChannelId = dmData?.id;
        if (dmChannelId) {
          const sendRes = await fetchImpl(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              content,
              ...(embed ? { embeds: [embed] } : {}),
            }),
          });
          return { ok: sendRes.ok, status: sendRes.status, mode: 'dm' };
        }
      }
    } catch (err) {
      console.warn('[notifier] falha ao enviar DM no Discord, tentando canal público:', err?.message || err);
    }
  }

  // 3. Fallback: Canal do servidor
  if (channelId) {
    try {
      const sendRes = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          content: userId ? `<@${userId}> ${content}` : content,
          ...(embed ? { embeds: [embed] } : {}),
        }),
      });
      return { ok: sendRes.ok, status: sendRes.status, mode: 'channel' };
    } catch (err) {
      console.warn('[notifier] falha ao enviar para canal do Discord:', err?.message || err);
    }
  }

  return { ok: false, error: 'nenhum canal ou usuário válido configurado' };
}

/**
 * Envia notificação para todos os canais selecionados.
 */
export async function broadcastNotification({
  title = 'Usami Companion',
  message = '',
  channels = ['windows', 'discord', 'companion'],
  n8nQueue = null,
  clientId = null,
  sound = true,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
} = {}) {
  const results = {};

  if (channels.includes('windows')) {
    results.windows = notifyWindows({ title, message, sound, execFileImpl });
  }

  if (channels.includes('discord')) {
    try {
      const discordRes = await notifyDiscord({
        content: `**${title}**\n${message}`,
        fetchImpl,
      });
      results.discord = discordRes;
    } catch (err) {
      results.discord = { ok: false, error: String(err?.message || err) };
    }
  }

  if (channels.includes('companion') && n8nQueue && typeof n8nQueue.enqueue === 'function') {
    n8nQueue.enqueue({
      id: Math.random().toString(36).slice(2, 10),
      type: 'proactive_say',
      message,
      emotion: 'casual_happy',
      gesture: 'nod',
      timestamp: new Date().toISOString(),
    }, { clientId });
    results.companion = true;
  }

  return results;
}
