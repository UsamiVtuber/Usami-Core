// Foco de diálogos modais (F4): foco inicial, trap de Tab/Shift+Tab, Escape e
// restauração do foco no gatilho. Usado pelo painel de configurações e pelo
// BondPanel — os dois são `role="dialog" aria-modal="true"`.
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalFocus({ active = true, containerRef, initialFocusRef, restoreRef, onEscape }) {
  // Callbacks mudam de identidade a cada render; guardar em ref evita que o
  // efeito (e o cleanup que devolve o foco) rode sem o diálogo ter fechado.
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; });

  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef?.current;
    if (!container) return undefined;
    const trigger = restoreRef?.current || document.activeElement;
    const initial = initialFocusRef?.current || container.querySelector(FOCUSABLE) || container;
    try { initial.focus({ preventScroll: true }); } catch {}

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = Array.from(container.querySelectorAll(FOCUSABLE))
        .filter(element => element.offsetParent !== null || element === document.activeElement);
      if (!focusables.length) {
        event.preventDefault();
        try { container.focus({ preventScroll: true }); } catch {}
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === container || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // O default action do Escape (que pode mandar o foco para o body) roda
      // depois dos listeners; devolver o foco num tick posterior preserva o
      // gatilho também quando o painel fecha pelo teclado.
      setTimeout(() => {
        try {
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        } catch {}
      }, 0);
    };
  }, [active, containerRef, initialFocusRef, restoreRef]);
}
