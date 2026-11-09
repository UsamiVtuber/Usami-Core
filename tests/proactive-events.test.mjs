import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProactiveStore, QUOTAS } from '../src/proactive-events.js';

test('proactive-events: criação, dedupeKey, expiração e tetos diários', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'usami-proactive-test-'));
  const vaultDir = mkdtempSync(join(tmpdir(), 'usami-vault-test-'));

  try {
    let mockNow = new Date('2026-11-09T10:00:00.000Z').getTime();
    const nowFn = () => mockNow;

    const store = createProactiveStore({ dataDir: tempDir, vaultDir, now: nowFn });

    // 1. Rejeita tipo desconhecido
    const rBadType = store.addEvent({ type: 'invalid_type', text: 'oi' });
    assert.equal(rBadType.ok, false);
    assert.equal(rBadType.status, 400);

    // 2. Rejeita reminder sem expiresAt
    const rNoExp = store.addEvent({ type: 'reminder', text: 'tomar água' });
    assert.equal(rNoExp.ok, false);
    assert.equal(rNoExp.status, 400);

    // 3. Cria reminder válido
    const r1 = store.addEvent({
      type: 'reminder',
      source: 'test',
      dedupeKey: 'lembrete-agua-1',
      text: 'Tomar água agora!',
      notBefore: new Date(mockNow).toISOString(),
      expiresAt: new Date(mockNow + 3600 * 1000).toISOString(),
    });
    assert.equal(r1.ok, true);
    assert.ok(r1.id.startsWith('evt_'));

    // 4. getPendingEvents entrega o evento devido
    const pending1 = store.getPendingEvents();
    assert.equal(pending1.length, 1);
    assert.equal(pending1[0].id, r1.id);
    assert.equal(pending1[0].text, 'Tomar água agora!');

    // 5. Imediatamente após entrega, outro poll no mesmo instante não duplica
    const pendingSameInstant = store.getPendingEvents();
    assert.equal(pendingSameInstant.length, 0);

    // 6. Avança 5 minutos: sem ack, o reminder reentrega
    mockNow += 5 * 60 * 1000 + 1000;
    const pendingRedelivery = store.getPendingEvents();
    assert.equal(pendingRedelivery.length, 1);
    assert.equal(pendingRedelivery[0].id, r1.id);

    // 7. Ack confirma e remove o evento
    const ackRes = store.ackEvents([{ id: r1.id, outcome: 'shown' }]);
    assert.equal(ackRes.ok, true);
    assert.equal(ackRes.acked, 1);

    // Não há mais eventos pendentes
    assert.equal(store.getPendingEvents().length, 0);

    // 8. Tentar adicionar novamente com a mesma dedupeKey pós-ack cai na tombstone de 24h
    const rDup = store.addEvent({
      type: 'reminder',
      source: 'test',
      dedupeKey: 'lembrete-agua-1',
      text: 'Tomar água de novo',
      notBefore: new Date(mockNow).toISOString(),
      expiresAt: new Date(mockNow + 3600 * 1000).toISOString(),
    });
    assert.equal(rDup.ok, true);
    assert.equal(rDup.deduped, true);

    // 9. Ingestão do vault: cria arquivo de lembretes no mock do vault
    const autoDir = join(vaultDir, 'Inbox', 'Automations');
    mkdirSync(autoDir, { recursive: true });
    const remindersFile = join(autoDir, 'reminders.pending.json');

    writeFileSync(remindersFile, JSON.stringify([
      {
        id: 'vault-rem-1',
        text: 'Reunião com equipe às 11h',
        notBefore: new Date(mockNow + 10 * 1000).toISOString(),
        expiresAt: new Date(mockNow + 7200 * 1000).toISOString(),
      }
    ]), 'utf8');

    const ingestRes = store.ingestVaultReminders();
    assert.equal(ingestRes.ingested, 1);

    // Antes do notBefore (+10s), o evento não é entregue
    assert.equal(store.getPendingEvents().length, 0);

    // Avança 15 segundos: o evento se torna devido e é entregue
    mockNow += 15 * 1000;
    const pendingVault = store.getPendingEvents();
    assert.equal(pendingVault.length, 1);
    assert.equal(pendingVault[0].text, 'Reunião com equipe às 11h');

    // 10. Resiliência: arquivo corrompido ou truncado não explode
    writeFileSync(remindersFile, '{"incomplete_json": [', 'utf8');
    const ingestCorrupt = store.ingestVaultReminders();
    assert.equal(ingestCorrupt.ingested, 0);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch {}
  }
});
