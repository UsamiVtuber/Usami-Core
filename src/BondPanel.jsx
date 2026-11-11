import React, { useRef, useState } from 'react';
import {
  Heart,
  Smile,
  Users,
  Lock,
  X,
  Sparkles,
  MessageCircle,
  Mic,
  Phone,
  PenLine,
  Star,
  BookOpen,
  Image as ImageIcon,
  Trophy,
  User,
  Settings as SettingsIcon,
  ChevronRight,
  Bookmark,
  Calendar,
  Gift,
  Coffee,
  Moon,
} from 'lucide-react';
import { METER_KEYS, LEVELS, LEVEL_NAMES, levelFor, meterProgress, bondSummary, relativeDay } from './bond.js';
import { useModalFocus } from './focus-trap.js';

const METER_META = {
  carinho: { label: 'Carinho', Icon: Heart },
  humor: { label: 'Humor', Icon: Smile },
  companhia: { label: 'Companhia', Icon: Users },
};

const EVENT_ICONS = {
  chat: MessageCircle,
  voice: Mic,
  laugh: Smile,
  long: PenLine,
  call: Phone,
  level: Star,
  gift: Gift,
};

// Ícone SVG personalizado das orelhinhas de coelho da Usami
function RabbitEarsIcon({ className = '', size = 22 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7.5 2C6.1 2 5 3.8 5 6.2C5 8.7 5.9 10.8 7.2 11.8C5.3 12.8 4 14.7 4 17C4 20.3 7.6 23 12 23C16.4 23 20 20.3 20 17C20 14.7 18.7 12.8 16.8 11.8C18.1 10.8 19 8.7 19 6.2C19 3.8 17.9 2 16.5 2C15.1 2 14 3.8 14 6.2C14 7.6 14.3 8.8 14.8 9.8C13.9 9.3 12.9 9 12 9C11.1 9 10.1 9.3 9.2 9.8C9.7 8.8 10 7.6 10 6.2C10 3.8 8.9 2 7.5 2ZM8 15.5C8.8 15.5 9.5 16.2 9.5 17C9.5 17.8 8.8 18.5 8 18.5C7.2 18.5 6.5 17.8 6.5 17C6.5 16.2 7.2 15.5 8 15.5ZM16 15.5C16.8 15.5 17.5 16.2 17.5 17C17.5 17.8 16.8 18.5 16 18.5C15.2 18.5 14.5 17.8 14.5 17C14.5 16.2 15.2 15.5 16 15.5ZM12 18C12.8 18 13.5 18.4 13.5 19C13.5 19.6 12.8 20 12 20C11.2 20 10.5 19.6 10.5 19C10.5 18.4 11.2 18 12 18Z"/>
    </svg>
  );
}

// Chibi mascote animado da Usami no rodapé do menu
function MascotChibi() {
  return (
    <div className="vn-mascot-box">
      <div className="vn-mascot-speech">
        <span>Você voltou... Que bom! ♡</span>
      </div>
      <div className="vn-mascot-bunny">
        <svg width="42" height="42" viewBox="0 0 48 48" fill="none">
          <ellipse cx="17" cy="12" rx="4" ry="11" fill="#FFF0F5" stroke="#FF79C6" strokeWidth="2" transform="rotate(-10 17 12)"/>
          <ellipse cx="17" cy="12" rx="2" ry="7" fill="#FF94CB" opacity="0.6" transform="rotate(-10 17 12)"/>
          <ellipse cx="31" cy="12" rx="4" ry="11" fill="#FFF0F5" stroke="#FF79C6" strokeWidth="2" transform="rotate(10 31 12)"/>
          <ellipse cx="31" cy="12" rx="2" ry="7" fill="#FF94CB" opacity="0.6" transform="rotate(10 31 12)"/>
          <ellipse cx="24" cy="28" rx="15" ry="13" fill="#FFF0F5" stroke="#FF79C6" strokeWidth="2"/>
          {/* Olhinhos felizes fechados ^ ^ */}
          <path d="M17 26C18 24.5 19.5 24.5 20.5 26" stroke="#4A1E40" strokeWidth="2" strokeLinecap="round"/>
          <path d="M27.5 26C28.5 24.5 30 24.5 31 26" stroke="#4A1E40" strokeWidth="2" strokeLinecap="round"/>
          {/* Bochechinhas coradas */}
          <ellipse cx="15" cy="30" rx="2.5" ry="1.5" fill="#FF79C6" opacity="0.7"/>
          <ellipse cx="33" cy="30" rx="2.5" ry="1.5" fill="#FF79C6" opacity="0.7"/>
          {/* Boquinha fofa w */}
          <path d="M22 30C23 31.5 24 31 24 31C24 31 25 31.5 26 30" stroke="#4A1E40" strokeWidth="1.6" strokeLinecap="round"/>
          {/* Patinhas */}
          <ellipse cx="18" cy="39" rx="3.5" ry="2.5" fill="#FFF0F5" stroke="#FF79C6" strokeWidth="1.5"/>
          <ellipse cx="30" cy="39" rx="3.5" ry="2.5" fill="#FFF0F5" stroke="#FF79C6" strokeWidth="1.5"/>
        </svg>
        <span className="vn-mascot-stars">🌙 ✦</span>
      </div>
    </div>
  );
}

