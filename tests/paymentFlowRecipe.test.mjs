// Receita + portão do Fluxo de Pagamento (funções puras, sem banco e sem Sienge).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeReceita, normalizeRegras, validateReceita, validateRegras, stepsOf, recipeOf,
} from '../services/sienge/paymentFlow/recipe.js';
import {
    checkLaunchInput, checkDocument, checkCreditor, pickExistingContract, checkBalance, tipoDoDocumento,
} from '../services/sienge/paymentFlow/gate.js';

const SALARIO = recipeOf({
    documento: 'CTPJ',
    receita: { contrato: 'existente', titulo: { documento: 'NFS', pagamento: 'boleto' } },
    regras: { credorTipo: 'PJ' },
});

test('tipo sem receita gravada cai no modo auto (comportamento de sempre)', () => {
    const { receita, regras } = recipeOf({ documento: 'PREM', receita: null, regras: null });
    assert.equal(receita.contrato, 'auto');
    assert.deepEqual(receita.documentosContrato, []);
    assert.equal(receita.titulo.pagamento, 'boleto');
    assert.equal(receita.medicaoAntesDoDocumento, false);
    assert.equal(regras.credorTipo, 'qualquer');
});

test('tipo sem receita não passa a exigir nota nem boleto no título', () => {
    const { receita } = recipeOf({ documento: 'CT', receita: null });
    assert.equal(receita.configurada, false);
    assert.deepEqual(checkDocument({ nfType: 'NFE', nfNumber: null, boletoBarcode: null }, receita), []);
    assert.equal(SALARIO.receita.configurada, true);
});

test('contrato existente sem lista aceita só o documento do próprio tipo', () => {
    assert.deepEqual(SALARIO.receita.documentosContrato, ['CTPJ']);
});

test('normalização descarta lixo e mantém o válido', () => {
    const r = normalizeReceita({ contrato: 'xpto', documentosContrato: 'ctpj, rb ,', titulo: { documento: 'nfe', pagamento: 'cheque' } });
    assert.equal(r.contrato, 'auto');
    assert.deepEqual(r.documentosContrato, ['CTPJ', 'RB']);
    assert.equal(r.titulo.documento, 'NFE');
    assert.equal(r.titulo.pagamento, 'boleto');
    assert.equal(normalizeRegras({ valorMaximo: '-3' }).valorMaximo, null);
    assert.equal(normalizeRegras({ valorMaximo: '6000.555' }).valorMaximo, 6000.56);
});

test('validação da tela recusa valores que não existem', () => {
    assert.equal(validateReceita({ contrato: 'existente' }).length, 0);
    assert.ok(validateReceita({ contrato: 'sempre' })[0].includes('não existe'));
    assert.ok(validateReceita({ titulo: { pagamento: 'cheque' } }).length);
    assert.ok(validateRegras({ credorTipo: 'MEI' }).length);
    assert.ok(validateRegras({ valorMaximo: 0 }).length);
});

test('passos mostrados para o salário', () => {
    assert.deepEqual(stepsOf(SALARIO.receita).map(s => s.key), ['fornecedor', 'contrato_existente', 'medicao', 'titulo']);
    const antes = stepsOf({ ...SALARIO.receita, medicaoAntesDoDocumento: true }).map(s => s.key);
    assert.deepEqual(antes, ['fornecedor', 'contrato_existente', 'medicao', 'aguarda_documento', 'titulo']);
});

const BASE = {
    launchType: 'Salário PJ (Gestor)', unitPrice: 5257.5, providerCnpj: '60.660.809/0001-71',
    enterpriseId: 97001, nfType: 'NFS', nfNumber: '26', boletoBarcode: '0'.repeat(47), boletoDueDate: '2026-10-04',
};

test('salário da Helena (PJ, NFS, boleto) passa no portão', () => {
    const r = checkLaunchInput(BASE, SALARIO.receita, SALARIO.regras);
    assert.equal(r.ok, true, r.motivos.join(' | '));
});

test('salário recusa o cadastro de pessoa física', () => {
    const r = checkLaunchInput({ ...BASE, providerCnpj: '003.010.481-50' }, SALARIO.receita, SALARIO.regras);
    assert.equal(r.ok, false);
    assert.match(r.motivos.join(' '), /pessoa jurídica/);
    assert.equal(tipoDoDocumento('003.010.481-50'), 'PF');
});

test('documento diferente do que a receita lança é recusado', () => {
    const r = checkDocument({ ...BASE, nfType: 'RB' }, SALARIO.receita);
    assert.match(r.join(' '), /título NFS/);
});

test('NF-e exige chave de 44 dígitos; transferência dispensa boleto', () => {
    const receita = normalizeReceita({ titulo: { documento: 'NFE', pagamento: 'transferencia' } });
    const sem = checkDocument({ ...BASE, nfType: 'NFE', boletoBarcode: null, boletoDueDate: null }, receita);
    assert.deepEqual(sem, ['NF-e precisa da chave de acesso com 44 dígitos.']);
    const com = checkDocument({ ...BASE, nfType: 'NFE', nfAccessKey: '1'.repeat(44), boletoBarcode: null }, receita);
    assert.deepEqual(com, []);
});

