import React, { useEffect } from 'react';
import { Heart, Smile, Users, Lock, X, Sparkles, MessageCircle, Mic, Phone, PenLine, Star } from 'lucide-react';
import { METER_KEYS, LEVELS, LEVEL_NAMES, levelFor, meterProgress, bondSummary, relativeDay } from './bond.js';

const METER_META = {
  carinho: { label: 'Carinho', Icon: Heart },
  humor: { label: 'Humor', Icon: Smile },
  companhia: { label: 'Companhia', Icon: Users },
};

const EVENT_ICONS = { chat: MessageCircle, voice: Mic, laugh: Smile, long: PenLine, call: Phone, level: Star };

// Painel de vínculo (substitui o popover de barras). Fica à direita do palco
// para a Usami continuar visível do lado esquerdo, como na referência VN.
export default function BondPanel({ intimacy, log, onClose }) {
  const summary = bondSummary(intimacy);
  const recent = (log || []).slice(0, 6);

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <div className="bond-scrim" onClick={onClose}>
    <section className="bond-sheet" role="dialog" aria-modal="true" aria-label="Vínculo com a Usami" onClick={event => event.stopPropagation()}>
      <button className="bond-close" onClick={onClose} aria-label="Fechar vínculo"><X size={18}/></button>

      <div className="bond-hero">
        <div className="bond-badge" aria-hidden="true">
          <Heart className="bond-badge-heart" strokeWidth={1.4}/>
          <span className="bond-badge-level">Nv. {summary.level}</span>
          <span className="bond-badge-ribbon">{summary.name}</span>
        </div>
        <div className="bond-exp">
          <div className="bond-exp-label">
            {summary.max ? <span>{summary.xp} EXP</span> : <span>{summary.xp} / {summary.next} EXP</span>}
          </div>
          <span className="bond-exp-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(summary.progress * 100)} aria-label="Progresso do nível">
            <i style={{ width: `${Math.round(summary.progress * 100)}%` }}/>
          </span>
          <p className="bond-exp-hint"><Sparkles size={12}/> {summary.max ? 'Vínculo no nível máximo!' : `Faltam ${summary.remaining} EXP para o próximo nível!`}</p>
        </div>
      </div>

      <div className="bond-row">
        <div className="bond-card bond-ties">
          <h3><Heart size={15}/> Nossos Vínculos</h3>
          {METER_KEYS.map(key => {
            const xp = Math.min(999, Math.max(0, Math.floor(intimacy?.[key] || 0)));
            const level = levelFor(xp);
            const { label, Icon } = METER_META[key];
            return <div className="bond-tie" key={key}>
              <Icon className="bond-tie-icon" size={18}/>
              <div className="bond-tie-body">
                <div className="bond-tie-head">
                  <span>{label}</span>
                  <span className="bond-tie-hearts" aria-label={`nível ${level} de ${LEVELS.length}`}>
                    {LEVELS.map((_, index) => <Heart key={index} size={11} className={index < level ? 'on' : ''}/>)}
                  </span>
                </div>
                <span className="bond-tie-track"><i style={{ width: `${Math.round(meterProgress(xp) * 100)}%` }}/></span>
              </div>
            </div>;
          })}
        </div>
        <div className="bond-card bond-note">
          <p>{summary.line}</p>
          <span>— Usami</span>
        </div>
      </div>

      <div className="bond-card bond-progress">
        <h3><Heart size={15}/> Progresso do Relacionamento</h3>
        <ol className="bond-steps">
          {LEVEL_NAMES.map((name, index) => {
            const step = index + 1;
            const state = step < summary.level ? 'done' : step === summary.level ? 'current' : 'locked';
            const label = state !== 'locked' ? name : step === summary.level + 1 ? `${name}?` : '???';
            return <li key={name} className={'bond-step ' + state}>
              <span className="bond-step-node">{state === 'locked' ? <Lock size={13}/> : <Heart size={state === 'current' ? 18 : 14}/>}</span>
              <b>Nv.{step}</b>
              <small>{label}</small>
            </li>;
          })}
        </ol>
      </div>

      <div className="bond-card bond-history">
        <h3><Star size={15}/> Histórico Recente</h3>
        {recent.length ? <ul>
          {recent.map(item => {
            const Icon = EVENT_ICONS[item.kind] || MessageCircle;
            return <li key={`${item.kind}-${item.at}`}>
              <Icon size={16} className="bond-history-icon"/>
              <span>{item.text}{item.count > 1 ? <em> · {item.count}×</em> : null}</span>
              <time dateTime={new Date(item.at).toISOString()}>{relativeDay(item.at)}</time>
            </li>;
          })}
        </ul> : <p className="bond-empty">Converse com a Usami para registrar os momentos de vocês.</p>}
      </div>
    </section>
  </div>;
}
