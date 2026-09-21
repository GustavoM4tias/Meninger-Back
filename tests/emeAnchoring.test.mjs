// tests/emeAnchoring.test.mjs
//
// A ancoragem: o modelo referencia a célula em vez de digitar o número.
//
// Estes testes são a garantia de que a troca não vira o mesmo problema com
// outro nome. Eles fixam as duas promessas que justificam a mudança:
//   1. prosa legítima (horário, prazo, data) NUNCA é tocada;
//   2. referência partida no meio do stream não aparece crua para a pessoa.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    anotarParaCitacao,
    criarRegistroDeCitacoes,
    resolverRefs,
    makeRefFilter,
    taxaDeAncoragem,
    contarNumerosCitaveis,
    formatarValor,
} from '../services/OfficeAI/anchoring.js';

// ── Registro ────────────────────────────────────────────────────────────────

test('anotar: linhas de tabela ganham ref e cada célula vira citável', () => {
    const resumo = {
        type: 'table',
        title: 'Vendas',
        columns: [{ key: 'empreendimento', type: 'text' }, { key: 'vendas', type: 'number' }],
        rows: [
            { empreendimento: 'INGA', vendas: 143 },
            { empreendimento: 'MONDIAL', vendas: 87 },
        ],
    };
    const { resumos, registro } = anotarParaCitacao([resumo]);

    assert.equal(resumos[0].rows[0].ref, 'r1');
    assert.equal(resumos[0].rows[1].ref, 'r2');
    assert.equal(registro.get('r1.empreendimento').valor, 'INGA');
    assert.equal(registro.get('r1.vendas').valor, 143);
    assert.equal(registro.get('r2.vendas').valor, 87);
    // O tipo vem das colunas: é o que faz currency sair como R$ na frase.
    assert.equal(registro.get('r1.vendas').tipo, 'number');
});

test('anotar: gráfico ganha lista de citação com nome e valor JÁ pareados', () => {
    // É exatamente o par que o modelo erra quando escreve de cabeça: número
    // certo na categoria errada.
    const { resumos, registro } = anotarParaCitacao([
        { type: 'chart', labels: ['INGA', 'MONDIAL'], data: [143, 87] },
    ]);

    // labels/data NÃO podem mudar de forma: o prompt depende de labels[0] ser
    // o maior.
    assert.deepEqual(resumos[0].labels, ['INGA', 'MONDIAL']);
    assert.deepEqual(resumos[0].citacoes_categorias, [
        { ref: 'c1', nome: 'INGA', valor: 143 },
        { ref: 'c2', nome: 'MONDIAL', valor: 87 },
    ]);
    assert.equal(registro.get('c1.nome').valor, 'INGA');
    assert.equal(registro.get('c1.valor').valor, 143);
});

test('anotar: escalares do topo viram citação avulsa', () => {
    const { resumos, registro } = anotarParaCitacao([{ type: 'chart', soma_total: 230, categorias: 2 }]);
    const avulsos = resumos[0].citacoes_valores;
    assert.ok(avulsos.some(a => a.o_que === 'soma_total' && a.valor === 230));
    const ref = avulsos.find(a => a.o_que === 'soma_total').ref;
    assert.equal(registro.get(ref).valor, 230);
});

test('anotar: blocos aninhados também são alcançados', () => {
    const { registro } = anotarParaCitacao([{
        type: 'blocks',
        blocks: [{
            kind: 'dataset', title: 'Reservas',
            dataset: { columns: [{ key: 'cliente', type: 'text' }, { key: 'valor', type: 'currency' }] },
            rows: [{ cliente: 'MARIA', valor: 350000 }],
        }],
    }]);
    assert.equal(registro.get('r1.cliente').valor, 'MARIA');
    assert.equal(registro.get('r1.valor').tipo, 'currency');
});

test('anotar: ids não colidem entre consultas do mesmo turno', () => {
    const { registro } = anotarParaCitacao([
        { type: 'table', rows: [{ nome: 'A' }] },
        { type: 'table', rows: [{ nome: 'B' }] },
    ]);
    assert.equal(registro.get('r1.nome').valor, 'A');
    assert.equal(registro.get('r2.nome').valor, 'B');
});

