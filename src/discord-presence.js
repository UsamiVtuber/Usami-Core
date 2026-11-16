/**
 * Discord Rich Presence para a Usami via Discord IPC (Named Pipe / Unix Domain Socket).
 *
 * Conecta-se diretamente ao cliente desktop do Discord em execução na máquina
 * sem dependências externas adicionais, exibindo a Usami como uma atividade/jogo
 * com detalhes de humor, afinidade e interação em tempo real.
 */

import net from 'node:net';

export const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

export const DEFAULT_CLIENT_ID = '1571656265107771392';
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos sem interação = idle
export const DEFAULT_RECONNECT_INTERVAL_MS = 15 * 1000; // tenta reconectar a cada 15s

/**
 * Codifica um pacote Discord IPC com header de 8 bytes (opcode Int32LE + length Int32LE).
 */
export function encodePacket(opcode, payload) {
  const jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const payloadBuf = Buffer.from(jsonStr, 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

/**
 * Decodifica um pacote Discord IPC a partir de um Buffer.
 */
export function decodePacket(buffer) {
  if (!buffer || buffer.length < 8) return null;
  const opcode = buffer.readInt32LE(0);
  const length = buffer.readInt32LE(4);
  if (buffer.length < 8 + length) return null;

  const bodyStr = buffer.subarray(8, 8 + length).toString('utf8');
  let data = null;
  try {
    data = JSON.parse(bodyStr);
  } catch {
    data = bodyStr;
  }
  return { opcode, length, data, bytesConsumed: 8 + length };
}

/**
 * Retorna o caminho do pipe/socket IPC do Discord conforme o sistema operacional.
 */
export function getIpcPath(index = 0) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\discord-ipc-${index}`;
  }
  const prefix = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return `${prefix.replace(/\/+$/, '')}/discord-ipc-${index}`;
}

export function createDiscordPresence(options = {}) {
  const clientId = options.clientId ||
    process.env.DISCORD_APPLICATION_ID ||
    process.env.DISCORD_APLICATION_ID ||
    DEFAULT_CLIENT_ID;

  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const reconnectIntervalMs = options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
  const netConnect = options.netConnect || net.connect;
  const now = options.now || (() => Date.now());

  let socket = null;
  let connected = false;
  let user = null;
  let currentPipeIndex = 0;
  let reconnectTimer = null;
  let idleTimer = null;
  let sessionStartTime = Math.floor(now() / 1000);
  let active = false;
  let currentActivity = null;
  let lastAffinityStage = 'Amiga';
  let lastEmotion = 'neutral';

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      setIdle();
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function sendFrame(payload) {
    if (!socket || !connected) return false;
    try {
      const packet = encodePacket(OPCODES.FRAME, payload);
      socket.write(packet);
      return true;
    } catch {
      return false;
    }
  }

  function setActivity(activity) {
    currentActivity = activity;
    if (!connected) return false;

    const payload = {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: activity ? {
          ...activity,
          timestamps: activity.timestamps || { start: sessionStartTime },
        } : null,
      },
      nonce: `${now()}-${Math.random().toString(36).slice(2, 7)}`,
    };

    return sendFrame(payload);
  }

  function buildDefaultActivity(details, state, extra = {}) {
    return {
      details: details || 'No quarto virtual',
      state: state || `Afinidade: ${lastAffinityStage}`,
      timestamps: { start: sessionStartTime },
      assets: {
        large_image: extra.large_image || 'usami',
        large_text: extra.large_text || 'Usami Companion',
        ...(extra.small_image ? { small_image: extra.small_image } : {}),
        ...(extra.small_text ? { small_text: extra.small_text } : {}),
      },
      ...(Array.isArray(extra.buttons) && extra.buttons.length > 0 ? { buttons: extra.buttons } : {}),
    };
  }

  function setIdle() {
    const activity = buildDefaultActivity(
      'Descansando no quarto virtual',
      `Afinidade: ${lastAffinityStage} • Ociosa 💤`,
      {
        small_image: 'sleep',
        small_text: 'Descansando',
      }
    );
    setActivity(activity);
  }

  function onChatTurnStart(meta = {}) {
    resetIdleTimer();
    const activity = buildDefaultActivity(
      'Pensando em uma resposta...',
      `Afinidade: ${lastAffinityStage} • Conversando 💬`,
      {
        small_image: 'thinking',
        small_text: 'Raciocinando',
      }
    );
    setActivity(activity);
  }

  function onChatTurnEnd(meta = {}) {
    resetIdleTimer();
    if (meta.stage) lastAffinityStage = meta.stage;
    if (meta.emotion) lastEmotion = meta.emotion;

    const emotionLabel = {
      happy: 'Alegre ✨',
      tsundere: 'Tsundere 💢',
      surprised: 'Surpresa 💡',
      thinking: 'Pensativa 💭',
      neutral: 'Atenta',
      sad: 'Pensativa...',
      angry: 'Brava 💢',
    }[lastEmotion] || 'Atenta';

    const activity = buildDefaultActivity(
      meta.details || 'Conversando com o Mestre',
      meta.state || `Afinidade: ${lastAffinityStage} • Humor: ${emotionLabel}`,
      {
        small_image: lastEmotion,
        small_text: `Humor: ${emotionLabel}`,
      }
    );
    setActivity(activity);
  }

  function connectToPipe(pipeIndex = 0) {
    if (!active) return;
    if (pipeIndex > 9) {
      // Nenhum pipe respondeu; Discord pode estar fechado. Tenta de novo após intervalo.
      scheduleReconnect();
      return;
    }

    currentPipeIndex = pipeIndex;
    const pipePath = getIpcPath(pipeIndex);

    try {
      const s = netConnect(pipePath);

      s.once('connect', () => {
        socket = s;
        // Envia Handshake Opcode 0
        const handshakePacket = encodePacket(OPCODES.HANDSHAKE, {
          v: 1,
          client_id: clientId,
        });
        s.write(handshakePacket);
      });

      let incomingBuffer = Buffer.alloc(0);

      s.on('data', (chunk) => {
        incomingBuffer = Buffer.concat([incomingBuffer, chunk]);

        while (incomingBuffer.length >= 8) {
          const packet = decodePacket(incomingBuffer);
          if (!packet) break;

          incomingBuffer = incomingBuffer.subarray(packet.bytesConsumed);
          handleIncomingPacket(packet);
        }
      });

      s.on('error', () => {
        cleanupSocket();
        connectToPipe(pipeIndex + 1);
      });

      s.on('close', () => {
        cleanupSocket();
        if (active) {
          scheduleReconnect();
        }
      });
    } catch {
      connectToPipe(pipeIndex + 1);
    }
  }

  function cleanupSocket() {
    connected = false;
    user = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {}
      socket = null;
    }
  }

  function handleIncomingPacket(packet) {
    const data = packet.data;
    if (!data || typeof data !== 'object') return;

    if (data.evt === 'READY') {
      connected = true;
      user = data.data?.user || null;
      // Define a atividade atual ou a inicial
      if (currentActivity) {
        setActivity(currentActivity);
      } else {
        setActivity(buildDefaultActivity('Pronta no quarto virtual', `Afinidade: ${lastAffinityStage} ✨`));
      }
      resetIdleTimer();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || !active) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToPipe(0);
    }, reconnectIntervalMs);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function start() {
    if (active) return;
    active = true;
    sessionStartTime = Math.floor(now() / 1000);
    connectToPipe(0);
  }

  function stop() {
    active = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (socket && connected) {
      try {
        // Envia SET_ACTIVITY com null para limpar a presença antes de sair
        const clearPayload = {
          cmd: 'SET_ACTIVITY',
          args: { pid: process.pid, activity: null },
          nonce: 'shutdown',
        };
        sendFrame(clearPayload);
      } catch {}
    }
    cleanupSocket();
  }

  function getStatus() {
    return {
      active,
      connected,
      user,
      currentPipeIndex,
      currentActivity,
      sessionStartTime,
      affinityStage: lastAffinityStage,
      emotion: lastEmotion,
    };
  }

  return {
    start,
    stop,
    setActivity,
    setIdle,
    onChatTurnStart,
    onChatTurnEnd,
    getStatus,
  };
}
