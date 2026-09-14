// tests/alertRenderer.test.mjs
//
// O alerta no WhatsApp mandava JSON cru quando a tool devolvia uma forma que o
// formatador não conhecia (reservas_summary, *_cards...) e número sem tipo
// quando conhecia. Estes testes fixam: nenhuma saída contém JSON, moeda e
// percentual saem formatados, e o texto nunca passa do limite do WhatsApp.
import test from 'node:test';
import assert from 'node:assert/strict';

import { legacyToBlocks, blocksDe, inferirTipo, humanizar } from '../services/OfficeAI/legacyBlocks.js';
import { renderPreview, renderWhatsAppText, formatarValor, lerPayload, LIMITE_TEXTO } from '../services/alerts/AlertReportRenderer.js';

const semJson = (texto) => {
    assert.ok(!/[{}]/.test(texto), `saída contém chave de JSON:\n${texto}`);
    assert.ok(!texto.includes('```'), `saída contém bloco de código:\n${texto}`);
    assert.ok(!/Formato de retorno não reconhecido/.test(texto));
};

// ─── Fixtures: uma por forma que as tools devolvem ───────────────────────────

const reservasSummary = {
    type: 'reservas_summary', source: 'reservas',
    title: 'Reservas — 01/09/2026 a 14/09/2026',
    total: 42, reservada: 10, contrato: 8, em_repasse: 5, vendida: 12, cancelada: 7, outros: 0, ativas: 35,
    taxa_venda: 28.6, taxa_distrato: 16.7,
    tempo_medio_em_reserva: 3.4, tempo_medio_ate_venda: 12.1, tempo_medio_ate_contrato: null,
    aviso_vendida: 'A flag "vendida" indica apenas a etapa do CRM.',
    context: { source: 'reservas' },
};

const repassesSummary = {
    type: 'repasses_summary', source: 'repasses',
    title: 'Repasses — 01/09/2026 a 14/09/2026',
    total: 17, reservas: 17, contratos_quitados: 3, em_analise_contratos: 6,
    valor_financiado: 3597425.5, valor_previsto: 4100000, valor_subsidio: 210000, valor_fgts: 98000.25,
    sla_medio_dias: 9.4,
    message: '17 repasse(s) no filtro. Responda CURTO usando SOMENTE estes números. Tela: /validator.',
    context: {},
};

const tabelaBoletos = {
    type: 'table', title: 'Boletos Caixa', subtitle: 'Emissão 01/09 a 14/09 · 3 boleto(s)',
    columns: [
        { key: 'reserva', label: 'Reserva' },
        { key: 'titular', label: 'Titular' },
        { key: 'valor', label: 'Valor', type: 'currency' },
        { key: 'vencimento', label: 'Vencimento' },
    ],
    rows: [
        { reserva: 6948, titular: 'Maria Souza', valor: 1500, vencimento: '2026-09-20' },
        { reserva: 6950, titular: 'José Lima', valor: 2350.5, vencimento: '2026-09-22' },
        { reserva: 6951, titular: 'Ana Prado', valor: 980, vencimento: '2026-09-25' },
    ],
    total: 3,
};

const graficoVendas = {
    period: '2026-08', consolidado: true, version: 3,
    vendas: 31, vgv: 'R$ 7.812.000', vgv_mais_dc: 'R$ 8.020.000', vendas_distratadas_depois: 1, divergencias_abertas: 0,
    type: 'chart', chartType: 'bar',
    title: 'Vendas consolidadas — 2026-08', subtitle: '31 venda(s) · R$ 7.812.000',
    labels: ['Ingá', 'Park Alameda', 'Parque Norte'],
    data: [4200000, 2412000, 1200000],
    message: 'Mês CONSOLIDADO. Responda com base SOMENTE nestes dados.',
};

const cardsChecklist = {
    type: 'checklist_cards', title: 'Checklists',
    cards: [
        { kind: 'checklist', id: 7, title: 'Lançamento Parque Norte', empreendimento: 'Parque Norte', status: 'active',
          progresso: { total: 20, done: 13, pct: 65, overdue: 2 }, dono: 'gustavo', link: '/checklist/7' },
        { kind: 'checklist', id: 8, title: 'Stand Sarandi', empreendimento: 'Park Alameda', status: 'active',
          progresso: { total: 5, done: 5, pct: 100, overdue: 0 }, dono: 'ana', link: '/checklist/8' },
    ],
    screenLink: '/checklist',
    message: 'Cards JÁ na UI. Não invente.',
};