test('anotar: campo de renderização não vira citação', () => {
    // Citar `icon` ou `route` não é resposta, é vazamento de mecânica.
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'A', icon: 'fa-user', route: '/x' }] }]);
    assert.ok(registro.has('r1.nome'));
    assert.ok(!registro.has('r1.icon'));
    assert.ok(!registro.has('r1.route'));
});

// ── Resolução ───────────────────────────────────────────────────────────────

test('resolver: a frase sai com os valores reais e formatados em pt-BR', () => {
    const { registro } = anotarParaCitacao([{
        columns: [{ key: 'empreendimento', type: 'text' }, { key: 'vgv', type: 'currency' }],
        rows: [{ empreendimento: 'INGA', vgv: 1234567.89 }],
    }]);
    const r = resolverRefs('A {{ref:r1.empreendimento}} soma {{ref:r1.vgv}} em VGV.', registro);
    assert.equal(r.resolvidas, 2);
    assert.deepEqual(r.naoResolvidas, []);
    assert.match(r.texto, /^A INGA soma R\$\s?1\.234\.567,89 em VGV\.$/);
});

test('resolver: referência inexistente NÃO vaza texto cru e é contada', () => {
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA' }] }]);
    const r = resolverRefs('O destaque foi {{ref:r9.nome}}.', registro);
    assert.deepEqual(r.naoResolvidas, ['r9.nome']);
    assert.ok(!r.texto.includes('{{ref'), 'a pessoa não pode ver o marcador cru');
});

test('resolver: sem registro nenhum, as referências viram marcador em vez de lixo', () => {
    const r = resolverRefs('Total de {{ref:v1}}.', new Map());
    assert.deepEqual(r.naoResolvidas, ['v1']);
    assert.ok(!r.texto.includes('{{ref'));
});

test('resolver: texto sem referência passa intacto', () => {
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA' }] }]);
    const texto = 'Marco às 08:30, de 20 minutos, nos dias 30 e 31 de julho.';
    const r = resolverRefs(texto, registro);
    assert.equal(r.texto, texto);
    assert.equal(r.resolvidas, 0);
});

// ── Stream ──────────────────────────────────────────────────────────────────

test('stream: referência partida entre chunks não aparece crua', () => {
    // Sem segurar a ponta, a pessoa vê "{{ref:r1.ven" piscando na tela.
    const { registro } = anotarParaCitacao([{
        columns: [{ key: 'vendas', type: 'number' }],
        rows: [{ vendas: 143 }],
    }]);
    const f = makeRefFilter(registro);

    let saida = '';
    saida += f.push('Foram ');
    saida += f.push('{{ref:r1.ven');
    assert.ok(!saida.includes('{{'), 'nada de marcador pela metade na tela');
    saida += f.push('das}} vendas.');
    saida += f.flush();

    assert.equal(saida, 'Foram 143 vendas.');
    assert.equal(f.stats().resolvidas, 1);
});

test('stream: chunk a chunk, caractere por caractere, dá o mesmo resultado', () => {
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA', total: 12 }] }]);
    const frase = 'A {{ref:r1.nome}} teve {{ref:r1.total}} reservas.';
    const f = makeRefFilter(registro);
    let saida = '';
    for (const ch of frase) saida += f.push(ch);
    saida += f.flush();
    assert.equal(saida, 'A INGA teve 12 reservas.');
});

test('stream: referência truncada no fim do stream sai no flush, sem vazar', () => {
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA' }] }]);
    const f = makeRefFilter(registro);
    let saida = f.push('Acabou no meio {{ref:r1.no');
    saida += f.flush();
    assert.ok(!saida.includes('{{ref'), 'truncada não pode virar texto cru');
    assert.equal(f.stats().naoResolvidas.length, 1);
});

test('stream: chave solta no texto não trava o filtro', () => {
    // "{" aparece em texto normal; segurar para sempre esperando virar
    // referência deixaria a resposta travada.
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA' }] }]);
    const f = makeRefFilter(registro);
    let saida = f.push('Use a chave { para abrir o bloco.');
    saida += f.flush();
    assert.equal(saida, 'Use a chave { para abrir o bloco.');
});

// ── Medida ──────────────────────────────────────────────────────────────────

