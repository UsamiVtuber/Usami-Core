import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccount,
  normalizeTransaction,
  summarizeTransactions,
  validateDateRange,
} from '../finance-core.mjs';

test('normalizeAccount e normalizeTransaction suportam Pluggy e Belvo com resumo de fluxo', () => {
  const pluggyAcc = normalizeAccount({
    id: 'acc-1',
    name: 'Conta Corrente',
    subtype: 'CHECKING_ACCOUNT',
    currencyCode: 'BRL',
    balance: 1250.45,
  }, 'pluggy');
  assert.equal(pluggyAcc.balance, 1250.45);

  const belvoAcc = normalizeAccount({
    id: 'acc-2',
    name: 'Poupança',
    category: 'SAVINGS_ACCOUNT',
    currency: 'BRL',
    balance: { current: 5000 },
  }, 'belvo');
  assert.equal(belvoAcc.balance, 5000);

  const txs = [
    normalizeTransaction({ id: 't1', date: '2026-11-05T10:00:00Z', description: 'Salário', amount: 4000, type: 'CREDIT', category: 'Renda' }, 'pluggy'),
    normalizeTransaction({ id: 't2', date: '2026-11-06T12:00:00Z', description: 'Mercado', amount: 350.5, type: 'DEBIT', category: 'Alimentação' }, 'pluggy'),
    normalizeTransaction({ id: 't3', value_date: '2026-11-07', description: 'Café', amount: 25, type: 'OUTFLOW', category: 'Alimentação' }, 'belvo'),
  ];
  const summary = summarizeTransactions(txs);
  assert.equal(summary.totalInflow, 4000);
  assert.equal(summary.totalOutflow, 375.5);
  assert.equal(summary.netFlow, 3624.5);
  assert.equal(summary.topCategories[0].category, 'Alimentação');
});

test('validateDateRange rejeita intervalo invertido ou formato inválido', () => {
  assert.deepEqual(validateDateRange({ from: '2026-11-01', to: '2026-11-11' }), { from: '2026-11-01', to: '2026-11-11' });
  assert.throws(() => validateDateRange({ from: '2026-11-11', to: '2026-11-01' }), /posterior/);
  assert.throws(() => validateDateRange({ from: '11/11/2026' }), /YYYY-MM-DD/);
});

