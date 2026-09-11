// tests/emeTools.test.mjs
//
// Regras puras das tools da Eme que já quebraram em silêncio: rota de tela
// renomeada, venda contada duas vezes, ranking agrupando errado.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveScreenRoute, screenLabel, describeScreenCatalog } from '../lib/screenCatalog.js';
import { chaveDaVenda, vendasUnicas, agruparVendas, fundirSatelitesTR } from '../services/OfficeAI/SalesPerformanceTools.js';

test('screenCatalog: rota renomeada vira a nova, com query preservada; rota inventada é null', () => {
    assert.equal(resolveScreenRoute('/financeiro/boleto-caixa?status=error'), '/financeiro/cobranca/ato?status=error');
    assert.equal(resolveScreenRoute('/marketing/Events'), '/marketing/events');
    assert.equal(resolveScreenRoute('/comercial/imobiliarias'), '/crm/imobiliarias');
    assert.equal(resolveScreenRoute('/comercial/reservas-report'), '/comercial/relatorios/reservas');
    assert.equal(resolveScreenRoute('settings/account'), '/settings/Account');
    assert.equal(resolveScreenRoute('/nao/existe'), null);
    assert.equal(resolveScreenRoute(''), null);
    assert.equal(screenLabel('/tools/validator'), 'Validador de Contratos');
    // A descrição precisa citar cada rota do catálogo uma vez.
    const desc = describeScreenCatalog();
    assert.ok(desc.includes('/crm/correspondentes'));
    assert.ok(!desc.includes('boleto-caixa'));
});

const contrato = (over = {}) => ({
    contract_id: '1', customer_id: 10, enterprise_id: 100, enterprise_name: 'Ingá', company_id: 5, company_name: 'SPE',
    unit_id: 'U1', unit_name: 'Casa 01', situation: 'Emitido',
    payment_conditions: [{ totalValue: 100000, conditionTypeId: 'FI' }, { totalValue: 5000, conditionTypeId: 'DC' }],
    reserva: { corretor: { corretor: 'Ana', imobiliaria: 'Imob A' } },
    lead_captacao: null,
    ...over,
});

test('vendasUnicas: dois contratos do mesmo cliente+unidade viram UMA venda; DC fica fora do VGV', () => {
    const rows = [contrato(), contrato({ contract_id: '2', payment_conditions: [{ totalValue: 20000, conditionTypeId: 'RP' }] })];
    const vendas = vendasUnicas(rows);
    assert.equal(vendas.length, 1);
    assert.equal(vendas[0].net, 120000);
    assert.equal(vendas[0].gross, 125000);
    assert.equal(chaveDaVenda(rows[0]), chaveDaVenda(rows[1]));
});

test('vendasUnicas: distrato só é selo quando TODOS os contratos da venda estão cancelados', () => {
    const v = vendasUnicas([contrato({ situation: 'Cancelado' }), contrato({ contract_id: '2' })]);
    assert.equal(v[0].distratada, false);
    const v2 = vendasUnicas([contrato({ situation: 'Cancelado' })]);
    assert.equal(v2[0].distratada, true);
});

test('agruparVendas: ranking por corretor com rótulo de vazio e contagem de lead', () => {
    const vendas = vendasUnicas([
        contrato(),
        contrato({ contract_id: '2', customer_id: 11, unit_name: 'Casa 02', reserva: { corretor: { corretor: 'Bia' } }, lead_captacao: { origem: 'Site' } }),
        contrato({ contract_id: '3', customer_id: 12, unit_name: 'Casa 03', reserva: null }),
        contrato({ contract_id: '4', customer_id: 13, unit_name: 'Casa 04' }),
    ]);
    const { linhas, totalVendas, totalValor } = agruparVendas(vendas, 'corretor', v => v.net);
    assert.equal(totalVendas, 4);
    assert.equal(totalValor, 400000);
    assert.deepEqual(linhas.map(l => [l.label, l.vendas, l.comLead, l.semDado]), [
        ['Ana', 2, 0, false], ['Bia', 1, 1, false], ['Sem identificação', 1, 0, true],
    ]);
    const midia = agruparVendas(vendas, 'midia', v => v.net).linhas;
    assert.equal(midia[0].label, 'Sem mídia declarada');
});

test('fundirSatelitesTR: contrato do satélite entra na venda do parceiro; sem parceiro, é descartado', () => {
    const sat = [{ satellite_enterprise_id: 900, partner_enterprise_ids: [100] }];
    const rows = [
        contrato(),
        contrato({ contract_id: '2', enterprise_id: 900, enterprise_name: 'Terreno' }),
        contrato({ contract_id: '3', enterprise_id: 900, customer_id: 77, unit_name: 'Casa 77' }),
    ];
    const out = fundirSatelitesTR(rows, sat);
    assert.equal(out.length, 2);
    assert.ok(out.every(r => r.enterprise_id === 100));
    assert.equal(vendasUnicas(out).length, 1);
    assert.equal(vendasUnicas(out)[0].net, 200000);
});
