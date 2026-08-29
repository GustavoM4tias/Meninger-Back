// services/comercial/simuladorPvService.js
//
// O pacote que alimenta o simulador de proposta de venda (bloco `simulator-pv`
// dos Relatórios).
//
// Ele existe para responder uma pergunta só: **qual é a tabela padrão válida
// hoje para este empreendimento, unidade por unidade?** É o que a planilha "PV
// PADRÃO" fazia à mão - alguém abria a tabela do mês, copiava o fluxo da
// unidade e comparava com a proposta do cliente.
//
// DE ONDE VEM A TABELA (e por que não é a ficha comercial)
//
// A ficha comercial (`enterprise_conditions`) NÃO guarda fluxo de pagamento.
// Ela guarda regras (ato mínimo, entrada máxima, teto de parcelas) e APONTA,
// por módulo, quais tabelas de preço do CV valem naquele mês. O fluxo por
// unidade - ato, mensais, semestrais, chaves, com data e valor - mora no
// `raw.metadados.unidades[].series[]` da tabela do CV.
//
// Então a corrente é: ficha do mês -> price_table_ids do módulo -> tabela do CV
// -> séries da unidade. A ficha decide QUAL tabela vale; a tabela tem o fluxo.
//
// FILTRO DE "AUTORIZADA E ATUALIZADA"
//
// Tabela só entra se `aprovado` e `ativo_painel` forem verdadeiros - o CV usa
// esses dois para dizer "esta é a que o corretor pode vender". Entre as que
// sobram, vence a de vigência mais recente. Uma tabela vencida ainda serve de
// referência histórica, mas o simulador avisa em vez de fingir que está no ar.
//
// AS REGRAS DO FLUXO
//
// Os cortes (ato 1%, entrada 6%, 1º ano 25%, 2º ano 50%, até chaves 90%) vêm da
// planilha PV PADRÃO, que é hoje a única fonte deles - a ficha comercial não
// tem esses campos. Ficam em `regras` no pacote, e não fixos no componente,
// justamente para o dia em que virarem campo de tela: muda aqui, não no front.

import db from '../../models/sequelize/index.js';

const { Op } = db.Sequelize || {};

// Cortes da planilha PV PADRÃO. Fração do total nominal da proposta.
export const REGRAS_PADRAO = {
    vplAnual: 0.06,          // 6% a.a. -> a taxa mensal sai daí, como na planilha

    // A COMISSÃO SAI DO ATO, e é isso que dá sentido ao corte de 1%.
    //
    // O ato da tabela é 5% do valor da venda e a comissão da imobiliária é 4%:
    // do ato, entra 1% na companhia. Os cortes são medidos nesse LÍQUIDO - no
    // bruto, o ato apareceria como 5% e passaria com folga um valor que está
    // exatamente no limite. `mesDaComissao` é 0 porque ela sai junto com o ato.
    comissaoPct: 0.04,
    mesDaComissao: 0,

    // Ato: medido no LÍQUIDO. 5% de ato menos 4% de comissão = 1% que entra.
    atoMin: 0.01,
    // Daqui para baixo é o que o CLIENTE PAGA (bruto), que é como o desenho do
    // produto é falado.
    entrada6mMin: 0.06,
    // 1º e 2º ano DESLIGADOS em Sinop (null = corte não avaliado, some da tela).
    //
    // Os 25% e 50% vieram da aba URBAN, de Marília, onde o cliente paga quase
    // tudo antes da chave. Sinop é 30/70: 30% de recurso próprio até a entrega
    // e 70% de financiamento quando recebe o apartamento. Cobrar 25% no 1º ano
    // de um produto assim reprovaria a própria tabela autorizada.
    primeiroAnoMin: null,
    segundoAnoMin: null,
    ateChavesMin: 0.90,
    // O 30 do 30/70: tudo que o cliente paga com recurso próprio, fora o
    // financiamento da entrega.
    //
    // É a NATUREZA do dinheiro, não a data. Parcela de recurso próprio que cai
    // depois da chave continua compondo os 30% - o que o calendário controla é
    // a regra de atraso, logo abaixo.
    recursoProprioMin: 0.30,
    // A planilha marca "ERRADO PASSOU DAS CHAVES" quando sobra parcela depois
    // da entrega. Aqui a folga é de DATA, em meses.
    //
    // Um mês é o padrão da casa: a REV08 tem 24 mensais a partir do mês 1 com a
    // chave no mês 23, então a última cai um mês depois e isso é normal. Dois ou
    // mais é proposta empurrando parcela para depois da chave, e bloqueia.
    semParcelaAposChaves: true,
    aposChavesMesesTolerancia: 1,
};