const detalheEmpreendimento = {
    type: 'detail', source: 'enterprise_detail', focus: 'geral',
    id: 39, nome: 'Parque Norte',
    sienge: { cdc: 20207, nome_empresa: 'Menin SPE 12', cnpj: '00.000.000/0001-00' },
    situacao_comercial: 'Em vendas', andamento: 42.5, data_entrega: '2027-12-01',
    unidades: { total: 320, disponiveis: 118, vendidas: 190, reservadas: 12 },
};

const comBlocks = {
    blocks: [
        { kind: 'kpis', inline: true, kpis: [
            { label: 'Vendas', value: 31, type: 'number' },
            { label: 'VGV', value: 7812000, type: 'currency' },
            { label: 'De lead nosso', value: 9, type: 'number', hint: '29,0%' },
        ] },
        { kind: 'dataset', title: 'Vendas por corretor', subtitle: 'ago/26', source: 'Faturamento (contratos)',
          dataset: {
              columns: [
                  { key: 'corretor', label: 'Corretor', type: 'text' },
                  { key: 'valor', label: 'VGV', type: 'currency' },
                  { key: 'vendas', label: 'Vendas', type: 'number' },
                  { key: 'participacao', label: 'Part.', type: 'percent' },
              ],
              rows: [
                  { corretor: 'Carlos', valor: 2100000, vendas: 8, participacao: 26.9 },
                  { corretor: 'Bia', valor: 1750000, vendas: 7, participacao: 22.4 },
              ],
              total: 14, truncated: true,
          } },
    ],
    type: 'table', title: 'Vendas por corretor', columns: [], rows: [],
};

const formaDesconhecida = {
    type: 'condition_compare', precisa_desambiguar: true,
    candidatos: { 1: 'Parque Norte', 2: 'Parque Norte II' },
    message: 'Pergunte ao usuário qual ele quer.',
};

// ─── legacyToBlocks ──────────────────────────────────────────────────────────

test('legacyToBlocks: reservas_summary vira KPIs com rótulo e tipo; aviso e message ficam de fora', () => {
    const [b, ...resto] = legacyToBlocks(reservasSummary);
    assert.equal(resto.length, 0);
    assert.equal(b.kind, 'kpis');
    const porLabel = Object.fromEntries(b.kpis.map(k => [k.label, k]));
    assert.equal(porLabel['Reservas'].value, 42);
    assert.equal(porLabel['Taxa de venda'].type, 'percent');
    assert.equal(porLabel['Tempo médio em reserva'].unit, 'dias');
    assert.ok(!porLabel['Tempo médio até contrato'], 'null não vira KPI');
    assert.ok(!b.kpis.some(k => /aviso|message/i.test(k.label)));
});

test('legacyToBlocks: table declara colunas com tipo; sem tipo, infere pelo nome (vencimento = data)', () => {
    const [b] = legacyToBlocks(tabelaBoletos);
    assert.equal(b.kind, 'dataset');
    const tipos = Object.fromEntries(b.dataset.columns.map(c => [c.key, c.type]));
    assert.equal(tipos.valor, 'currency');
    assert.equal(tipos.vencimento, 'date');
    assert.equal(tipos.titular, 'text');
    assert.equal(b.dataset.rows.length, 3);
});

test('legacyToBlocks: chart vira dataset (moeda pelo título) + KPIs dos números soltos, sem version/period', () => {
    const blocks = legacyToBlocks(graficoVendas);
    const kpis = blocks.find(b => b.kind === 'kpis');
    const ds = blocks.find(b => b.kind === 'dataset');
    assert.ok(kpis && ds);
    assert.equal(ds.dataset.columns[1].type, 'currency');
    const labels = kpis.kpis.map(k => k.label);
    assert.ok(labels.includes('Vendas'));
    assert.ok(labels.includes('VGV'));
    assert.ok(!labels.includes('Version'));
    assert.ok(!labels.includes('Period'));
});

