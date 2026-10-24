// Dono único dos pesos de expressão do avatar VRM.
//
// Problema que resolve: `setExpression` escrevia o peso direto no
// `vrm.expressionManager` e nada zerava depois — as expressões "vazavam" e
// se acumulavam no rosto para sempre. Este módulo centraliza a escrita:
//
//   - rampa suave de ataque/release, independente do frame rate;
//   - TTL por expressão (expira sozinha e decai a zero);
//   - `clear()` para o reset devolver o rosto ao neutro de verdade.
//
// O driver nunca escreve `blinkName`: o blink pertence ao auto-motion e o
// `set` recusa esse nome para não haver disputa de dono.

export const ATTACK_TAU_MS = 60;    // constante de tempo da rampa subindo (ms)
export const RELEASE_TAU_MS = 160;  // constante de tempo da rampa descendo (ms)
export const DEFAULT_TTL_MS = 4000; // tempo de vida padrão de uma expressão (ms)
export const EPSILON = 0.01;        // abaixo disso a expressão é considerada zerada

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

// `setRaw` injetado desacopla o driver do three-vrm; `now` injetado permite
// o relógio fake dos testes.
export function createExpressionDriver({ setRaw, blinkName = null, now = () => performance.now() } = {}) {
  if (typeof now !== 'function') now = () => performance.now();

  // name -> { target, current, expiresAt }
  const entries = new Map();
  let lastUpdateMs = null;

  function set(name, weight = 1, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!setRaw || name === blinkName) return false;
    const target = clamp01(weight);
    const previous = entries.get(name);
    if (target <= 0) {
      // release: alvo zero, current preservado para a rampa de decaimento.
      if (previous) previous.target = 0;
      return true;
    }
    const currentMs = now();
    entries.set(name, { target, current: previous ? previous.current : 0, expiresAt: currentMs + ttlMs });
    // A referência de dt nasce no primeiro set: sem isso, o tempo decorrido
    // até o primeiro update seria engolido (dt = 0) e a rampa não começaria.
    if (lastUpdateMs === null) lastUpdateMs = currentMs;
    return true;
  }

  function update() {
    const currentMs = now();
    const dt = lastUpdateMs === null ? 0 : Math.max(0, currentMs - lastUpdateMs);
    lastUpdateMs = currentMs;
    for (const [name, entry] of entries) {
      if (currentMs > entry.expiresAt) entry.target = 0;
      if (dt <= 0) {
        setRaw(name, entry.current); // dt = 0 (nenhum tempo decorrido): apenas escreve o current
        continue;
      }
      const tau = entry.target > entry.current ? ATTACK_TAU_MS : RELEASE_TAU_MS;
      entry.current += (entry.target - entry.current) * (1 - Math.exp(-dt / tau));
      if (entry.target === 0 && entry.current < EPSILON) {
        setRaw(name, 0); // limpeza: 0 exato e remove a entry
        entries.delete(name);
      } else {
        setRaw(name, entry.current);
      }
    }
  }

  function releaseAll() {
    for (const entry of entries.values()) entry.target = 0;
  }

  function clear() {
    for (const name of entries.keys()) setRaw(name, 0);
    entries.clear();
  }

  function getWeight(name) {
    const entry = entries.get(name);
    return entry ? entry.current : 0;
  }

  // Espelho do estado interno para inspeção e testes.
  function active() {
    return Array.from(entries, ([name, entry]) => ({ name, current: entry.current, target: entry.target }));
  }

  return { set, update, releaseAll, clear, getWeight, active };
}
