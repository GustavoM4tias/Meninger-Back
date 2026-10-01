// Título direto (RB de reembolso): corpo do título, PIX e receita "nenhum".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    montarTitulo, montarPix, numeroPorData, contaSemMascara, mascaraCpf, norm,
} from '../services/sienge/paymentFlow/directTitle.js';
import { recipeOf, stepsOf, validateReceita } from '../services/sienge/paymentFlow/recipe.js';
import { checkLaunchInput, checkCreditor } from '../services/sienge/paymentFlow/gate.js';

const RB = recipeOf({
    documento: 'RB',
    receita: { contrato: 'nenhum', titulo: { documento: 'RB', pagamento: 'pix' } },
    regras: { credorTipo: 'PF', exigeContratoVigente: false, exigeContratoAutorizado: false },
});

test('número do RB pela data, como no Sienge', () => {
    assert.equal(numeroPorData('2026-09-24'), '24092026');
});

test('conta financeira vai sem máscara', () => {
    assert.equal(contaSemMascara('2.02.02.41'), '2020241');
});

test('corpo do título igual ao RB de referência (WISH)', () => {
    const b = montarTitulo({
        companyId: 63, creditorId: 8342, documento: 'RB', numero: '24092026',
        emissao: '2026-10-01', vencimento: '2026-10-06', valor: 200, observacao: 'Entrega WISH',
        buildingId: 63001, conta: '2.02.02.41', departamentoId: '24', itemOrcamento: '01.001.001.004',
    });
    assert.equal(b.debtorId, 63);
    assert.equal(b.documentIdentificationId, 'RB');
    assert.equal(b.baseDate, '2026-10-01');
    assert.equal(b.installmentsNumber, 1);
    assert.deepEqual(b.budgetCategories, [{ costCenterId: 63001, paymentCategoriesId: '2020241', percentage: 100 }]);
    assert.deepEqual(b.departmentsCost, [{ departmentId: 24, percentage: 100 }]);
    assert.deepEqual(b.buildingsCost, [{ buildingId: 63001, buildingUnitId: 1, costEstimationSheetId: '01.001.001.004', percentage: 100 }]);
});

test('sem item de orçamento o título sai sem apropriação de obra', () => {
    const b = montarTitulo({ companyId: 1, creditorId: 2, documento: 'RB', numero: '1', emissao: '2026-10-01', vencimento: '2026-10-01', valor: 1, buildingId: 3, conta: '2.02.02.41' });
    assert.equal(b.buildingsCost, undefined);
    assert.equal(b.departmentsCost, undefined);
});

test('PIX na chave CPF com dados do credor', () => {
    const p = montarPix({ nome: 'GUSTAVO HENRIQUE MATIAS DINIZ', cpf: '54567930835' });
    assert.equal(p.paymentTypeId, 11);
    assert.equal(p.keyPixType, 'C');
    assert.equal(p.keyPix, '545.679.308-35');
    assert.equal(p.isUsingCreditorData, 'S');
    assert.equal(mascaraCpf('123'), '');
});

test('nome do item compara sem acento e pontuação', () => {
    assert.equal(norm('Marketing, Brindes, Promoções e Eventos'), norm('MARKETING BRINDES PROMOCOES E EVENTOS'));
});

test('receita "nenhum" com PIX é válida e mostra título direto', () => {
    assert.deepEqual(validateReceita({ contrato: 'nenhum', titulo: { pagamento: 'pix' } }), []);
    assert.equal(RB.receita.contrato, 'nenhum');
    assert.equal(RB.receita.titulo.pagamento, 'pix');
    const passos = stepsOf(RB.receita).map(s => s.key);
    assert.deepEqual(passos, ['fornecedor', 'titulo_direto']);
});

test('RB não exige número nem boleto, mas exige CPF', () => {
    const base = { launchType: 'Reembolso (RB)', unitPrice: 200, enterpriseId: 63001, nfType: 'RB' };
    assert.equal(checkLaunchInput({ ...base, providerCnpj: '545.679.308-35' }, RB.receita, RB.regras).ok, true);
    const pj = checkLaunchInput({ ...base, providerCnpj: '39.759.153/0001-52' }, RB.receita, RB.regras);
    assert.equal(pj.ok, false);
    assert.match(pj.motivos.join(' '), /pessoa física/);
    assert.equal(checkCreditor({ name: 'X', cnpj: '39.759.153/0001-52' }, RB.regras).ok, false);
});