/** "02/09/2026" ou "2026-09-02" -> "2026-09-02" (só a data, sem fuso). */
function paraIso(valor) {
    // Coluna DATE do Postgres volta como Date. Formatar com String() daria
    // "Fri Jul 31" - e, pior, o fuso local jogaria a vigência para o dia
    // anterior. O calendário aqui é o do UTC, que é o que o CV gravou.
    if (valor instanceof Date) {
        return Number.isNaN(valor.getTime()) ? null : valor.toISOString().slice(0, 10);
    }
    const s = String(valor || '').trim();
    if (!s) return null;
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : null;
}

/**
 * Periodicidade em meses a partir do nome da série.
 *
 * O CV manda o nome por extenso ("PARCELAS SEMESTRAIS") e nenhum campo de
 * intervalo; sem isto, 4 semestrais viravam 4 parcelas seguidas e o fluxo
 * inteiro saía errado. É a mesma tabela de-para da planilha (ATO 1, MENSAL 1,
 * BIMESTRAL 2 ... ANUAL 12).
 */
function periodicidadeDe(nome) {
    const n = String(nome || '').toUpperCase();
    if (/BIMESTR/.test(n)) return 2;
    if (/TRIMESTR/.test(n)) return 3;
    if (/QUADRIMESTR/.test(n)) return 4;
    if (/SEMESTR/.test(n)) return 6;
    if (/ANUAL|ANUAIS/.test(n)) return 12;
    return 1;
}

/** Papel da série no fluxo - o que decide "até chaves" e "pós-chaves". */
function papelDe(nome) {
    const n = String(nome || '').toUpperCase();
    if (/^ATO|SINAL/.test(n)) return 'ato';
    if (/CHAVE/.test(n)) return 'chaves';
    // "RECURSO PRÓPRIO" é o oposto de financiamento e aparece assim em várias
    // tabelas do CV (Drumond, Moacir Marangoni). Cair no regex de baixo faria
    // ele sair da conta dos 30%, que é exatamente o que ele compõe.
    if (/RECURSOs+PR[ÓO]PRIO/.test(n)) return 'obra';
    if (/FINANCIAMENTO|FGTS|SUBS[ÍI]DIO/.test(n)) return 'financiamento';
    if (/ENTRADA/.test(n)) return 'entrada';
    return 'obra';
}

function numero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * A tabela do CV que vale para a ficha mais recente do empreendimento.
 *
 * Devolve também o que NÃO deu certo (`avisos`), porque um simulador que mostra
 * fluxo sem dizer "esta tabela venceu em agosto" é pior do que não mostrar.
 */
export async function tabelaVigente(idempreendimento) {
    const avisos = [];

    const emp = await db.CvEnterprise.findOne({
        where: { idempreendimento },
        attributes: ['idempreendimento', 'nome', 'cidade', 'estado'],
    });
    if (!emp) { const e = new Error('Empreendimento não encontrado.'); e.expose = 404; throw e; }

    // Ficha mais recente: a aprovada manda; sem nenhuma aprovada, a última
    // existente serve, mas o aviso vai junto.
    const fichas = await db.EnterpriseCondition.findAll({
        where: { idempreendimento },
        order: [['reference_month', 'DESC']],
        limit: 12,
    });
    const ficha = fichas.find(f => f.status === 'approved') || fichas[0] || null;
    if (!ficha) avisos.push('Este empreendimento não tem ficha comercial cadastrada.');
    else if (ficha.status !== 'approved') {
        avisos.push(`A ficha de ${String(ficha.reference_month).slice(0, 7)} está como "${ficha.status}", não aprovada.`);
    }

    // Tabelas apontadas pela ficha (nível ficha + nível módulo).
    let ids = [];
    if (ficha) {
        const mods = await db.sequelize.query(
            'SELECT price_table_ids FROM enterprise_condition_modules WHERE condition_id = :id',
            { replacements: { id: ficha.id }, type: db.sequelize.QueryTypes.SELECT },
        );
        ids = [
            ...(Array.isArray(ficha.price_table_ids) ? ficha.price_table_ids : []),
            ...mods.flatMap(m => (Array.isArray(m.price_table_ids) ? m.price_table_ids : [])),
        ].map(Number).filter(Number.isFinite);
    }

    const where = { idempreendimento, aprovado: true, ativo_painel: true };
    if (ids.length) where.idtabela = { [Op.in]: [...new Set(ids)] };

    let tabelas = await db.CvEnterprisePriceTable.findAll({
        where,
        order: [['data_vigencia_de', 'DESC']],
        limit: 5,
    });

    // A ficha aponta tabela que não está mais autorizada? Cai para a tabela
    // autorizada mais recente do empreendimento, dizendo o que fez.
    if (!tabelas.length && ids.length) {
        avisos.push('As tabelas apontadas pela ficha não estão autorizadas no CV; usei a autorizada mais recente do empreendimento.');
        tabelas = await db.CvEnterprisePriceTable.findAll({
            where: { idempreendimento, aprovado: true, ativo_painel: true },
            order: [['data_vigencia_de', 'DESC']],
            limit: 5,
        });
    }

    const tabela = tabelas[0] || null;
    if (!tabela) { const e = new Error('Nenhuma tabela de preço autorizada para este empreendimento.'); e.expose = 404; throw e; }

    const hoje = new Date().toISOString().slice(0, 10);
    const ate = paraIso(tabela.data_vigencia_ate);
    if (ate && ate < hoje) avisos.push(`A tabela "${tabela.nome}" venceu em ${ate.split('-').reverse().join('/')}.`);

    return { emp, ficha, tabela, avisos };
}

