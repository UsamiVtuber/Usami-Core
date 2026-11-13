// Configuração de ambiente DOM (jsdom) para testes de interface do menu.
// Propriedades read-only do globalThis precisam de Object.defineProperty.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

define('window', dom.window);
define('document', dom.window.document);
define('navigator', dom.window.navigator);
define('HTMLElement', dom.window.HTMLElement);
define('HTMLInputElement', dom.window.HTMLInputElement);
define('MouseEvent', dom.window.MouseEvent);
define('Event', dom.window.Event);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
define('matchMedia', () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

export { dom };