test('legacyToBlocks: *_cards vira cards com progresso do checklist; detail vira seções', () => {
    const [cards] = legacyToBlocks(cardsChecklist);
    assert.equal(cards.kind, 'cards');
    assert.equal(cards.cards[0].title, 'Lançamento Parque Norte');
    assert.equal(cards.cards[0].fields[0].value, '13/20');

    const [det] = legacyToBlocks(detalheEmpreendimento);
    assert.equal(det.kind, 'detail');
    assert.ok(det.detail.fields.some(f => f.label === 'Nome'));
    assert.ok(det.detail.sections.some(s => s.title === 'Unidades'));
    assert.ok(!det.detail.fields.some(f => f.label === 'Id'));
});

test('blocksDe: prefere blocks quando a tool já devolve; forma desconhecida devolve []', () => {
    assert.equal(blocksDe(comBlocks).length, 2);
    assert.equal(blocksDe(comBlocks)[0].kind, 'kpis');
    assert.deepEqual(legacyToBlocks(formaDesconhecida), []);
    assert.deepEqual(legacyToBlocks({ error: 'x' }), []);
    assert.deepEqual(legacyToBlocks(null), []);
});

test('inferirTipo/humanizar', () => {
    assert.equal(inferirTipo('valor_financiado', 1), 'currency');
    assert.equal(inferirTipo('taxa_venda', 1), 'percent');
    assert.equal(inferirTipo('idreserva', 1), 'text');
    assert.equal(inferirTipo('data_cad', '2026-09-01'), 'date');
    assert.equal(inferirTipo('mes', '2026-09'), 'month');
    assert.equal(inferirTipo('qualquer', 'R$ 1.000'), 'currency');
    assert.equal(humanizar('valor_financiado'), 'Valor financiado');
    assert.equal(humanizar('vgv'), 'VGV');
});

// ─── formatarValor ───────────────────────────────────────────────────────────

test('formatarValor: moeda, percentual, data, mês e compacto', () => {
    assert.equal(formatarValor(1500, 'currency'), 'R$ 1.500');
    assert.equal(formatarValor(2350.5, 'currency'), 'R$ 2.350,50');
    assert.equal(formatarValor(7812000, 'currency', { compacto: true }), 'R$ 7,8 mi');
    assert.equal(formatarValor(45300, 'currency', { compacto: true }), 'R$ 45,3 mil');
    assert.equal(formatarValor('R$ 7.812.000', 'currency', { compacto: true }), 'R$ 7,8 mi');
    assert.equal(formatarValor(28.6, 'percent'), '28,6%');
    assert.equal(formatarValor('2026-09-20', 'date'), '20/09/2026');
    assert.equal(formatarValor('2026-08', 'month'), 'ago/26');
    assert.equal(formatarValor(3.4, 'number', { unit: 'dias' }), '3,4 dias');
    assert.equal(formatarValor(null, 'currency'), '-');
});

// ─── Texto do WhatsApp ───────────────────────────────────────────────────────

const fixtures = { reservasSummary, repassesSummary, tabelaBoletos, graficoVendas, cardsChecklist, detalheEmpreendimento, comBlocks, formaDesconhecida };

test('renderWhatsAppText: nenhuma forma sai como JSON e todas cabem no limite', () => {
    for (const [nome, raw] of Object.entries(fixtures)) {
        const txt = renderWhatsAppText(raw, { ruleName: `Teste ${nome}`, link: 'https://office.menin.com.br/x' });
        semJson(txt);
        assert.ok(txt.length <= LIMITE_TEXTO, `${nome} passou do limite`);
        assert.ok(txt.startsWith(`📊 *Teste ${nome}*`), `${nome} sem cabeçalho`);
        assert.ok(txt.includes('🔗 Abrir no Office: https://office.menin.com.br/x'), `${nome} sem rodapé`);
        assert.ok(!/Responda CURTO|não invente|JÁ na UI/i.test(txt), `${nome} vazou instrução do modelo`);
    }
});

test('renderWhatsAppText: reservas_summary sai com valores legíveis (antes era JSON)', () => {
    const txt = renderWhatsAppText(reservasSummary, { ruleName: 'Reservas do dia' });
    assert.ok(txt.includes('▸ *Reservas* 42'));
    assert.ok(txt.includes('▸ *Taxa de venda* 28,6%'));
    assert.ok(txt.includes('▸ *Tempo médio em reserva* 3,4 dias'));
    assert.ok(!txt.includes('taxa_venda'), 'chave crua vazou');
});

test('renderWhatsAppText: repasses mostra os valores em reais, não só a frase', () => {
    const txt = renderWhatsAppText(repassesSummary, { ruleName: 'Repasses' });
    assert.ok(txt.includes('▸ *Valor financiado* R$ 3,6 mi'));
    assert.ok(txt.includes('▸ *SLA médio* 9,4 dias'));
});

