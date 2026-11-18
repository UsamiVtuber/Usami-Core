/**
 * Testes da skill Focus Guardian
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFocusGuardianCore } from '../focus-guardian-core.mjs';

describe('focus-guardian skill', () => {
  let tempDir;
  let guardian;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'usami-focus-guardian-'));
    guardian = createFocusGuardianCore({ dataDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- startFocusSession ---

  test('startFocusSession inicia sessão com perfil padrão', async () => {
    const result = await guardian.startFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.ok(result.session.id.startsWith('session-'));
    assert.strictEqual(result.session.status, 'active');
    assert.ok(typeof result.session.plannedDurationMinutes === 'number');
    assert.ok(result.profile);
    assert.ok(['Deep Work', 'Pomodoro', 'Light Focus'].includes(result.profile.name));
  });

  test('startFocusSession inicia sessão com perfil específico', async () => {
    const profiles = guardian.listProfiles();
    const pomodoro = profiles.profiles.find(p => p.name === 'Pomodoro');

    const result = await guardian.startFocusSession({ profileId: pomodoro.id });
    assert.strictEqual(result.session.profileId, pomodoro.id);
    assert.strictEqual(result.profile.name, 'Pomodoro');
    assert.strictEqual(result.session.plannedDurationMinutes, 25);
  });

  test('startFocusSession falha se já houver sessão ativa', async () => {
    await guardian.startFocusSession({});
    await assert.rejects(
      guardian.startFocusSession({}),
      /Já existe uma sessão ativa/
    );
  });

  test('startFocusSession usa duração customizada', async () => {
    const result = await guardian.startFocusSession({ plannedDurationMinutes: 45 });
    assert.strictEqual(result.session.plannedDurationMinutes, 45);
  });

  // --- pauseFocusSession ---

  test('pauseFocusSession pausa sessão ativa', async () => {
    await guardian.startFocusSession({});
    const result = await guardian.pauseFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.status, 'paused');
    assert.ok(result.session.pausedAt);
  });

  test('pauseFocusSession falha sem sessão ativa', async () => {
    await assert.rejects(
      guardian.pauseFocusSession({}),
      /nenhuma sessão ativa/
    );
  });

  test('pauseFocusSession falha se sessão não está ativa', async () => {
    await guardian.startFocusSession({});
    await guardian.pauseFocusSession({});
    await assert.rejects(
      guardian.pauseFocusSession({}),
      /sessão não está ativa/
    );
  });

  // --- resumeFocusSession ---

  test('resumeFocusSession retoma sessão pausada', async () => {
    await guardian.startFocusSession({});
    await guardian.pauseFocusSession({});

    // Small delay to ensure pausedAt is in the past
    await new Promise(r => setTimeout(r, 10));

    const result = await guardian.resumeFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.status, 'active');
    assert.strictEqual(result.session.pausedAt, null);
    assert.ok(result.session.totalPausedDurationMs > 0);
  });

  test('resumeFocusSession falha sem sessão pausada', async () => {
    await assert.rejects(
      guardian.resumeFocusSession({}),
      /nenhuma sessão pausada/
    );
  });

  // --- stopFocusSession ---

  test('stopFocusSession finaliza sessão ativa', async () => {
    await guardian.startFocusSession({ plannedDurationMinutes: 25 });
    // Small delay to ensure duration > 0
    await new Promise(r => setTimeout(r, 10));

    const result = await guardian.stopFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.status, 'completed');
    assert.ok(result.session.endedAt);
    assert.ok(result.actualDurationMinutes >= 0);
  });

  test('stopFocusSession finaliza sessão pausada', async () => {
    await guardian.startFocusSession({});
    await guardian.pauseFocusSession({});

    const result = await guardian.stopFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.status, 'completed');
  });

  test('stopFocusSession adiciona notas finais', async () => {
    await guardian.startFocusSession({ notes: 'início' });
    await new Promise(r => setTimeout(r, 10));
    const result = await guardian.stopFocusSession({ notes: 'fim' });
    assert.ok(result.session.notes.includes('início'));
    assert.ok(result.session.notes.includes('fim'));
  });

  test('stopFocusSession falha sem sessão ativa/pausada', async () => {
    await assert.rejects(
      guardian.stopFocusSession({}),
      /nenhuma sessão ativa\/pausada/
    );
  });

  // --- cancelFocusSession ---

  test('cancelFocusSession cancela sessão ativa', async () => {
    await guardian.startFocusSession({});
    const result = await guardian.cancelFocusSession({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.status, 'cancelled');
    assert.strictEqual(result.session.actualDurationMinutes, 0);
  });

  test('cancelFocusSession falha se sessão já finalizada', async () => {
    const started = await guardian.startFocusSession({});
    await guardian.stopFocusSession({});
    // Need to use sessionId since no active session
    await assert.rejects(
      guardian.cancelFocusSession({ sessionId: started.session.id }),
      /sessão já finalizada/
    );
  });

  // --- takeBreak ---

  test('takeBreak registra pausa na sessão ativa', async () => {
    await guardian.startFocusSession({});
    const result = await guardian.takeBreak({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.breaksTaken, 1);
  });

  test('takeBreak incrementa contador de pausas', async () => {
    await guardian.startFocusSession({});
    await guardian.takeBreak({});
    await guardian.takeBreak({});
    const result = await guardian.takeBreak({});
    assert.strictEqual(result.breaksTaken, 3);
  });

  test('takeBreak falha se sessão não ativa', async () => {
    await guardian.startFocusSession({});
    await guardian.pauseFocusSession({});
    await assert.rejects(
      guardian.takeBreak({}),
      /sessão deve estar ativa/
    );
  });

  // --- recordDistractionBlocked ---

  test('recordDistractionBlocked incrementa contador', async () => {
    await guardian.startFocusSession({});
    const result = await guardian.recordDistractionBlocked({ count: 3 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.distractionsBlocked, 3);
  });

  test('recordDistractionBlocked usa count padrão 1', async () => {
    await guardian.startFocusSession({});
    const result = await guardian.recordDistractionBlocked({});
    assert.strictEqual(result.distractionsBlocked, 1);
  });

  // --- getFocusStatus ---

  test('getFocusStatus retorna inactive quando sem sessão', () => {
    const result = guardian.getFocusStatus();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active, false);
  });

  test('getFocusStatus retorna progresso da sessão ativa', async () => {
    await guardian.startFocusSession({ plannedDurationMinutes: 60 });
    const result = guardian.getFocusStatus();
    assert.strictEqual(result.active, true);
    assert.ok(typeof result.session.actualDurationMinutes === 'number');
    assert.ok(typeof result.session.remainingMinutes === 'number');
    assert.ok(typeof result.session.progressPercent === 'number');
    assert.ok(result.profile);
  });

  test('getFocusStatus calcula progresso corretamente', async () => {
    await guardian.startFocusSession({ plannedDurationMinutes: 100 });
    const status = guardian.getFocusStatus();
    assert.ok(status.session.progressPercent >= 0 && status.session.progressPercent <= 100);
  });

  // --- listFocusSessions ---

  test('listFocusSessions lista sessões', async () => {
    await guardian.startFocusSession({});
    await new Promise(r => setTimeout(r, 10));
    await guardian.stopFocusSession({});

    await guardian.startFocusSession({});
    await guardian.cancelFocusSession({});

    const result = guardian.listFocusSessions({});
    assert.strictEqual(result.count, 2);
    assert.ok(result.sessions.length >= 2);
  });

  test('listFocusSessions filtra por status', async () => {
    await guardian.startFocusSession({});
    await guardian.stopFocusSession({});

    await guardian.startFocusSession({});
    await guardian.cancelFocusSession({});

    const completed = guardian.listFocusSessions({ status: 'completed' });
    assert.strictEqual(completed.count, 1);
    assert.strictEqual(completed.sessions[0].status, 'completed');

    const cancelled = guardian.listFocusSessions({ status: 'cancelled' });
    assert.strictEqual(cancelled.count, 1);
    assert.strictEqual(cancelled.sessions[0].status, 'cancelled');
  });

  test('listFocusSessions filtra por profileId', async () => {
    const profiles = guardian.listProfiles();
    const deepWork = profiles.profiles.find(p => p.name === 'Deep Work');
    const pomodoro = profiles.profiles.find(p => p.name === 'Pomodoro');

    await guardian.startFocusSession({ profileId: deepWork.id });
    await guardian.stopFocusSession({});

    await guardian.startFocusSession({ profileId: pomodoro.id });
    await guardian.stopFocusSession({});

    const result = guardian.listFocusSessions({ profileId: deepWork.id, status: 'completed' });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.sessions[0].profileId, deepWork.id);
  });

  // --- getFocusStats ---

  test('getFocusStats retorna estatísticas agregadas', async () => {
    await guardian.startFocusSession({ plannedDurationMinutes: 30 });
    await new Promise(r => setTimeout(r, 50)); // Longer delay for measurable duration
    await guardian.stopFocusSession({});

    await guardian.startFocusSession({ plannedDurationMinutes: 20 });
    await new Promise(r => setTimeout(r, 50));
    await guardian.stopFocusSession({});

    const stats = guardian.getFocusStats({});
    assert.strictEqual(stats.totalSessions, 2);
    assert.ok(stats.totalMinutes >= 0); // May be 0 if very fast
    assert.strictEqual(stats.totalBreaks, 0);
    assert.strictEqual(stats.totalDistractionsBlocked, 0);
    assert.ok(typeof stats.avgDurationMinutes === 'number');
    assert.ok(typeof stats.byDate === 'object');
  });

  test('getFocusStats filtra por profileId', async () => {
    const profiles = guardian.listProfiles();
    const pomodoro = profiles.profiles.find(p => p.name === 'Pomodoro');

    await guardian.startFocusSession({ profileId: pomodoro.id });
    await guardian.stopFocusSession({});

    await guardian.startFocusSession({});
    await guardian.stopFocusSession({});

    const stats = guardian.getFocusStats({ profileId: pomodoro.id });
    assert.strictEqual(stats.totalSessions, 1);
  });

  // --- Profiles ---

  test('upsertProfile cria perfil', async () => {
    const result = await guardian.upsertProfile({
      name: 'Custom Profile',
      plannedDurationMinutes: 40,
      breakIntervalMinutes: 40,
      breakDurationMinutes: 8,
      color: '#FF0000',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(result.profile.name, 'Custom Profile');
    assert.strictEqual(result.profile.plannedDurationMinutes, 40);
    assert.strictEqual(result.profile.color, '#FF0000');
  });

  test('upsertProfile atualiza perfil existente', async () => {
    const created = await guardian.upsertProfile({ name: 'Test Profile' });
    const updated = await guardian.upsertProfile({ id: created.profile.id, name: 'Updated', plannedDurationMinutes: 60 });
    assert.strictEqual(updated.action, 'updated');
    assert.strictEqual(updated.profile.name, 'Updated');
    assert.strictEqual(updated.profile.plannedDurationMinutes, 60);
  });

  test('upsertProfile falha sem name', async () => {
    await assert.rejects(
      guardian.upsertProfile({ name: '' }),
      /name: obrigatório/
    );
  });

  test('getProfile obtém por ID', async () => {
    const created = await guardian.upsertProfile({ name: 'Get By ID' });
    const result = guardian.getProfile({ id: created.profile.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.profile.name, 'Get By ID');
  });

  test('getProfile obtém por nome', async () => {
    await guardian.upsertProfile({ name: 'Get By Name' });
    const result = guardian.getProfile({ name: 'Get By Name' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.profile.name, 'Get By Name');
  });

  test('listProfiles lista todos', () => {
    const result = guardian.listProfiles();
    assert.ok(result.count >= 3); // Default profiles
    assert.ok(result.profiles.some(p => p.name === 'Deep Work'));
    assert.ok(result.profiles.some(p => p.name === 'Pomodoro'));
    assert.ok(result.profiles.some(p => p.name === 'Light Focus'));
  });

  test('deleteProfile remove perfil não usado', async () => {
    const created = await guardian.upsertProfile({ name: 'To Delete' });
    const result = await guardian.deleteProfile({ id: created.profile.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.removed, true);
  });

  test('deleteProfile falha se perfil em uso', async () => {
    const profiles = guardian.listProfiles();
    const deepWork = profiles.profiles.find(p => p.name === 'Deep Work');
    await guardian.startFocusSession({ profileId: deepWork.id });
    await guardian.stopFocusSession({});

    await assert.rejects(
      guardian.deleteProfile({ id: deepWork.id }),
      /profile in use/
    );
  });

  // --- Blocklists ---

  test('upsertBlocklist cria blocklist', async () => {
    const result = await guardian.upsertBlocklist({
      name: 'Test Blocklist',
      type: 'websites',
      entries: ['example.com', 'test.com'],
      enabled: true,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(result.blocklist.name, 'Test Blocklist');
    assert.deepStrictEqual(result.blocklist.entries, ['example.com', 'test.com']);
  });

  test('upsertBlocklist atualiza blocklist', async () => {
    const created = await guardian.upsertBlocklist({ name: 'BL1', entries: ['a.com'] });
    const updated = await guardian.upsertBlocklist({ id: created.blocklist.id, entries: ['a.com', 'b.com'], enabled: false });
    assert.strictEqual(updated.action, 'updated');
    assert.deepStrictEqual(updated.blocklist.entries, ['a.com', 'b.com']);
    assert.strictEqual(updated.blocklist.enabled, false);
  });

  test('listBlocklists lista todas', async () => {
    const result = guardian.listBlocklists({});
    assert.ok(result.count >= 2); // Default blocklists
  });

  test('listBlocklists filtra por enabled', async () => {
    const result = guardian.listBlocklists({ enabled: true });
    assert.ok(result.blocklists.every(b => b.enabled === true));
  });

  test('deleteBlocklist remove blocklist não usada', async () => {
    const created = await guardian.upsertBlocklist({ name: 'BL to Delete', entries: [] });
    const result = await guardian.deleteBlocklist({ id: created.blocklist.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.removed, true);
  });

  test('deleteBlocklist falha se em uso por perfil', async () => {
    const created = await guardian.upsertBlocklist({ name: 'BL in Use', entries: ['x.com'] });
    const profile = await guardian.upsertProfile({ name: 'Profile with BL', blocklistIds: [created.blocklist.id] });

    await assert.rejects(
      guardian.deleteBlocklist({ id: created.blocklist.id }),
      /blocklist in use/
    );
  });

  // --- Settings ---

  test('getSettings retorna configurações', () => {
    const result = guardian.getSettings();
    assert.strictEqual(result.ok, true);
    assert.ok(result.settings.defaultProfile);
    assert.strictEqual(typeof result.settings.breakReminderEnabled, 'boolean');
    assert.ok(typeof result.settings.breakReminderIntervalMinutes === 'number');
  });

  test('updateSettings atualiza configurações', async () => {
    const result = await guardian.updateSettings({
      breakReminderEnabled: false,
      breakReminderIntervalMinutes: 60,
    });
    assert.strictEqual(result.settings.breakReminderEnabled, false);
    assert.strictEqual(result.settings.breakReminderIntervalMinutes, 60);
  });

  // --- checkBlocked ---

  test('checkBlocked retorna blocked true para domínio na blocklist', async () => {
    const profiles = guardian.listProfiles();
    const deepWork = profiles.profiles.find(p => p.name === 'Deep Work');
    // Deep Work tem blocklists de redes sociais e entretenimento

    const result = guardian.checkBlocked({ url: 'https://facebook.com/feed', profileId: deepWork.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blocked, true);
    assert.ok(result.entry);
    assert.ok(result.blocklist);
  });

  test('checkBlocked retorna blocked false para domínio não bloqueado', async () => {
    const profiles = guardian.listProfiles();
    const deepWork = profiles.profiles.find(p => p.name === 'Deep Work');

    const result = guardian.checkBlocked({ url: 'https://github.com/user/repo', profileId: deepWork.id });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blocked, false);
  });

  test('checkBlocked usa perfil ativo se não informado', async () => {
    await guardian.startFocusSession({});
    const result = guardian.checkBlocked({ url: 'https://twitter.com/home' });
    assert.strictEqual(result.ok, true);
    // Deve bloquear pois perfil padrão tem blocklists
    assert.strictEqual(result.blocked, true);
  });

  test('checkBlocked lida com URL inválida', () => {
    const result = guardian.checkBlocked({ url: 'not-a-url' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blocked, false);
  });

  // --- Tool Specs ---

  test('toolSpecs expõe todas as ferramentas com verify functions', () => {
    const specs = guardian.toolSpecs;
    // Count: session control (9) + profiles (4) + blocklists (4) + settings (2) + checkBlocked (1) = 20
    // Actually 21 because session control is 9 (start, pause, resume, stop, cancel, break, distraction, status, sessions, stats = 10)
    assert.strictEqual(specs.length, 21);
    const names = specs.map(s => s.name).sort();
    assert.ok(names.includes('focus.start'));
    assert.ok(names.includes('focus.pause'));
    assert.ok(names.includes('focus.resume'));
    assert.ok(names.includes('focus.stop'));
    assert.ok(names.includes('focus.cancel'));
    assert.ok(names.includes('focus.break'));
    assert.ok(names.includes('focus.distraction'));
    assert.ok(names.includes('focus.status'));
    assert.ok(names.includes('focus.sessions'));
    assert.ok(names.includes('focus.stats'));
    assert.ok(names.includes('focus.profile.upsert'));
    assert.ok(names.includes('focus.profile.get'));
    assert.ok(names.includes('focus.profile.list'));
    assert.ok(names.includes('focus.profile.delete'));
    assert.ok(names.includes('focus.blocklist.upsert'));
    assert.ok(names.includes('focus.blocklist.get'));
    assert.ok(names.includes('focus.blocklist.list'));
    assert.ok(names.includes('focus.blocklist.delete'));
    assert.ok(names.includes('focus.settings.get'));
    assert.ok(names.includes('focus.settings.update'));
    assert.ok(names.includes('focus.checkBlocked'));

    for (const spec of specs) {
      assert.strictEqual(typeof spec.verify, 'function');
      assert.ok(spec.permissionLevel >= 1 && spec.permissionLevel <= 3);
    }
  });

  // --- Persistência ---

  test('dados persistem entre instâncias (mesmo dataDir)', async () => {
    const profile = await guardian.upsertProfile({ name: 'Persistente', plannedDurationMinutes: 33 });
    await guardian.startFocusSession({ profileId: profile.profile.id });
    await new Promise(r => setTimeout(r, 10));
    await guardian.stopFocusSession({});

    const guardian2 = createFocusGuardianCore({ dataDir: tempDir });
    const profiles = guardian2.listProfiles();
    const persisted = profiles.profiles.find(p => p.name === 'Persistente');
    assert.ok(persisted);
    assert.strictEqual(persisted.plannedDurationMinutes, 33);

    const sessions = guardian2.listFocusSessions({ status: 'completed' });
    assert.strictEqual(sessions.count, 1);
  });

  // --- Blocklists padrão ---

  test('blocklists padrão criadas na inicialização', () => {
    const blocklists = guardian.listBlocklists({ enabled: true });
    const names = blocklists.blocklists.map(b => b.name);
    assert.ok(names.includes('Redes Sociais'));
    assert.ok(names.includes('Entretenimento'));
  });

  test('perfil Deep Work tem blocklists associadas', () => {
    const profiles = guardian.listProfiles();
    const deepWork = profiles.profiles.find(p => p.name === 'Deep Work');
    assert.ok(deepWork.blocklistIds.length >= 2);
  });
});