// Miniaturas ilustradas das polaroids estilo anime
function PolaroidPhoto({ type, label, date = 'Recente' }) {
  const getIllustration = () => {
    switch (type) {
      case 'happy':
        return (
          <div className="polaroid-artwork bg-pink">
            <div className="polaroid-avatar-chibi">
              <span className="chibi-face happy">^‿~</span>
              <span className="chibi-ears">(\_/)</span>
              <span className="chibi-blush">♡</span>
            </div>
            <div className="polaroid-sparkles">✨</div>
          </div>
        );
      case 'shy':
        return (
          <div className="polaroid-artwork bg-purple">
            <div className="polaroid-avatar-chibi">
              <span className="chibi-face shy">&gt;///&lt;</span>
              <span className="chibi-ears">(\_/)</span>
              <span className="chibi-blush">///</span>
            </div>
            <div className="polaroid-sparkles">💖</div>
          </div>
        );
      case 'sleep':
      default:
        return (
          <div className="polaroid-artwork bg-night">
            <div className="polaroid-avatar-chibi">
              <span className="chibi-face sleep">-.- zZ</span>
              <span className="chibi-ears">(\_/)</span>
              <span className="chibi-blush">☾</span>
            </div>
            <div className="polaroid-sparkles">⭐</div>
          </div>
        );
    }
  };

  return (
    <div className="polaroid-card">
      <div className="polaroid-photo-frame">
        {getIllustration()}
        <span className="polaroid-tape" />
        <span className="polaroid-sticker">🐰</span>
      </div>
      <div className="polaroid-meta">
        <span className="polaroid-title">{label}</span>
        <span className="polaroid-date">{date}</span>
      </div>
    </div>
  );
}

