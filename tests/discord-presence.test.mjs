import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  OPCODES,
  DEFAULT_CLIENT_ID,
  encodePacket,
  decodePacket,
  getIpcPath,
  createDiscordPresence,
} from '../src/discord-presence.js';

test('discord-presence: encodePacket e decodePacket serializam e deserializam corretamente', () => {
  const payload = { test: 123, msg: 'usami' };
  const encoded = encodePacket(OPCODES.FRAME, payload);

  assert.equal(encoded.readInt32LE(0), OPCODES.FRAME);
  const length = encoded.readInt32LE(4);
  assert.equal(encoded.length, 8 + length);

  const decoded = decodePacket(encoded);
  assert.ok(decoded);
  assert.equal(decoded.opcode, OPCODES.FRAME);
  assert.deepEqual(decoded.data, payload);
  assert.equal(decoded.bytesConsumed, encoded.length);
});

test('discord-presence: decodePacket devolve null se o buffer for incompleto', () => {
  const payload = { foo: 'bar' };
  const encoded = encodePacket(OPCODES.HANDSHAKE, payload);

  assert.equal(decodePacket(encoded.subarray(0, 4)), null);
  assert.equal(decodePacket(encoded.subarray(0, 7)), null);
  assert.equal(decodePacket(encoded.subarray(0, 10)), null); // header completo, mas corpo parcial
  assert.ok(decodePacket(encoded)); // completo
});

test('discord-presence: getIpcPath gera caminhos válidos', () => {
  const path0 = getIpcPath(0);
  const path1 = getIpcPath(1);
  assert.ok(path0.includes('discord-ipc-0'));
  assert.ok(path1.includes('discord-ipc-1'));
});

test('discord-presence: fluxo completo com mock de socket (Handshake -> READY -> SET_ACTIVITY)', async () => {
  class MockSocket extends EventEmitter {
    constructor() {
      super();
      this.writes = [];
    }
    write(buf) {
      this.writes.push(buf);
    }
    destroy() {
      this.destroyed = true;
    }
  }

  const mockSocket = new MockSocket();
  let connectedPath = null;

  const mockNetConnect = (path) => {
    connectedPath = path;
    process.nextTick(() => mockSocket.emit('connect'));
    return mockSocket;
  };

  const presence = createDiscordPresence({
    clientId: 'test-client-123',
    netConnect: mockNetConnect,
    idleTimeoutMs: 50,
    now: () => 1700000000000,
  });

  presence.start();
  await new Promise((r) => setImmediate(r));

  // 1. Deve ter enviado handshake
  assert.equal(mockSocket.writes.length, 1);
  const handshake = decodePacket(mockSocket.writes[0]);
  assert.equal(handshake.opcode, OPCODES.HANDSHAKE);
  assert.equal(handshake.data.client_id, 'test-client-123');

  // 2. Simula resposta READY do Discord
  const readyPacket = encodePacket(OPCODES.FRAME, {
    evt: 'READY',
    data: { user: { username: 'Ruka', id: '123' } },
  });
  mockSocket.emit('data', readyPacket);

  // 3. Deve ter recebido o READY e disparado SET_ACTIVITY inicial
  assert.equal(mockSocket.writes.length, 2);
  const initialActivity = decodePacket(mockSocket.writes[1]);
  assert.equal(initialActivity.data.cmd, 'SET_ACTIVITY');
  assert.equal(initialActivity.data.args.activity.details, 'Pronta no quarto virtual');

  // 4. Teste de transição para chat turn start
  presence.onChatTurnStart();
  assert.equal(mockSocket.writes.length, 3);
  const chattingStart = decodePacket(mockSocket.writes[2]);
  assert.equal(chattingStart.data.args.activity.details, 'Pensando em uma resposta...');

  // 5. Teste de transição para chat turn end com emoção e afinidade
  presence.onChatTurnEnd({ emotion: 'tsundere', stage: 'Amiga Íntima' });
  assert.equal(mockSocket.writes.length, 4);
  const chattingEnd = decodePacket(mockSocket.writes[3]);
  assert.equal(chattingEnd.data.args.activity.details, 'Conversando com o Mestre');
  assert.ok(chattingEnd.data.args.activity.state.includes('Amiga Íntima'));
  assert.ok(chattingEnd.data.args.activity.state.includes('Tsundere'));

  // 6. Teste de transição para idle após o timeout
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mockSocket.writes.length, 5);
  const idleActivity = decodePacket(mockSocket.writes[4]);
  assert.equal(idleActivity.data.args.activity.details, 'Descansando no quarto virtual');

  // 7. Status deve refletir conexão ativa
  const status = presence.getStatus();
  assert.equal(status.active, true);
  assert.equal(status.connected, true);
  assert.equal(status.user.username, 'Ruka');

  // 8. Stop fecha a presença
  presence.stop();
  assert.equal(presence.getStatus().active, false);
});
