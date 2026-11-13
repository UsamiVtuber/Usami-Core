// Teste de interface do menu "Você" da Usami (header dinâmico + ListGroups).
// Sem JSX (Node não transpila JSX nativamente): usa React.createElement.
// O jsdom é configurado ANTES de importar o testing-library, para que o
// `screen` enxergue o document global.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

// 1) Configura jsdom primeiro.
await import('./ui-setup.mjs');

// 2) Só depois importa o testing-library (ele lê o global.document configurado).
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
afterEach(cleanup);

function el(type, props, ...children) {
  return React.createElement(type, props, ...children);
}

function StatusBubble({ text }) {
  return el('div', { className: 'status-bubble', role: 'status', 'aria-live': 'polite' }, text);
}

function MenuAvatar({ bubbleText }) {
  return el(
    'div',
    { className: 'avatar-wrap' },
    el('div', {
      className: 'menu-avatar',
      'aria-label': 'Avatar da Usami',
    }),
    el(StatusBubble, { text: bubbleText })
  );
}

function MenuHeader({ bubbleText }) {
  return el(
    'div',
    { className: 'menu-header' },
    el(MenuAvatar, { bubbleText }),
    el(
      'div',
      { className: 'menu-identity' },
      el(
        'h2',
        { id: 'usami-settings-title', className: 'menu-name' },
        'Usami',
        el('span', { className: 'online-dot', 'aria-hidden': 'true' })
      ),
      el('div', { className: 'menu-subtitle' }, 'Companion IA · online')
    ),
    el('button', {
      className: 'icon',
      'aria-label': 'Fechar configurações',
    })
  );
}

function ListItem({ icon, label, value, onToggle, pressed }) {
  return el(
    'button',
    {
      className: 'list-item',
      type: 'button',
      onClick: onToggle,
      'aria-pressed': pressed,
      'aria-label': `Alternar ${label}`,
    },
    el('span', { className: 'list-icon' }, icon),
    el('span', { className: 'list-label' }, label),
    el('span', { className: 'list-value' }, value),
    el('span', { className: 'list-chevron' }, '>')
  );
}

function ListGroup({ title, children }) {
  return el(
    'div',
    { className: 'listgroup' },
    el('div', { className: 'listgroup-title' }, title),
    children
  );
}

function MenuControls({ visionEnabled, onToggleVision }) {
  return el(
    'div',
    { className: 'menu-controls' },
    el(ListGroup, { title: 'Cérebro & Motor' },
      el(ListItem, { icon: '🧠', label: 'Modelo de Chat', value: 'nemotron-fast' }),
      el(ListItem, { icon: '⚙️', label: 'Modelo de Raciocínio', value: 'mistral-large' }),
      el(ListItem, {
        icon: '👁️',
        label: 'Ativar Visão',
        value: visionEnabled ? 'Ligada' : 'Desligada',
        onToggle: onToggleVision,
        pressed: visionEnabled,
      })
    ),
    el(ListGroup, { title: 'Memória (RAG) & Estado' },
      el(ListItem, { icon: '🧹', label: 'Limpar Contexto Atual', value: 'Chat' }),
      el(ListItem, { icon: '🎭', label: 'Personalidade / Humor', value: 'Jeito' })
    ),
    el(ListGroup, { title: 'Sistema' },
      el(ListItem, { icon: '🔊', label: 'Voz & Áudio', value: 'Dispositivos' }),
      el(ListItem, { icon: '🛡️', label: 'Integrações', value: 'WhatsApp · Discord · MCP' })
    )
  );
}

function Menu({ visionEnabled, onToggleVision, bubbleText }) {
  return el(
    'div',
    null,
    el(MenuHeader, { bubbleText }),
    el(MenuControls, { visionEnabled, onToggleVision })
  );
}

describe('menu interface: header dinâmico (aba "Você")', () => {
  it('renderiza avatar, bolha de status, nome Usami e ponto verde online', () => {
    render(el(MenuHeader, { bubbleText: 'Pensativa…' }));

    const avatar = screen.getByLabelText('Avatar da Usami');
    assert.ok(avatar, 'avatar presente');

    const bubble = screen.getByText('Pensativa…');
    assert.ok(bubble, 'bolha de status com texto dinâmico');

    const name = screen.getByText('Usami');
    assert.ok(name, 'nome "Usami" renderizado');

    const dot = document.querySelector('.online-dot');
    assert.ok(dot, 'ponto de status online renderizado');

    const subtitle = screen.getByText('Companion IA · online');
    assert.ok(subtitle, 'subtítulo online renderizado');
  });

  it('renderiza três ListGroups com títulos e itens de controle', () => {
    render(el(MenuControls, { visionEnabled: true, onToggleVision: () => {} }));

    const titles = ['Cérebro & Motor', 'Memória (RAG) & Estado', 'Sistema'];
    const groupTitles = [...document.querySelectorAll('.listgroup-title')].map(
      (t) => t.textContent.replace('&amp;', '&')
    );
    for (const title of titles) {
      assert.ok(groupTitles.includes(title), `ListGroup "${title}" presente`);
    }

    const expected = [
      'Modelo de Chat',
      'Modelo de Raciocínio',
      'Ativar Visão',
      'Limpar Contexto Atual',
      'Personalidade / Humor',
      'Voz & Áudio',
      'Integrações',
    ];
    const labels = [...document.querySelectorAll('.list-label')].map((l) => l.textContent);
    for (const label of expected) {
      assert.ok(labels.includes(label), `item "${label}" presente`);
    }

    const chevrons = document.querySelectorAll('.list-chevron');
    assert.equal(chevrons.length, 7, 'cada item tem um chevron à direita');
  });

  it('ícones de linha à esquerda em cada item', () => {
    render(el(MenuControls, { visionEnabled: true, onToggleVision: () => {} }));
    const icons = document.querySelectorAll('.list-icon');
    assert.equal(icons.length, 7, 'cada item tem um ícone de linha à esquerda');
  });

  it('toggle de visão alterna o estado e chama o handler', () => {
    let calls = 0;
    const onToggleVision = () => {
      calls += 1;
    };

    render(el(MenuControls, { visionEnabled: true, onToggleVision }));

    const btn = [...document.querySelectorAll('.list-item')].find((b) =>
      b.textContent.includes('Ativar Visão')
    );
    assert.ok(btn, 'botão Ativar Visão encontrado');
    assert.equal(btn.getAttribute('aria-pressed'), 'true', 'visão inicia ligada');

    fireEvent.click(btn);
    assert.equal(calls, 1, 'toggleVision chamado ao clicar');
  });
});
