// tests/atoParcelas.test.mjs - regras puras da gestao de parcelas do Ato.
// Roda com `npm test` (node:test, sem dependencia).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    addMonthsClamp, addDays, diffDays, derivarParcelas, diffPlano, calcularEncargos,
    decidirParcela, classificarParaRodada, condicaoDeEmissao, proximoDiaUtil, motivoEncerramento, PARCELA_STATUS,
    ehErroDeCep, titularComEnderecoContingencia,
} from '../lib/atoParcelas.js';

test('classificarParaRodada: cfg da tela (sem hoje) + corte retroativo + politica ignorar', () => {
    // Mesmo formato que cfgParcelas devolve: NAO tem `hoje`. Em 08/09/2026 a
    // rodada passou este objeto direto para decidirParcela e caiu na 1a parcela.
    const cfg = { antecedenciaDias: 10, atrasoReemitir: false, atrasoMaxReemissoes: 3, vencidasNaAdesao: 'ignorar', cobrarAPartirDe: '2026-09-08' };
    const hoje = '2026-09-08';
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-09-10', emissoes: 0 }, cfg, hoje), 'emitir');
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-09-18', emissoes: 0 }, cfg, hoje), 'emitir');
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-09-19', emissoes: 0 }, cfg, hoje), 'aguardar');
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-06-06', emissoes: 0 }, cfg, hoje), 'retroativa');
    assert.equal(classificarParaRodada({ status: 'vencida', vencimento: '2026-09-01', emissoes: 1 }, cfg, hoje), 'retroativa');
    assert.equal(classificarParaRodada({ status: 'vencida', vencimento: '2026-09-10', emissoes: 1 }, cfg, '2026-09-12'), 'parar');
    assert.equal(classificarParaRodada({ status: 'vencida', vencimento: '2026-09-10', emissoes: 1 }, { ...cfg, atrasoReemitir: true }, '2026-09-12'), 'reemitir');
    // Sem corte: prevista ja vencida e nunca emitida obedece a politica da adesao.
    const semCorte = { ...cfg, cobrarAPartirDe: null };
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-09-01', emissoes: 0 }, semCorte, hoje), 'pulada');
    assert.equal(classificarParaRodada({ status: 'prevista', vencimento: '2026-09-01', emissoes: 0 }, { ...semCorte, vencidasNaAdesao: 'emitir' }, hoje), 'emitir');
    assert.throws(() => classificarParaRodada({ status: 'prevista', vencimento: '2026-09-10' }, cfg), /hoje/);
});

