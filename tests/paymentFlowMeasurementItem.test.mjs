// Escolha da linha do contrato para a medição (itens reais do CTPJ/32, obra 97001, 29/09/2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMeasurementItem } from '../services/sienge/paymentFlow/measurementItem.js';

const bal = (quantity, laborPrice, measured) => Math.max(0, quantity * laborPrice - measured * laborPrice);
const CTPJ32 = [
    { description: 'COMERCIAL', workItemId: null, _balanceEstimate: 0 },
    { description: '2026/2027', workItemId: null, _balanceEstimate: 0 },
    { description: 'Contratos PJ', workItemId: 80173, _balanceEstimate: bal(12, 5257.5, 5) },
    { description: 'Contratos PJ', workItemId: 80173, _balanceEstimate: bal(1, 257.5, 1) },
    { description: 'PREMIAÇÕES RELACIONADAS Á VENDAS', workItemId: null, _balanceEstimate: 0 },
    { description: 'Premiação por vendas', workItemId: 80116, _balanceEstimate: bal(1, 25000, 0.4164) },
    { description: 'Premiação por vendas', workItemId: 80116, _balanceEstimate: bal(1, 30000, 0.9497) },
    { description: '2025/2026', workItemId: null, _balanceEstimate: 0 },
    { description: 'Contratos PJ', workItemId: 80173, _balanceEstimate: 0 },
];

test('salário mede em Contratos PJ, não na premiação de saldo menor', () => {
    const r = pickMeasurementItem(CTPJ32, { budgetItem: 'Contratos PJ', value: 5257.5, strict: true });
    assert.equal(r.item.description, 'Contratos PJ');
    assert.equal(r.rowIndex, 1); // 1ª linha editável do grid
    assert.equal(r.porItem, true);
});

test('sem o item do tipo, o comportamento antigo escolheria a premiação', () => {
    const r = pickMeasurementItem(CTPJ32, { value: 5257.5 });
    assert.equal(r.item.description, 'Premiação por vendas');
});

test('código do serviço também identifica o item', () => {
    const r = pickMeasurementItem(CTPJ32, { budgetItemCode: '80116', value: 1000, strict: true });
    assert.equal(r.item.workItemId, 80116);
    assert.equal(r.rowIndex, 3); // premiação de saldo 1509 é a 3ª editável
});

test('estrito: item do tipo sem saldo suficiente recusa e pede aditivo', () => {
    const r = pickMeasurementItem(CTPJ32, { budgetItem: 'Contratos PJ', value: 50000, strict: true });
    assert.equal(r.rowIndex, null);
    assert.match(r.motivo, /aditivo/);
});

test('estrito: contrato sem o item do tipo recusa', () => {
    const r = pickMeasurementItem(CTPJ32, { budgetItem: 'Taxas e Emolumentos', value: 100, strict: true });
    assert.equal(r.rowIndex, null);
    assert.match(r.motivo, /não tem o item/);
});

test('contrato sem saldo nenhum', () => {
    const r = pickMeasurementItem([{ description: 'X', _balanceEstimate: 0 }], { value: 1 });
    assert.equal(r.rowIndex, null);
});