test('renderWhatsAppText: tabela lista as linhas com moeda e data formatadas', () => {
    const txt = renderWhatsAppText(tabelaBoletos, { ruleName: 'Boletos' });
    assert.ok(txt.includes('*Total:* 3'));
    assert.ok(txt.includes('- *6948*  Titular: Maria Souza · Valor: R$ 1,5 mil · Vencimento: 20/09/2026'), txt);
});

test('renderWhatsAppText: gráfico mostra a fatia de cada categoria', () => {
    const txt = renderWhatsAppText(graficoVendas, { ruleName: 'Vendas' });
    assert.ok(txt.includes('- *Ingá*  R$ 4,2 mi _(54%)_'), txt);
    assert.ok(txt.includes('▸ *VGV* R$ 7,8 mi'), txt);
});

test('renderWhatsAppText: blocks novos com dataset truncado apontam a tela (ou o anexo)', () => {
    const semAnexo = renderWhatsAppText(comBlocks, { ruleName: 'Corretores' });
    assert.ok(semAnexo.includes('> ago/26 · Faturamento (contratos)'));
    assert.ok(semAnexo.includes('- *Carlos*  VGV: R$ 2,1 mi · Vendas: 8 · Part.: 26,9%'), semAnexo);
    assert.ok(semAnexo.includes('… e mais 12 linhas. Abra no Office para ver tudo.'));
    const comAnexo = renderWhatsAppText(comBlocks, { ruleName: 'Corretores', anexoDisponivel: true });
    assert.ok(comAnexo.includes('A planilha completa está em anexo.'));
});

test('renderWhatsAppText: forma desconhecida diz que não há resumo, sem JSON', () => {
    const txt = renderWhatsAppText(formaDesconhecida, { ruleName: 'X', link: 'https://office.menin.com.br/y' });
    assert.ok(txt.includes('ainda não está disponível em texto'));
    semJson(txt);
});

test('renderWhatsAppText: dataset gigante é cortado por linha inteira e fica dentro do limite', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ nome: `Cliente ${i} com um nome bem comprido para ocupar espaço`, valor: 1000 * i, situacao: 'Em análise de documentação' }));
    const raw = { type: 'table', title: 'Muitos', columns: [{ key: 'nome' }, { key: 'valor', type: 'currency' }, { key: 'situacao' }], rows, total: 400 };
    const txt = renderWhatsAppText(raw, { ruleName: 'Grande', limite: 900 });
    assert.ok(txt.length <= 900);
    assert.ok(txt.includes('não coube aqui') || txt.includes('e mais'));
    const linhas = txt.split('\n');
    for (const l of linhas) if (l.startsWith('- *')) assert.ok(/\*.*\*/.test(l), `linha cortada no meio: ${l}`);
});

// ─── Preview ─────────────────────────────────────────────────────────────────

test('renderPreview: KPIs primeiro, depois total do dataset, depois título; erro vira "Erro:"', () => {
    assert.equal(renderPreview(reservasSummary), 'Reservas 42 · Ativas 35 · Em reserva 10');
    assert.equal(renderPreview(tabelaBoletos), '3 registros · top: 6948 (Maria Souza)');
    assert.equal(renderPreview(cardsChecklist), '2 itens');
    assert.equal(renderPreview(formaDesconhecida, { fallback: 'Fallback' }), 'Fallback');
    assert.ok(renderPreview({ error: 'boom' }).startsWith('Erro: boom'));
    assert.ok(renderPreview(comBlocks).startsWith('Vendas 31 · VGV R$ 7,8 mi'));
});

// ─── report_payload em JSON, tolerante ao antigo ─────────────────────────────

test('lerPayload: JSON novo e texto antigo', () => {
    const novo = lerPayload(JSON.stringify({ text: 'oi', blocks: [{ kind: 'kpis', kpis: [] }], route: '/x' }));
    assert.equal(novo.text, 'oi');
    assert.equal(novo.blocks.length, 1);
    assert.equal(novo.route, '/x');
    assert.deepEqual(lerPayload('📊 *Antigo*\ntexto'), { text: '📊 *Antigo*\ntexto', blocks: [], route: null });
    assert.equal(lerPayload('{ não é json').text, '{ não é json');
});
