export const FINANCE_SCHEMA = 'usami.openfinance.v1';
export const OPENFINANCE_PROVIDERS = Object.freeze(['auto', 'pluggy', 'belvo']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{3,128}$/;
const collapse = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

export function sanitizeOpenFinanceId(id, label = 'id') {
  const clean = String(id ?? '').trim();
  if (!SAFE_ID_RE.test(clean)) throw new Error(`${label} inválido.`);
  return clean;
}

export function validateDateRange({ from = null, to = null } = {}) {
  const cleanFrom = from ? String(from).trim() : null;
  const cleanTo = to ? String(to).trim() : null;
  if (cleanFrom && (!DATE_RE.test(cleanFrom) || Number.isNaN(Date.parse(`${cleanFrom}T00:00:00Z`)))) {
    throw new Error('from deve ser YYYY-MM-DD válido.');
  }
  if (cleanTo && (!DATE_RE.test(cleanTo) || Number.isNaN(Date.parse(`${cleanTo}T00:00:00Z`)))) {
    throw new Error('to deve ser YYYY-MM-DD válido.');
  }
  if (cleanFrom && cleanTo && cleanFrom > cleanTo) {
    throw new Error('from não pode ser posterior a to.');
  }
  return { from: cleanFrom, to: cleanTo };
}

export function normalizeAccount(raw, provider = 'pluggy') {
  if (!raw || typeof raw !== 'object') return null;
  if (provider === 'belvo') {
    const current = Number(raw.balance?.current ?? raw.balance?.available ?? 0);
    return {
      id: String(raw.id || ''),
      name: collapse(raw.name || raw.public_identification_name || 'Conta'),
      type: String(raw.category || raw.type || 'CHECKING_ACCOUNT'),
      currency: String(raw.currency || 'BRL'),
      balance: round2(current),
      institution: collapse(raw.institution?.name || ''),
    };
  }
  return {
    id: String(raw.id || ''),
    name: collapse(raw.name || raw.marketingName || 'Conta'),
    type: String(raw.subtype || raw.type || 'BANK'),
    currency: String(raw.currencyCode || 'BRL'),
    balance: round2(raw.balance),
    institution: collapse(raw.institution?.name || ''),
  };
}

export function normalizeTransaction(raw, provider = 'pluggy') {
  if (!raw || typeof raw !== 'object') return null;
  if (provider === 'belvo') {
    const rawAmount = Number(raw.amount || 0);
    const type = String(raw.type || '').toUpperCase();
    const signed = type === 'OUTFLOW' ? -Math.abs(rawAmount) : (type === 'INFLOW' ? Math.abs(rawAmount) : rawAmount);
    return {
      id: String(raw.id || ''),
      date: String(raw.value_date || raw.accounting_date || '').slice(0, 10),
      description: collapse(raw.description || '(sem descrição)'),
      amount: round2(signed),
      currency: String(raw.currency || 'BRL'),
      category: collapse(raw.category || 'Outros'),
      type: signed >= 0 ? 'credit' : 'debit',
    };
  }
  const rawAmount = Number(raw.amount || 0);
  const type = String(raw.type || '').toUpperCase();
  const signed = type === 'DEBIT' ? -Math.abs(rawAmount) : (type === 'CREDIT' ? Math.abs(rawAmount) : rawAmount);
  return {
    id: String(raw.id || ''),
    date: String(raw.date || '').slice(0, 10),
    description: collapse(raw.description || raw.descriptionRaw || '(sem descrição)'),
    amount: round2(signed),
    currency: String(raw.currencyCode || 'BRL'),
    category: collapse(raw.category || 'Outros'),
    type: signed >= 0 ? 'credit' : 'debit',
  };
}

export function summarizeTransactions(transactions = []) {
  let totalInflow = 0;
  let totalOutflow = 0;
  const byCategory = new Map();

  for (const tx of transactions) {
    if (!tx || !Number.isFinite(tx.amount)) continue;
    if (tx.amount >= 0) {
      totalInflow += tx.amount;
    } else {
      totalOutflow += Math.abs(tx.amount);
      const cat = tx.category || 'Outros';
      byCategory.set(cat, round2((byCategory.get(cat) || 0) + Math.abs(tx.amount)));
    }
  }

  const topCategories = [...byCategory.entries()]
    .map(([category, spent]) => ({ category, spent }))
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 5);

  return {
    count: transactions.length,
    totalInflow: round2(totalInflow),
    totalOutflow: round2(totalOutflow),
    netFlow: round2(totalInflow - totalOutflow),
    topCategories,
  };
}