/**
 * Pacote completo do simulador: cabeçalho, regras e as unidades com o fluxo
 * padrão de cada uma, prontas para o bloco do relatório.
 *
 * Sai com os números já normalizados (número, não string do Postgres) porque
 * quem consome é um componente que faz conta - e `"58.000000"` somado vira
 * concatenação silenciosa.
 */
export async function montarSimulador(idempreendimento, { regras = {} } = {}) {
    const { emp, ficha, tabela, avisos } = await tabelaVigente(idempreendimento);

    const meta = tabela.raw?.metadados || {};
    const brutas = (Array.isArray(meta.unidades) && meta.unidades.length)
        ? meta.unidades
        : (tabela.raw?.unidades || []);

    const unidades = brutas.map((u) => {
        const series = (u.series || []).map((s) => ({
            nome: String(s.nome || 'PARCELA'),
            papel: papelDe(s.nome),
            valor: numero(s.valor),
            qtd: Math.max(1, Math.round(numero(s.qtd_parcelas) || 1)),
            periodicidade: periodicidadeDe(s.nome),
            vencimento: paraIso(s.data_vencimento),
        }));
        return {
            id: u.idunidade ?? null,
            nome: String(u.unidade || '').trim(),
            bloco: String(u.bloco || '').trim(),
            etapa: String(u.etapa || '').trim(),
            situacao: String(u.situacao || '').trim(),
            area: numero(u.area_privativa),
            total: numero(u.valor_total) || series.reduce((a, s) => a + s.valor * s.qtd, 0),
            series,
        };
    }).filter(u => u.nome && u.series.length);

    if (!unidades.length) avisos.push('A tabela autorizada não trouxe nenhuma unidade com fluxo.');

    // Mês base = o mês da PRIMEIRA parcela da tabela (o ato), não o início da
    // vigência.
    //
    // Medido: a vigência da tabela do Verona começa em 01/08 e o ato vence em
    // 02/09. Usando a vigência, o ato caía no mês 1 e o mês 0 ficava vazio -
    // o corte "ato >= 1%" dava zero e reprovava a PRÓPRIA tabela padrão. O mês
    // 0 da planilha é o mês em que o negócio começa a ser pago, e é isso que
    // faz "6 primeiros meses", "1º ano" e "2º ano" quererem dizer alguma coisa.
    const primeiro = unidades
        .flatMap(u => u.series.map(s => s.vencimento))
        .filter(Boolean)
        .sort()[0];
    const mesBase = primeiro
        || paraIso(tabela.data_vigencia_de)
        || new Date().toISOString().slice(0, 10);

    return {
        empreendimento: {
            id: emp.idempreendimento,
            nome: emp.nome,
            cidade: [emp.cidade, emp.estado].filter(Boolean).join(' - '),
        },
        ficha: ficha ? {
            id: ficha.id,
            mes: String(ficha.reference_month).slice(0, 7),
            status: ficha.status,
            aprovada: ficha.status === 'approved',
        } : null,
        tabela: {
            id: tabela.idtabela,
            nome: tabela.nome,
            de: paraIso(tabela.data_vigencia_de),
            ate: paraIso(tabela.data_vigencia_ate),
            maxParcelas: tabela.maximo_parcelas ?? null,
        },
        mesBase,
        regras: { ...REGRAS_PADRAO, ...regras },
        avisos,
        unidades,
        geradoEm: new Date().toISOString(),
    };
}

export default { montarSimulador, tabelaVigente, REGRAS_PADRAO };