test('contarNumerosCitaveis ignora ano, horário, data e número pequeno', () => {
    assert.equal(contarNumerosCitaveis('Reunião às 08:30 de 20 minutos'), 1);  // só o 20
    assert.equal(contarNumerosCitaveis('Em 2026 tivemos 143 vendas'), 1);      // só o 143
    assert.equal(contarNumerosCitaveis('Foram 3 itens'), 0);                   // pequeno demais
    assert.equal(contarNumerosCitaveis('Entrega em 31/07/2027'), 0);           // data
});

test('taxa de ancoragem: recebe CONTAGEM, não texto', () => {
    // A assinatura é (crus, resolvidas) de propósito. Medir sobre o texto FINAL
    // contava o valor já resolvido como número digitado, e uma resposta 100%
    // ancorada media 66% - com isso o detector nunca seria pulado, que é o ganho
    // central da ancoragem.
    assert.equal(taxaDeAncoragem(2, 0), 0);
    assert.equal(taxaDeAncoragem(2, 2), 0.5);
    assert.equal(taxaDeAncoragem(0, 3), 1);
    // Resposta sem número nenhum não é 0% de ancoragem: é nada a medir.
    assert.equal(taxaDeAncoragem(0, 0), null);
});

test('taxa: resposta inteiramente ancorada dá exatamente 1', () => {
    // A regressão concreta: com a medição antiga isto dava 0,66 porque o "143"
    // resolvido entrava no denominador como se o modelo o tivesse digitado.
    const { registro } = anotarParaCitacao([{ type: 'chart', labels: ['INGA'], data: [143] }]);
    const r = resolverRefs('A {{ref:c1.nome}} teve {{ref:c1.valor}} vendas.', registro);
    assert.equal(r.crus, 0, 'no texto BRUTO não há número digitado');
    assert.equal(taxaDeAncoragem(r.crus, r.resolvidas), 1);
});

// ── Formatação ──────────────────────────────────────────────────────────────

test('formatarValor respeita o tipo declarado pela coluna', () => {
    assert.match(formatarValor(1234567.89, 'currency'), /^R\$\s?1\.234\.567,89$/);
    assert.equal(formatarValor(12.5, 'percent'), '12,5%');
    assert.equal(formatarValor(1500, 'number'), '1.500');
    assert.equal(formatarValor('INGA', 'text'), 'INGA');
    assert.equal(formatarValor(true), 'sim');
    assert.equal(formatarValor(null), '');
});

// ── Registro incremental (a cadeia de tools do turno) ───────────────────────

test('registro incremental: ids seguem únicos entre consultas do turno', async () => {
    // Se a segunda consulta reiniciasse em r1, a referência da primeira
    // resolveria para o valor da segunda - o defeito exato que a ancoragem veio
    // evitar, com uma cara nova.
    const { criarRegistroDeCitacoes } = await import('../services/OfficeAI/anchoring.js');
    const reg = criarRegistroDeCitacoes();

    const a = reg.anotar({ type: 'table', rows: [{ nome: 'INGA' }] });
    const b = reg.anotar({ type: 'table', rows: [{ nome: 'MONDIAL' }] });

    assert.equal(a.rows[0].ref, 'r1');
    assert.equal(b.rows[0].ref, 'r2');
    assert.equal(reg.registro.get('r1.nome').valor, 'INGA');
    assert.equal(reg.registro.get('r2.nome').valor, 'MONDIAL');
});

test('registro incremental: categorias e valores avulsos também não colidem', async () => {
    const { criarRegistroDeCitacoes } = await import('../services/OfficeAI/anchoring.js');
    const reg = criarRegistroDeCitacoes();
    reg.anotar({ type: 'chart', labels: ['A'], data: [10], soma_total: 10 });
    reg.anotar({ type: 'chart', labels: ['B'], data: [20], soma_total: 20 });

    assert.equal(reg.registro.get('c1.nome').valor, 'A');
    assert.equal(reg.registro.get('c2.nome').valor, 'B');
    assert.equal(reg.registro.get('v1').valor, 10);
    assert.equal(reg.registro.get('v2').valor, 20);
});

// ── Integração: a composição que o turno realmente usa ─────────────────────
//
// O OfficeChatService encadeia bridgeFilter -> refFilter na emissão de texto.
// Testar as peças isoladas não prova que a composição funciona, e é justamente
// na composição que mora o risco: um filtro segurando o que o outro precisa ver.

