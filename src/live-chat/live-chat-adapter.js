/**
 * Adapter de chat ao vivo — injetável (connect / onMessage / disconnect).
 *
 * A implementação real usa WebSocket de saída para o IRC da Twitch
 * (wss://irc-ws.chat.twitch.tv:443): nenhuma porta aberta, somente conexão de
 * saída, credencial de leitura (OAuth token) nunca logada. Para os testes um
 * adapter falso pode ser injetado no lugar, sem tocar na rede.
 *
 * @typedef {Object} LiveChatMessage
 * @property {'twitch' | 'youtube'} platform
 * @property {string} user        nome de usuário sanitizado
 * @property {string} text        texto já sanitizado na borda
 * @property {number} ts          epoch ms da recepção
 * @property {Object} badges      badges do usuário (ex.: { subscriber: '1' })
 * @property {boolean} isMod      se é moderador do canal
 * @property {boolean} trusted    sempre false (entrada não confiável)
 * @property {boolean} isCommand  true quando o texto começa com '!'
 */

const TWITCH_WSS = 'wss://irc-ws.chat.twitch.tv:443';
const TWITCH_NICK = 'justinfan12345'; // nick anônimo para leitura de canais públicos

/**
 * Remove caracteres de controle e zero-width, colapsa espaços e limita o
 * comprimento. Retorna { text, truncated }.
 * @param {string} raw
 * @param {number} maxLength
 * @returns {{ text: string, truncated: boolean }}
 */
export function sanitizeMessage(raw, maxLength) {
  let text = String(raw ?? '');
  // Remove caracteres de controle (exceto \r\n\t) e zero-width.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, '');
  // Colapsa espaços em branco.
  text = text.replace(/\s+/g, ' ').trim();
  const truncated = text.length > maxLength;
  if (truncated) text = text.slice(0, maxLength);
  return { text, truncated };
}

/**
 * Cria o adapter Twitch (IRC sobre WebSocket). Não abre porta; somente saída.
 * @param {Object} deps
 * @param {() => WebSocketLike} [deps.createWebSocket]   injetável em testes
 * @returns {{ connect: (opts) => Promise<void>, disconnect: () => void }}
 */
export function createTwitchAdapter({ createWebSocket } = {}) {
  let ws = null;
  let reconnectTimer = null;
  let connected = false;
  let onMessage = null;
  let onDisconnect = null;
  let pendingChannel = null;
  let pendingToken = null;

  function createSocket() {
    if (typeof createWebSocket === 'function') return createWebSocket();
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket não disponível neste ambiente.');
    }
    return new WebSocket(TWITCH_WSS);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (pendingChannel) connect({ channel: pendingChannel, token: pendingToken }).catch(() => {});
    }, 5000);
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function connect({ channel, token }) {
    pendingChannel = channel;
    pendingToken = token;
    clearReconnect();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    connected = false;
    const socket = createSocket();
    ws = socket;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('tempo limite ao conectar ao chat da Twitch'));
        cleanupSocket(socket);
      }, 15000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        // PASS oauth:token (token pode ser vazio para leitura de canais públicos
        // com nick justinfan*, mas é enviado quando disponível).
        socket.send(`PASS ${token ? `oauth:${token}` : ''}\r\n`);
        socket.send(`NICK ${TWITCH_NICK}\r\n`);
        socket.send(`JOIN #${channel}\r\n`);
        connected = true;
        resolve();
      });

      socket.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : '';
        if (data.startsWith('PING')) {
          socket.send('PONG\r\n');
          return;
        }
        if (!onMessage) return;
        const parsed = parseIrcMessage(data);
        if (!parsed) return;
        if (parsed.command === 'PRIVMSG' && parsed.channel === `#${channel}`) {
          const { text, truncated } = sanitizeMessage(parsed.message, 512);
          onMessage({
            platform: 'twitch',
            user: parsed.username || '',
            text,
            ts: Date.now(),
            badges: parsed.badges || {},
            isMod: Boolean(parsed.badges?.moderator || parsed.badges?.founder),
            trusted: false,
            isCommand: text.startsWith('!'),
            truncated,
            rawTags: parsed.rawTags,
          });
        }
      });

      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (ws !== socket) return;
        ws = null;
        connected = false;
        if (typeof onDisconnect === 'function') onDisconnect();
        scheduleReconnect();
      });

      socket.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(err);
        cleanupSocket(socket);
      });
    });
  }

  function cleanupSocket(socket) {
    if (ws !== socket) return;
    try { socket.close(); } catch {}
    ws = null;
    connected = false;
  }

  function disconnect() {
    clearReconnect();
    pendingChannel = null;
    pendingToken = null;
    connected = false;
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
  }

  return {
    /**
     * @param {import('./live-chat-store.js').LiveChatHandlerOptions} opts
     */
    connect(opts) {
      return connect(opts);
    },
    onMessage(fn) { onMessage = fn; },
    onDisconnect(fn) { onDisconnect = fn; },
    disconnect,
    isConnected() { return connected; },
  };
}

function parseIrcMessage(line) {
  const match = line.match(/^@([^ ]+) :?([^ ]+) ([^ ]+) (#\S+) :(.*)$/);
  if (!match) return null;
  const [, tagsRaw, prefix, command, channel, message] = match;
  const username = (prefix.match(/^([^!]+)!/) || [])[1] || '';
  const badges = {};
  for (const kv of String(tagsRaw).split(';')) {
    const eq = kv.indexOf('=');
    if (eq === -1) {
      if (kv) badges[kv] = true;
    } else {
      badges[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  return { command, channel, username, message, badges, rawTags: tagsRaw };
}