test('addMonthsClamp preserva o dia e presa ao fim do mes', () => {
    assert.equal(addMonthsClamp('2026-09-20', 1), '2026-10-20');
    assert.equal(addMonthsClamp('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsClamp('2028-01-31', 1), '2028-02-29'); // bissexto
    assert.equal(addMonthsClamp('2026-08-31', 6), '2027-02-28');
    assert.equal(addMonthsClamp('2026-12-15', 1), '2027-01-15'); // vira o ano
    assert.equal(addMonthsClamp('2026-09-20', 0), '2026-09-20');
});

test('addDays e diffDays sao inversos', () => {
    assert.equal(addDays('2026-09-05', 5), '2026-09-10');
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(diffDays('2026-09-05', '2026-09-10'), 5);
    assert.equal(diffDays('2026-09-10', '2026-09-05'), -5);
});

// Series reais da reserva 8050 (05/09/2026): ato 500, RP 59x 496,74 + residuo 1x em 2031.
const SERIES_8050 = [
    { idserie: 21, serie: 'Recurso Proprio a Vista', sigla: 'RA', valor: '500.00000', quantidade: 1, vencimento: '2026-09-05', idcondicao: 1438855 },
    { idserie: 20, serie: 'Recurso Proprio Parcelado', sigla: 'RP', valor: '496.74217', quantidade: 59, vencimento: '2026-09-20' },
    { idserie: 17, serie: 'Financiamento', sigla: 'FI', valor: '124273.24', quantidade: 1, vencimento: '2029-07-31' },
    { idserie: 20, serie: 'Recurso Proprio Parcelado', sigla: 'RP', valor: '496.87000', quantidade: 1, vencimento: '2031-08-20' },
];

test('derivarParcelas: 59 mensais + residuo, numeradas em ordem de vencimento', () => {
    const p = derivarParcelas(SERIES_8050);
    assert.equal(p.length, 60);
    assert.equal(p[0].numero, 1);
    assert.equal(p[0].total, 60);
    assert.equal(p[0].vencimento, '2026-09-20');
    assert.equal(p[0].valor, 496.74);
    assert.equal(p[1].vencimento, '2026-10-20');
    assert.equal(p[58].vencimento, '2031-07-20');
    assert.equal(p[59].vencimento, '2031-08-20');
    assert.equal(p[59].valor, 496.87);
    assert.equal(p[59].indice_na_serie, 1);
    assert.equal(p[59].linha, 1);          // 2a linha da serie 20 (residuo)
    assert.equal(p[0].linha, 0);
    assert.equal(new Set(p.map(x => `${x.idserie}:${x.linha}:${x.indice_na_serie}`)).size, 60); // chaves unicas
    // ato e financiamento nao entram
    assert.ok(p.every(x => x.idserie === 20));
});

test('derivarParcelas: series configuraveis e linhas invalidas ignoradas', () => {
    assert.equal(derivarParcelas(SERIES_8050, { idseries: [1] }).length, 0);
    assert.equal(derivarParcelas([{ idserie: 20, quantidade: 0, valor: '10', vencimento: '2026-01-01' }]).length, 0);
    assert.equal(derivarParcelas([{ idserie: 20, quantidade: 3, valor: '0', vencimento: '2026-01-01' }]).length, 0);
    assert.equal(derivarParcelas([{ idserie: 20, quantidade: 3, valor: '10' }]).length, 0);
    assert.equal(derivarParcelas(null).length, 0);
});

test('diffPlano: prevista acompanha o CV, emitida vira divergencia, sumida e removida', () => {
    const derivadas = derivarParcelas(SERIES_8050);
    const gravadas = derivadas.slice(0, 3).map((d, i) => ({
        id: i + 1, ...d, status: i === 0 ? PARCELA_STATUS.EMITIDA : PARCELA_STATUS.PREVISTA,
    }));
    // CV mudou o valor da mensal
    const novasSeries = SERIES_8050.map(s => (s.idserie === 20 && s.quantidade === 59 ? { ...s, valor: '500.00' } : s));
    const d = diffPlano(gravadas, derivarParcelas(novasSeries));
    assert.equal(d.novas.length, 57);
    assert.equal(d.atualizar.length, 2);           // as 2 previstas
    assert.equal(d.atualizar[0].valor, 500);
    assert.equal(d.divergentes.length, 1);         // a emitida
    assert.equal(d.divergentes[0].id, 1);
    assert.equal(d.remover.length, 0);

    // serie removida do CV: previstas somem, emitida fica orfa
    const semRp = diffPlano(gravadas, derivarParcelas(SERIES_8050.filter(s => s.idserie !== 20)));
    assert.equal(semRp.remover.length, 2);
    assert.equal(semRp.orfas.length, 1);
});

test('calcularEncargos: multa uma vez + juros pro rata; sem atraso = zero', () => {
    const e = calcularEncargos({ valor: 1000, vencimentoOriginal: '2026-08-06', hoje: '2026-09-05', multaPct: 2, jurosMesPct: 1 });
    assert.equal(e.diasAtraso, 30);
    assert.equal(e.multa, 20);
    assert.equal(e.juros, 10);
    assert.equal(e.total, 30);
    assert.equal(e.valorCobrado, 1030);

    const meio = calcularEncargos({ valor: 496.74, vencimentoOriginal: '2026-08-21', hoje: '2026-09-05', multaPct: 2, jurosMesPct: 1 });
    assert.equal(meio.diasAtraso, 15);
    assert.equal(meio.multa, 9.93);
    assert.equal(meio.juros, 2.48);
    assert.equal(meio.valorCobrado, 509.15);

    const zero = calcularEncargos({ valor: 1000, vencimentoOriginal: '2026-09-10', hoje: '2026-09-05', multaPct: 2, jurosMesPct: 1 });
    assert.equal(zero.total, 0);
    assert.equal(zero.valorCobrado, 1000);
});

test('decidirParcela: antecedencia, reemissao ate o teto, parar depois', () => {
    const cfg = { hoje: '2026-09-05', antecedenciaDias: 10, atrasoReemitir: true, atrasoMaxReemissoes: 3 };
    assert.equal(decidirParcela({ status: 'prevista', vencimento: '2026-09-15' }, cfg), 'emitir');
    assert.equal(decidirParcela({ status: 'prevista', vencimento: '2026-09-16' }, cfg), 'aguardar');
    assert.equal(decidirParcela({ status: 'prevista', vencimento: '2026-08-01' }, cfg), 'emitir'); // ja vencida na adesao
    assert.equal(decidirParcela({ status: 'erro', vencimento: '2026-09-10' }, cfg), 'emitir');
    assert.equal(decidirParcela({ status: 'vencida', vencimento: '2026-08-20', emissoes: 1 }, cfg), 'reemitir');
    assert.equal(decidirParcela({ status: 'vencida', vencimento: '2026-08-20', emissoes: 4 }, cfg), 'parar');
    assert.equal(decidirParcela({ status: 'vencida', vencimento: '2026-08-20', emissoes: 1 }, { ...cfg, atrasoReemitir: false }), 'parar');
    assert.equal(decidirParcela({ status: 'paga', vencimento: '2026-08-20' }, cfg), 'aguardar');
    assert.equal(decidirParcela({ status: 'emitida', vencimento: '2026-09-06' }, cfg), 'aguardar');
});

test('proximoDiaUtil: pula fim de semana e feriado', () => {
    assert.equal(proximoDiaUtil('2026-09-04'), '2026-09-08'); // sexta -> pula sab/dom e 7 de setembro (segunda)
    assert.equal(proximoDiaUtil('2026-09-08'), '2026-09-09');
    assert.equal(proximoDiaUtil('2026-09-11'), '2026-09-14'); // sexta -> segunda
    assert.equal(proximoDiaUtil('2026-12-24'), '2026-12-28'); // quinta -> pula Natal (sexta) e fim de semana
});

test('condicaoDeEmissao: no prazo mantem; vencida sai com o mesmo valor e vencimento no proximo dia util', () => {
    const cfg = { hoje: '2026-09-04' };
    const futura = condicaoDeEmissao({ vencimento: '2026-09-20', valor: 496.74, emissoes: 0 }, cfg);
    assert.deepEqual([futura.vencimento, futura.valor, futura.encargos, futura.motivo], ['2026-09-20', 496.74, null, 'no_prazo']);

    const adesao = condicaoDeEmissao({ vencimento: '2026-08-06', valor: 1000, emissoes: 0 }, cfg);
    assert.equal(adesao.vencimento, '2026-09-08');
    assert.equal(adesao.valor, 1000);
    assert.equal(adesao.motivo, 'adesao_vencida');

    const reem = condicaoDeEmissao({ vencimento: '2026-08-06', valor: 1000, emissoes: 1 }, cfg);
    assert.equal(reem.vencimento, '2026-09-08');
    assert.equal(reem.valor, 1000);           // sem encargos nesta etapa
    assert.equal(reem.encargos, null);
    assert.equal(reem.motivo, 'reemissao_atraso');

    // O calculo de encargos continua existindo, mas so entra se alguem pedir.
    const comEncargo = condicaoDeEmissao({ vencimento: '2026-08-05', valor: 1000, emissoes: 1 }, { ...cfg, cobrarEncargos: true, multaPct: 2, jurosMesPct: 1 });
    assert.equal(comEncargo.valor, 1030);
});

test('motivoEncerramento: o Sienge nao e criterio (titulo pode ser adiantamento); cancelada ganha', () => {
    // 08/09/2026: contrato, titulo e venda faturada no ERP nao encerram nada.
    assert.equal(motivoEncerramento({}), null);
    assert.equal(motivoEncerramento(), null);
    assert.equal(motivoEncerramento({ contrato: { receivable_bill_id: 33058, financial_institution_date: '2026-09-01' } }), null);
    assert.equal(motivoEncerramento({ reservaCancelada: true }), 'reserva_cancelada');
    assert.equal(motivoEncerramento({ situacaoMorta: true }), 'reserva_cancelada');
});

test('CEP recusado pela Caixa: reconhece a mensagem e troca so o endereco pelo de contingencia', () => {
    assert.equal(ehErroDeCep('Falha na emissao (emissao): Portal Ecobrança: CEP SACADO INVALIDO'), true);
    assert.equal(ehErroDeCep('Portal Ecobrança: CEP INVALIDO'), true);
    assert.equal(ehErroDeCep('Boleto não emitido — botão de impressão não apareceu'), false);
    assert.equal(ehErroDeCep(null), false);
    const titular = { nome: 'MARIA', documento: '12345678900', idpessoa_cv: 1, cep: '86360000', endereco: 'Rua 0', numero: '0', complemento: 'casa', bairro: 'Vila Rural', cidade: 'Bandeirantes', estado: 'PR' };
    const t = titularComEnderecoContingencia(titular);
    assert.deepEqual({ cep: t.cep, endereco: t.endereco, numero: t.numero, complemento: t.complemento, bairro: t.bairro, cidade: t.cidade, estado: t.estado },
        { cep: '17500005', endereco: 'Rua São Luiz', numero: '231', complemento: '', bairro: 'Centro', cidade: 'Marília', estado: 'SP' });
    assert.equal(t.nome, 'MARIA'); assert.equal(t.documento, '12345678900'); assert.equal(t.idpessoa_cv, 1);
    // Configurado na tela manda (e o CEP entra sem mascara).
    const t2 = titularComEnderecoContingencia(titular, { cep: '17.500-005', numero: 231 });
    assert.equal(t2.cep, '17500005'); assert.equal(t2.numero, '231'); assert.equal(t2.endereco, 'Rua São Luiz');
});

test('motivoEncerramento: a UNICA regra e o repasse em Contrato Emitido CAIXA (ou depois)', () => {
    // 45 Contrato Emitido CAIXA, 46 Contratos Assinados MCMV, 54 Faturado SIENGE MCMV: encerra.
    assert.equal(motivoEncerramento({ repasseSituacaoId: 45 }), 'repasse_contrato_emitido');
    assert.equal(motivoEncerramento({ repasseSituacaoId: 46 }), 'repasse_contrato_emitido');
    assert.equal(motivoEncerramento({ repasseSituacaoId: '54' }), 'repasse_contrato_emitido');
    // 44 Em Contratacao CAIXA (antes), 51 Documento Pendente (desvio), 10 Cancelado, 1 Em espera: nao encerra.
    assert.equal(motivoEncerramento({ repasseSituacaoId: 44 }), null);
    assert.equal(motivoEncerramento({ repasseSituacaoId: 51 }), null);
    assert.equal(motivoEncerramento({ repasseSituacaoId: 10 }), null);
    assert.equal(motivoEncerramento({ repasseSituacaoId: 1 }), null);
    assert.equal(motivoEncerramento({ repasseSituacaoId: null }), null);
    // Etapas configuradas na tela mandam; [] desliga a regra.
    assert.equal(motivoEncerramento({ repasseSituacaoId: 44, encerrarEtapasRepasse: [44] }), 'repasse_contrato_emitido');
    assert.equal(motivoEncerramento({ repasseSituacaoId: 46, encerrarEtapasRepasse: [] }), null);
    // Cancelada ganha de tudo.
    assert.equal(motivoEncerramento({ repasseSituacaoId: 46, situacaoMorta: true }), 'reserva_cancelada');
});