test('composição real: bridge + referência, chunk a chunk', async () => {
    const { __testables } = await import('../services/OfficeAI/hallucinationGuard.js')
        .catch(() => ({ __testables: null }));
    // makeBridgeFilter não é exportado; o que dá para garantir aqui é que o
    // refFilter sobrevive a texto já filtrado, inclusive com quebra de linha e
    // marcação markdown no meio das referências.
    const { criarRegistroDeCitacoes, makeRefFilter } = await import('../services/OfficeAI/anchoring.js');
    const reg = criarRegistroDeCitacoes();
    reg.anotar({
        type: 'chart',
        labels: ['INGA', 'MONDIAL'],
        data: [143, 87],
        soma_total: 230,
    });

    const resposta = '**{{ref:c1.nome}}** lidera com {{ref:c1.valor}}\n'
        + '- segunda: {{ref:c2.nome}} ({{ref:c2.valor}})\n'
        + 'Total: {{ref:v1}}.';

    const f = makeRefFilter(reg.registro);
    let saida = '';
    for (let i = 0; i < resposta.length; i += 7) saida += f.push(resposta.slice(i, i + 7));
    saida += f.flush();

    assert.equal(saida, '**INGA** lidera com 143\n- segunda: MONDIAL (87)\nTotal: 230.');
    assert.equal(f.stats().resolvidas, 5);
    assert.deepEqual(f.stats().naoResolvidas, []);
});

test('resposta 100% ancorada não deixa número cru para auditar', async () => {
    // É a condição que faz o turno PULAR o detector. Se ela fosse frouxa, a
    // trava seria desligada em resposta que ainda tem número digitado.
    const { criarRegistroDeCitacoes, makeRefFilter, taxaDeAncoragem } =
        await import('../services/OfficeAI/anchoring.js');
    const reg = criarRegistroDeCitacoes();
    reg.anotar({ type: 'chart', labels: ['INGA'], data: [143] });

    const f = makeRefFilter(reg.registro);
    f.push('A {{ref:c1.nome}} teve {{ref:c1.valor}} vendas.');
    f.flush();
    const st = f.stats();

    assert.equal(st.crus, 0, 'nenhum número foi digitado pelo modelo');
    assert.equal(taxaDeAncoragem(st.crus, st.resolvidas), 1, 'tudo veio de referência');

    // O contraexemplo: um número digitado no meio derruba a taxa, e o detector
    // volta a ser necessário.
    const f2 = makeRefFilter(reg.registro);
    f2.push('A {{ref:c1.nome}} teve {{ref:c1.valor}} vendas e 999 reservas.');
    f2.flush();
    const st2 = f2.stats();
    assert.equal(st2.crus, 1);
    assert.ok(taxaDeAncoragem(st2.crus, st2.resolvidas) < 1);
});

test('stats: número partido entre chunks conta UMA vez', () => {
    // Somar a contagem pedaço a pedaço veria "14" e "3" como dois números
    // pequenos (que nem contam) e perderia o 143 - a taxa sairia otimista.
    const { registro } = anotarParaCitacao([{ rows: [{ nome: 'INGA' }] }]);
    const f = makeRefFilter(registro);
    f.push('Foram 14');
    f.push('3 reservas.');
    f.flush();
    assert.equal(f.stats().crus, 1);
});

test('referência pelo caminho do resumo resolve; caminho inexistente vira marcador, nunca texto cru', () => {
    const reg = criarRegistroDeCitacoes();
    reg.anotar({ naoLidos: 1, emails: [{ id: 'X', de: 'JOÃO PEREZ', assunto: 'RE: Erro', previa: 'Bom dia' }] });
    const r = resolverRefs('{{ref:r1.de}} · {{ref:emails.0.assunto}} · {{ref:emails[0].previa}} · {{ref:v1}} · {{ref:emails.9.assunto}}', reg.registro);
    assert.equal(r.texto, 'JOÃO PEREZ · RE: Erro · Bom dia · 1 · …');
    assert.equal(r.resolvidas, 4);
    assert.deepEqual(r.naoResolvidas, ['emails.9.assunto']);
    assert.ok(!r.texto.includes('{{ref:'));
});
