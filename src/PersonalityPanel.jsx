import { useCallback, useEffect, useState } from 'react';

// Aba "Personalidade": sliders de traços + instruções extras. Salva em
// /api/personality (o proxy do Vite injeta o token); o chat lê o registro a
// cada turno, então vale já na próxima mensagem.
export function PersonalityPanel() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/personality');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Falha ao ler a personalidade.');
      setData(body);
      setDraft(body.personality);
      setError(null);
    } catch (cause) {
      setError(cause?.message || 'Falha ao ler a personalidade.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = useCallback(async (payload, done) => {
    if (saving) return;
    setSaving(true);
    setNotice('');
    try {
      const response = await fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Falha ao salvar.');
      setData(previous => ({ ...previous, personality: body.personality }));
      setDraft(body.personality);
      setError(null);
      setNotice(done);
    } catch (cause) {
      setError(cause?.message || 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  }, [saving]);

  if (!draft) {
    return error
      ? <p className="memory-error">{error}</p>
      : <p className="settings-hint">Lendo a personalidade da Usami…</p>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.personality);
  const setTrait = (key, value) => setDraft(previous => ({ ...previous, traits: { ...previous.traits, [key]: Number(value) } }));

  return <div className="personality-panel">
    <h3>Jeito da Usami</h3>
    <p className="settings-hint">50 é a personalidade original. Os ajustes refinam o tom; as regras de ouro e a honestidade dela continuam as mesmas.</p>
    {data.traits.map(({ key, label }) => <label className="trait-row" key={key}>
      <span>{label}<b>{draft.traits[key]}</b></span>
      <input type="range" min="0" max="100" step="1" value={draft.traits[key]} onChange={event => setTrait(key, event.target.value)} aria-label={label} />
    </label>)}
    <label className="trait-row">
      <span>Instruções extras<b>{draft.customPrompt.length}/{data.customPromptMax}</b></span>
      <textarea
        rows={4}
        maxLength={data.customPromptMax}
        value={draft.customPrompt}
        placeholder="Ex.: me chame de capitão; fale mais de coelhos."
        onChange={event => setDraft(previous => ({ ...previous, customPrompt: event.target.value }))}
        aria-label="Instruções extras de personalidade"
      />
    </label>
    {error && <p className="memory-error">{error}</p>}
    {notice && <p className="settings-hint" role="status">{notice}</p>}
    <div className="rig-actions">
      <button disabled={!dirty || saving} onClick={() => send(draft, 'Personalidade salva.')}>Salvar</button>
      <button disabled={saving} onClick={() => send({ reset: true }, 'Personalidade restaurada.')}>Restaurar padrão</button>
    </div>
  </div>;
}