test('medição antes do documento: sem NF vira aviso, não recusa', () => {
    const receita = { ...SALARIO.receita, medicaoAntesDoDocumento: true };
    const r = checkLaunchInput({ ...BASE, nfNumber: null, boletoBarcode: null, boletoDueDate: null }, receita, SALARIO.regras);
    assert.equal(r.ok, true, r.motivos.join(' | '));
    assert.equal(r.avisos.length, 1);
});

test('valor acima do máximo do tipo é recusado', () => {
    const regras = normalizeRegras({ ...SALARIO.regras, valorMaximo: 5000 });
    assert.equal(checkLaunchInput(BASE, SALARIO.receita, regras).ok, false);
});

test('credor PF achado no Sienge é recusado no tipo PJ', () => {
    const r = checkCreditor({ id: 11385, name: 'HELENA', cpf: '003.010.481-50', cnpj: null, active: true }, SALARIO.regras);
    assert.equal(r.ok, false);
});

// Contratos reais da Gabriela e da Helena (29/09/2026).
const CONTRATOS = [
    { documentId: 'CT', contractNumber: '4531', status: 'COMPLETED', statusApproval: 'APPROVED', isAuthorized: false, startDate: '2025-04-14', endDate: '2026-04-14', buildings: [{ buildingId: 97001 }] },
    { documentId: 'CTPJ', contractNumber: '32', status: 'PARTIALLY_MEASURED', statusApproval: 'APPROVED', isAuthorized: true, startDate: '2025-04-14', endDate: '2027-04-14', buildings: [{ buildingId: 97900 }, { buildingId: 97001 }] },
    { documentId: 'RB', contractNumber: '100', status: 'PARTIALLY_MEASURED', statusApproval: 'APPROVED', isAuthorized: true, startDate: '2026-06-01', endDate: '2026-12-31', buildings: [{ buildingId: 11501 }] },
];

test('contrato existente pega o CTPJ e nunca o RB de reembolso', () => {
    const { contract, descartados } = pickExistingContract(CONTRATOS, { ...SALARIO, buildingId: 97001, today: '2026-09-29' });
    assert.equal(`${contract.documentId}/${contract.contractNumber}`, 'CTPJ/32');
    assert.equal(descartados.length, 2);
});

test('sem contrato válido o portão diz por quê', () => {
    const { contract, motivos, descartados } = pickExistingContract(CONTRATOS, { ...SALARIO, buildingId: 11501, today: '2026-09-29' });
    assert.equal(contract, null);
    assert.match(motivos[0], /Nenhum contrato/);
    assert.ok(descartados.find(d => d.contrato === 'CTPJ/32').motivo.includes('obra 11501'));
});

test('contrato vencido fica de fora', () => {
    const { contract } = pickExistingContract(CONTRATOS, { ...SALARIO, buildingId: 97001, today: '2027-05-01' });
    assert.equal(contract, null);
});

test('saldo insuficiente pede aditivo', () => {
    assert.equal(checkBalance(36802.5, 5257.5).ok, true);
    assert.match(checkBalance(100, 5257.5).motivos[0], /aditivo/);
});

test('RB: auto só considera contrato RB da obra, nunca o CTPJ do salário', async () => {
    const { pickByDocuments } = await import('../services/sienge/paymentFlow/gate.js');
    const contratos = [
        { documentId: 'CTPJ', contractNumber: '32', statusApproval: 'APPROVED', isAuthorized: true, endDate: '2026-12-31', buildings: [{ buildingId: 63001 }] },
        { documentId: 'RB', contractNumber: '10', status: 'COMPLETED', statusApproval: 'APPROVED', isAuthorized: true, endDate: '2026-12-31', buildings: [{ buildingId: 63001 }] },
        { documentId: 'RB', contractNumber: '11', statusApproval: 'APPROVED', isAuthorized: true, endDate: '2026-12-31', buildings: [{ buildingId: 72001 }] },
        { documentId: 'RB', contractNumber: '12', statusApproval: 'APPROVED', isAuthorized: true, endDate: '2026-12-31', buildings: [{ buildingId: 63001 }] },
    ];
    assert.equal(pickByDocuments(contratos, ['RB'], 63001)?.contractNumber, '12');
    assert.equal(pickByDocuments(contratos.slice(0, 3), ['RB'], 63001), null);
});

test('RB: pagamento PIX é aceito e não exige boleto', () => {
    const rb = recipeOf({
        documento: 'RB',
        receita: { contrato: 'auto', documentosContrato: ['RB'], titulo: { documento: 'RB', pagamento: 'pix' } },
        regras: { credorTipo: 'PF' },
    });
    assert.equal(rb.receita.titulo.pagamento, 'pix');
    assert.deepEqual(rb.receita.documentosContrato, ['RB']);
    const motivos = checkDocument({ nfNumber: '24092026', nfType: 'RB' }, rb.receita);
    assert.deepEqual(motivos, []);
    assert.match(stepsOf(rb.receita).at(-1).label, /PIX/);
});