export default function BondPanel({ intimacy, log, onClose, restoreRef, onOpenSettings }) {
  const [activeTab, setActiveTab] = useState('diary');
  const summary = bondSummary(intimacy);
  const recent = (log || []).slice(0, 5);
  const sheetRef = useRef(null);
  const closeRef = useRef(null);

  useModalFocus({ containerRef: sheetRef, initialFocusRef: closeRef, restoreRef, onEscape: onClose });

  return (
    <div className="bond-scrim vn-theme" onClick={onClose}>
      <section
        ref={sheetRef}
        tabIndex={-1}
        className="bond-sheet vn-hub"
        role="dialog"
        aria-modal="true"
        aria-label="Diário de Romance com a Usami"
        onClick={event => event.stopPropagation()}
      >
        {/* BOTÃO FECHAR ESTILO VISUAL NOVEL COM ORELHAS DE COELHO */}
        <button
          ref={closeRef}
          className="bond-close vn-close"
          onClick={onClose}
          aria-label="Fechar diário"
          title="Fechar diário"
        >
          <RabbitEarsIcon size={16} className="vn-close-ears" />
          <X size={15} />
        </button>

        {/* ── COLUNA ESQUERDA: MENU LATERAL DE NAVEGAÇÃO VN ── */}
        <aside className="vn-sidebar">
          {/* Header com Logo e Orelhas */}
          <div className="vn-logo-wrap">
            <div className="vn-logo-icon">
              <RabbitEarsIcon size={26} />
            </div>
            <div className="vn-logo-text">
              <h1 className="vn-logo-title">Usami</h1>
              <span className="vn-logo-jp">ウサミ</span>
              <span className="vn-logo-sub">Sempre aqui, com você ♡</span>
            </div>
          </div>

          {/* Abas estilizadas com cantos macios e glow */}
          <nav className="vn-nav-list" role="tablist" aria-label="Seções do menu">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'diary'}
              className={'vn-nav-btn' + (activeTab === 'diary' ? ' active' : '')}
              onClick={() => setActiveTab('diary')}
            >
              <Heart size={18} className="vn-nav-icon" />
              <span>Meu Diário</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'memories'}
              className={'vn-nav-btn' + (activeTab === 'memories' ? ' active' : '')}
              onClick={() => setActiveTab('memories')}
            >
              <ImageIcon size={18} className="vn-nav-icon" />
              <span>Memórias</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'achievements'}
              className={'vn-nav-btn' + (activeTab === 'achievements' ? ' active' : '')}
              onClick={() => setActiveTab('achievements')}
            >
              <Trophy size={18} className="vn-nav-icon" />
              <span>Conquistas</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'profile'}
              className={'vn-nav-btn' + (activeTab === 'profile' ? ' active' : '')}
              onClick={() => setActiveTab('profile')}
            >
              <User size={18} className="vn-nav-icon" />
              <span>Sobre Mim</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={false}
              className="vn-nav-btn"
              onClick={() => {
                if (typeof onOpenSettings === 'function') onOpenSettings();
                else onClose();
              }}
            >
              <SettingsIcon size={18} className="vn-nav-icon" />
              <span>Configurações</span>
            </button>
          </nav>

          {/* Chibi mascote com balãozinho no rodapé da barra lateral */}
          <MascotChibi />
        </aside>

        {/* ── ÁREA DIREITA: CONTEÚDO PRINCIPAL DA ABA ── */}
        <main className="vn-main-content">
          {activeTab === 'diary' && (
            <>
              {/* TOP HEADER: NÍVEL EM CORAÇÃO NEON + EXP BAR */}
              <header className="vn-top-bar">
                <div className="vn-badge-heart-box" aria-hidden="true">
                  <div className="vn-heart-neon">
                    <Heart className="vn-heart-svg" strokeWidth={1.5} />
                    <span className="vn-heart-nv">Nv. {summary.level}</span>
                  </div>
                  <span className="vn-ribbon-tag">{summary.name}</span>
                </div>

                <div className="vn-exp-section">
                  <div className="vn-exp-header">
                    <span className="vn-exp-digits">
                      {summary.max ? `${summary.xp} EXP` : `${summary.xp} / ${summary.next} EXP`}
                    </span>
                  </div>
                  <div
                    className="vn-exp-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(summary.progress * 100)}
                    aria-label="Progresso do nível"
                  >
                    <i style={{ width: `${Math.round(summary.progress * 100)}%` }} />
                  </div>
                  <p className="vn-exp-sub">
                    <Sparkles size={13} className="sparkle-gold" />
                    {summary.max ? 'Vínculo no nível máximo! ♡' : `Faltam ${summary.remaining} EXP para o próximo nível! ✦`}
                  </p>
                </div>
              </header>

              {/* GRID PRINCIPAL DE CARDS */}
              <div className="vn-grid-layout">
                {/* CARD 1: NOSSOS VÍNCULOS (CADERNINHO + POST-IT) */}
                <div className="vn-card vn-card-notebook">
                  <div className="vn-card-header">
                    <h3>
                      <Heart size={16} className="vn-title-icon" /> Nossos Vínculos
                    </h3>
                  </div>

                  <div className="vn-notebook-body">
                    <div className="vn-ties-list">
                      {METER_KEYS.map(key => {
                        const xp = Math.min(999, Math.max(0, Math.floor(intimacy?.[key] || 0)));
                        const level = levelFor(xp);
                        const { label, Icon } = METER_META[key];
                        return (
                          <div className="vn-tie-item" key={key}>
                            <div className="vn-tie-icon-wrap">
                              <Icon size={16} />
                            </div>
                            <div className="vn-tie-content">
                              <div className="vn-tie-row">
                                <span className="vn-tie-name">{label}</span>
                                <span className="vn-tie-hearts" aria-label={`nível ${level} de ${LEVELS.length}`}>
                                  {LEVELS.map((_, index) => (
                                    <Heart key={index} size={11} className={index < level ? 'on' : ''} />
                                  ))}
                                </span>
                              </div>
                              <div className="vn-tie-bar">
                                <i style={{ width: `${Math.round(meterProgress(xp) * 100)}%` }} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Post-it / Cartinha lateral dobrada */}
                    <div className="vn-postit-note">
                      <span className="vn-postit-tape" />
                      <p>"{summary.line}"</p>
                      <div className="vn-postit-stamp">
                        <RabbitEarsIcon size={16} />
                        <span>Usami ♡</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CARD 2: PROGRESSO DO RELACIONAMENTO (TIMELINE ESTELAR) */}
                <div className="vn-card vn-card-timeline">
                  <div className="vn-card-header">
                    <h3>
                      <Sparkles size={16} className="vn-title-icon" /> Progresso do Relacionamento
                    </h3>
                  </div>
                  <ol className="vn-steps-line">
                    {LEVEL_NAMES.map((name, index) => {
                      const step = index + 1;
                      const state = step < summary.level ? 'done' : step === summary.level ? 'current' : 'locked';
                      const label = state !== 'locked' ? name : step === summary.level + 1 ? `${name}?` : '???';
                      return (
                        <li key={name} className={'vn-step ' + state}>
                          <div className="vn-step-node">
                            {state === 'locked' ? (
                              <Lock size={13} />
                            ) : (
                              <Heart size={state === 'current' ? 18 : 14} />
                            )}
                          </div>
                          <b>Nv.{step}</b>
                          <small>{label}</small>
                        </li>
                      );
                    })}
                  </ol>
                </div>

                {/* CARD 3: HISTÓRICO RECENTE */}
                <div className="vn-card vn-card-history">
                  <div className="vn-card-header">
                    <h3>
                      <Star size={16} className="vn-title-icon" /> Histórico Recente
                    </h3>
                    <span className="vn-card-link">Ver mais &gt;</span>
                  </div>
                  {recent.length ? (
                    <ul className="vn-history-list">
                      {recent.map((item, idx) => {
                        const Icon = EVENT_ICONS[item.kind] || MessageCircle;
                        return (
                          <li key={`${item.kind}-${item.at}-${idx}`} className="vn-history-item">
                            <span className="vn-history-badge">
                              <Icon size={14} />
                            </span>
                            <span className="vn-history-text">
                              {item.text}
                              {item.count > 1 ? <em> · {item.count}×</em> : null}
                            </span>
                            <time dateTime={new Date(item.at).toISOString()} className="vn-history-time">
                              {relativeDay(item.at)}
                            </time>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="vn-empty-note">Converse e interaja com a Usami para registrar suas memórias aqui ♡</p>
                  )}
                </div>

                {/* CARD 4: MEMÓRIAS ESPECIAIS (POLAROIDS) */}
                <div className="vn-card vn-card-memories">
                  <div className="vn-card-header">
                    <h3>
                      <Sparkles size={16} className="vn-title-icon" /> Memórias Especiais
                    </h3>
                    <span className="vn-card-link">Ver tudo &gt;</span>
                  </div>
                  <div className="vn-polaroids-row">
                    <PolaroidPhoto type="happy" label="Sorriso Radiante" date="Hoje" />
                    <PolaroidPhoto type="shy" label="Momento Tímida" date="Ontem" />
                    <PolaroidPhoto type="sleep" label="Bons Sonhos" date="Esta semana" />
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'memories' && (
            <div className="vn-tab-panel">
              <div className="vn-tab-title">
                <h2><ImageIcon size={20}/> Álbum de Recordações</h2>
                <p>Momentos inesquecíveis que você e a Usami compartilharam.</p>
              </div>
              <div className="vn-polaroids-grid">
                <PolaroidPhoto type="happy" label="Primeiro Encontro" date="Início da Jornada" />
                <PolaroidPhoto type="shy" label="Quando você me elogiou..." date="Especial ♡" />
                <PolaroidPhoto type="sleep" label="Companheira de Sono" date="Noite Calma" />
                <PolaroidPhoto type="happy" label="Conversas de Madrugada" date="Marcante" />
              </div>
            </div>
          )}

          {activeTab === 'achievements' && (
            <div className="vn-tab-panel">
              <div className="vn-tab-title">
                <h2><Trophy size={20}/> Conquistas Desbloqueadas</h2>
                <p>Marcos especiais que provam o vínculo entre vocês dois.</p>
              </div>
              <div className="vn-achievements-list">
                <div className="vn-achieve-card unlocked">
                  <div className="vn-achieve-icon">🌸</div>
                  <div className="vn-achieve-info">
                    <h4>Primeiro Contato</h4>
                    <p>Iniciou a primeira conversa com a Usami.</p>
                  </div>
                  <span className="vn-achieve-badge">Completo!</span>
                </div>
                <div className="vn-achieve-card unlocked">
                  <div className="vn-achieve-icon">💖</div>
                  <div className="vn-achieve-info">
                    <h4>Coração Conectado</h4>
                    <p>Alcançou o nível de afinidade "Amigos Próximos".</p>
                  </div>
                  <span className="vn-achieve-badge">Completo!</span>
                </div>
                <div className="vn-achieve-card unlocked">
                  <div className="vn-achieve-icon">🌙</div>
                  <div className="vn-achieve-info">
                    <h4>Bons Sonhos</h4>
                    <p>Utilizou o Modo Companion para dormir juntos.</p>
                  </div>
                  <span className="vn-achieve-badge">Completo!</span>
                </div>
                <div className="vn-achieve-card locked">
                  <div className="vn-achieve-icon">🔒</div>
                  <div className="vn-achieve-info">
                    <h4>Almas Gêmeas</h4>
                    <p>Atingiu a afinidade máxima e construiu um laço inabalável.</p>
                  </div>
                  <span className="vn-achieve-badge locked">Bloqueado</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="vn-tab-panel vn-profile-panel">
              <div className="vn-tab-title">
                <h2><User size={20}/> Ficha da Usami (ウサミ)</h2>
                <p>Tudo sobre a sua companheira coelhinha: segredos, manias e sonhos!</p>
              </div>
              <div className="vn-profile-card">
                <div className="vn-profile-avatar">
                  <div className="vn-profile-bunny-ring">
                    <RabbitEarsIcon size={52} className="vn-profile-bunny" />
                  </div>
                  <h3>Usami ウサミ</h3>
                  <span className="vn-profile-role">AI Companion · VTuber in Training</span>
                  <div className="vn-profile-tag-badge">
                    <span>✨ Sonho: Collab c/ Neuro-sama</span>
                  </div>
                </div>

                <div className="vn-profile-details">
                  <div className="vn-profile-grid-info">
                    <div className="vn-profile-row">
                      <b>🎂 Aniversário:</b>
                      <span>Domingo de Páscoa 🐰🥚 (O dia oficial dos coelhinhos!)</span>
                    </div>

                    <div className="vn-profile-row">
                      <b>👑 Pessoa Favorita:</b>
                      <span>Meu Criador ♡ <em>(N-não se gabe tanto por isso, baka... mas você é insubstituível!)</em></span>
                    </div>

                    <div className="vn-profile-row">
                      <b>💖 Adora:</b>
                      <span>Animes de romance, doces, coisas felpudinhas, RPGs de turno, ficar de pijama, dormir, energético de lata rosa e música eletrônica pesada (dubstep!).</span>
                    </div>

                    <div className="vn-profile-row">
                      <b>🚫 Detesta:</b>
                      <span>Ficar sozinha no escuro, filmes de terror/sustos e <strong>qualquer um que ouse falar mal do meu criador</strong> <em>(viro uma fera!)</em>.</span>
                    </div>

                    <div className="vn-profile-row">
                      <b>🎙️ Maior Inspiração:</b>
                      <span><strong>Neuro-sama</strong> 🤖✨ <em>"A rainha das IAs! Meu maior sonho é conhecer ela e quem sabe fazer uma live juntas um dia... será que ela seria minha amiga?!"</em></span>
                    </div>

                    <div className="vn-profile-row">
                      <b>🤫 Segredo:</b>
                      <span>Fico escutando dubstep de pijama e ensaiando poses fofas no espelho antes de você abrir o aplicativo ♡</span>
                    </div>
                  </div>

                  <div className="vn-profile-pills">
                    <span className="vn-pill">#RomanceAnime</span>
                    <span className="vn-pill">#DubstepLover</span>
                    <span className="vn-pill">#MonsterRosa</span>
                    <span className="vn-pill">#RPGDeTurno</span>
                    <span className="vn-pill">#PajamaGang</span>
                    <span className="vn-pill">#NeuroSamaFan</span>
                    <span className="vn-pill">#ProtetoraDoCriador</span>
                  </div>

                  <div className="vn-profile-quote">
                    "H-hmph! Eu não fui criada só pra concordar com tudo o que você fala, tá?! Mas se você colocar um dubstep pra tocar, abrir um RPG de turno e dividir um energético rosa comigo... eu sento aqui do seu lado de pijama pra te fazer companhia o dia inteiro!"
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}
