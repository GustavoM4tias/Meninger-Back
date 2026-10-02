// services/comercial/recursoProprioService.js
//
// Relatório de Recurso Próprio por cliente (/comercial/relatorios/recurso-proprio).
// Nasceu do relatório feito à mão para o Residencial Ingá (set/2026) e virou
// padrão para qualquer empreendimento.
//
// TRÊS FONTES, cada uma com um papel que não se mistura:
//
// 1. CONDIÇÃO = financeiro da reserva no CV (`reservas.condicoes.series`).
//    É o que está descrito para ser pago, e NADA é recalculado. Foi a primeira
//    correção do usuário no Ingá: "a ficha comercial coloca regras, não
//    condição; a condição é única e exclusivamente o que está no financeiro da
//    reserva no CV". Recurso próprio = ato + parcelas, como estão lá.
//
// 2. REGRA = Ficha Comercial mais recente (autorizada, se houver) do
//    empreendimento, no módulo da etapa da reserva. A ficha só CONFERE: ato
//    mínimo, parcela mínima, máximo de parcelas, entrada máxima e o limite da
//    parcela sobre a renda (lido do texto "Regra do RP"). Ela nunca troca um
//    valor da reserva.
//
// 3. RECEBIDO = entrada de caixa no Sienge (API ao vivo, /bulk-data/v1/income)
//    casada pelo cliente do Sienge, mais o que foi pago em boleto no Office e o
//    Sienge ainda não lançou. Só conta operação que é dinheiro (Recebimento e
//    Adiantamento): reparcelamento, promoção, distrato e o "Abatimento de
//    Adiantamento" baixam título sem entrar caixa.
//
// Tudo que é regra de leitura (quais séries são ato, parcela, subsídio; quais
// situações ficam de fora; quais condições do Sienge contam) é CONFIGURÁVEL na
// tela; as constantes abaixo são só o fallback de quando nada foi gravado.

import db from '../../models/sequelize/index.js';
import apiSienge from '../../lib/apiSienge.js';
import { getScope } from '../permissions/accessScopeService.js';
import { nomeAtual } from '../org/enterpriseNames.js';
import { summarizeUnitsFromDb, classifyUnitStatus } from '../cv/enterpriseUnitsSummaryService.js';
import { setEstoqueComercial } from '../cv/unitStockService.js';

const sequelize = db.sequelize;
const Q = { type: db.Sequelize.QueryTypes.SELECT };

// ── Configuração ─────────────────────────────────────────────────────────────

// Séries do CV medidas em 01/10/2026 sobre 12 meses de reservas. A sigla do CV
// não serve de chave: "FGTS" (15) e "Casa Paulista" (23) vêm com sigla FI, e
// "Semestral" (5) vem com SE, a mesma do subsídio estadual. Por isso é o id.
export const DEFAULTS = {
    series: {
        ato: [21, 9],                 // Recurso Próprio a Vista, Ato
        mensais: [20, 1, 13, 35, 37], // RP Parcelado, Parcelas Mensais (com juros), Pré-Chaves, Mensais URBAN
        // Entrada, Parcelas Iniciais, Anuais, Semestrais, Chaves, Documentação, Cartão
        outras_parcelas: [16, 11, 18, 19, 26, 5, 38, 39, 34, 27],
        financiamento: [17, 3],
        fgts: [15, 25],               // FGTS, Recurso Próprio FGTS
        federal: [24, 29],            // Subsidio Federal, Subsidio (antigo)
        // Casa Paulista (23 e 28, antiga), Casa Fácil, Bônus Emendas, Ser Família
        estadual: [23, 28, 30, 33, 36],
        desconto: [22],               // Desconto Construtora
    },
    situacoes_excluidas: ['Cancelada', 'Distrato', 'Vencida'],
    // O limite da parcela sobre a renda vem SÓ da ficha (texto da Regra do RP).
    // Já houve um padrão de 30% aqui: o Adhara (30/70) não tem regra de renda e
    // o relatório acusava 8 clientes "acima de 30%" (02/10/2026).
    // Acima do limite até limite + tolerância = amarelo ("saiu bem pouco da
    // regra", Ingá); passou disso = vermelho.
    tolerancia_renda_pct: 5,
    sienge_documentos: ['CT', 'AVC'],
    sienge_condicoes_ato: ['RA', 'AT'],
    sienge_condicoes_excluidas: ['FI', 'FG', 'SB', 'SE', 'SF', 'DC'],
    // Só operação que é DINHEIRO entrando: 2 = Recebimento, 10 = Adiantamento.
    // Medido em 01/10/2026 nas empresas 60 e 69: o Sienge também baixa título
    // por Reparcelamento (4), Distrato (7), Abatimento de Adiantamento (8, a
    // baixa do contrato que só compensa um adiantamento já contado) e Promoção
    // (14). Contadas, elas punham o recebido do Edifício Soul em 3x o recurso
    // próprio.
    sienge_operacoes_contam: [2, 10],
    // Recebimento só conta a partir de N dias antes da data da reserva: evita
    // pegar pagamento de uma compra anterior do mesmo cliente.
    recebido_folga_dias: 15,
};

const GRUPOS_SERIE = Object.keys(DEFAULTS.series);

const intList = (v) => [...new Set((Array.isArray(v) ? v : [])
    .map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0))];
const strList = (v) => [...new Set((Array.isArray(v) ? v : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean))];
const numIn = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** Valida o que veio da tela. Chave inválida é recusada com mensagem, não ignorada. */
function sanitizarConfig(raw = {}) {
    const out = {};
    const erros = [];
    if (raw.series !== undefined) {
        const series = {};
        const vistos = new Map();
        for (const g of GRUPOS_SERIE) {
            series[g] = intList(raw.series?.[g]);
            for (const id of series[g]) {
                if (vistos.has(id)) erros.push(`A série ${id} está em "${vistos.get(id)}" e em "${g}". Cada série entra em um grupo só.`);
                vistos.set(id, g);
            }
        }
        out.series = series;
    }
    if (raw.situacoes_excluidas !== undefined) out.situacoes_excluidas = strList(raw.situacoes_excluidas);
    for (const k of ['sienge_documentos', 'sienge_condicoes_ato', 'sienge_condicoes_excluidas']) {
        if (raw[k] !== undefined) out[k] = strList(raw[k]).map((s) => s.toUpperCase());
    }
    if (raw.sienge_operacoes_contam !== undefined) out.sienge_operacoes_contam = intList(raw.sienge_operacoes_contam);
    if (raw.tolerancia_renda_pct !== undefined) {
        const n = numIn(raw.tolerancia_renda_pct, 0, 50);
        if (n == null) erros.push('Tolerância deve ficar entre 0 e 50 pontos.'); else out.tolerancia_renda_pct = n;
    }
    if (raw.recebido_folga_dias !== undefined) {
        const n = numIn(raw.recebido_folga_dias, 0, 365);
        if (n == null) erros.push('Folga do recebido deve ficar entre 0 e 365 dias.'); else out.recebido_folga_dias = Math.round(n);
    }
    return { config: out, erros };
}

export async function getConfig() {
    const [row] = await sequelize.query(
        `SELECT config, updated_at FROM recurso_proprio_settings WHERE id = 1`, Q);
    const salvo = row?.config || {};
    // O painel ganha do código chave a chave: o que nunca foi gravado cai no default.
    const efetivo = { ...DEFAULTS, ...salvo, series: { ...DEFAULTS.series, ...(salvo.series || {}) } };
    return { config: efetivo, salvo, defaults: DEFAULTS, atualizadoEm: row?.updated_at || null };
}

/** Séries que existem nas reservas, para a tela de configuração mostrar nome e uso. */
export async function catalogoSeries() {
    return sequelize.query(
        `SELECT (ser->>'idserie')::int AS id, MAX(ser->>'serie') AS nome, MAX(ser->>'sigla') AS sigla, COUNT(*)::int AS usos
           FROM reservas r, jsonb_array_elements(COALESCE(r.condicoes->'series', '[]'::jsonb)) ser
          WHERE ser->>'idserie' ~ '^[0-9]+$'
          GROUP BY 1 ORDER BY 1`, Q);
}

export async function saveConfig(raw, user) {
    const { config, erros } = sanitizarConfig(raw);
    if (erros.length) {
        const e = new Error(erros.join(' '));
        e.status = 400;
        throw e;
    }
    await sequelize.query(
        `INSERT INTO recurso_proprio_settings (id, config, updated_by, updated_at)
         VALUES (1, CAST(:config AS jsonb), :uid, NOW())
         ON CONFLICT (id) DO UPDATE
            SET config = recurso_proprio_settings.config || EXCLUDED.config,
                updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        { replacements: { config: JSON.stringify(config), uid: user?.id ?? null } });
    return getConfig();
}

// ── Escopo ───────────────────────────────────────────────────────────────────

async function cvIdsVisiveis(user) {
    const s = await getScope(user);
    return s.all ? null : s.cvIds;
}

function erro(status, msg) {
    const e = new Error(msg);
    e.status = status;
    return e;
}

async function exigirEmpreendimento(user, idemp) {
    const id = parseInt(idemp, 10);
    if (!Number.isFinite(id) || id <= 0) throw erro(400, 'Escolha um empreendimento.');
    const vis = await cvIdsVisiveis(user);
    if (vis && !vis.includes(id)) throw erro(403, 'Você não tem acesso a este empreendimento.');
    return id;
}

/** Empreendimentos com reserva ativa que o usuário enxerga (para o seletor). */
export async function listarEmpreendimentos(user) {
    const { config } = await getConfig();
    const vis = await cvIdsVisiveis(user);
    if (vis && !vis.length) return [];
    const rows = await sequelize.query(
        `SELECT r.idempreendimento_cv AS id, MAX(r.empreendimento) AS nome, COUNT(*)::int AS reservas
           FROM reservas r
          WHERE r.idempreendimento_cv IS NOT NULL
            AND NOT (COALESCE(r.situacao->>'situacao', r.status_reserva, '') = ANY(ARRAY[:excl]::text[]))
            ${vis ? 'AND r.idempreendimento_cv IN (:vis)' : ''}
          GROUP BY r.idempreendimento_cv`,
        { ...Q, replacements: { excl: config.situacoes_excluidas.length ? config.situacoes_excluidas : [''], vis: vis || [0] } });
    for (const r of rows) r.nome = await nomeAtual(r.id).catch(() => null) || r.nome;
    return rows.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}

// ── Condição (CV) ────────────────────────────────────────────────────────────

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const cents = (v) => Math.round(v * 100) / 100;

/** Lê as séries da reserva e devolve a condição, sem recalcular nada. */
export function lerCondicao(condicoes, seriesCfg) {
    const grupoDe = new Map();
    for (const g of GRUPOS_SERIE) for (const id of seriesCfg[g] || []) grupoDe.set(Number(id), g);

    const soma = Object.fromEntries(GRUPOS_SERIE.map((g) => [g, 0]));
    const naoClassificadas = [];
    // As linhas do financeiro como estão no CV, para o detalhe da reserva.
    const linhas = [];
    let nMensais = 0;
    let parcelaMensal = 0;
    let maiorQtd = -1;

    for (const s of condicoes?.series || []) {
        const id = Number(s.idserie);
        const qtd = Math.max(1, parseInt(s.quantidade, 10) || 1);
        const valor = num(s.valor);
        // valor_serie é o total da linha; reservas antigas trazem "0" nele
        // (Edifício Soul, 2022), e aí vale valor x quantidade.
        const total = num(s.valor_serie) > 0 ? num(s.valor_serie) : valor * qtd;
        const g = grupoDe.get(id);
        linhas.push({
            idserie: id, serie: s.serie || null, sigla: s.sigla || null, grupo: g || null,
            quantidade: qtd, valor: cents(valor), total: cents(total), vencimento: s.vencimento || null,
        });
        if (!g) {
            naoClassificadas.push({ idserie: id, serie: s.serie || null, total: cents(total) });
            continue;
        }
        soma[g] += total;
        if (g === 'mensais') {
            nMensais += qtd;
            // A parcela que pesa na renda é a da linha principal (a de maior
            // quantidade): a de 1x no fim é resíduo de arredondamento.
            if (qtd > maiorQtd) { maiorQtd = qtd; parcelaMensal = valor; }
        }
    }
    const ato = cents(soma.ato);
    const parcelas = cents(soma.mensais + soma.outras_parcelas);
    return {
        venda: num(condicoes?.valor_contrato),
        financiamento: cents(soma.financiamento),
        fgts: cents(soma.fgts),
        federal: cents(soma.federal),
        estadual: cents(soma.estadual),
        desconto: cents(soma.desconto),
        ato,
        parcelas,
        outrasParcelas: cents(soma.outras_parcelas),
        recursoProprio: cents(ato + parcelas),
        nMensais,
        parcelaMensal: cents(parcelaMensal),
        naoClassificadas,
        linhas,
    };
}

// ── Regra (Ficha Comercial) ──────────────────────────────────────────────────

// "parcela do cliente não pode ultrapassar 30% da renda comprovada"
const RE_RENDA = /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:d[aeo]s?\s+)?(?:\w+\s+){0,2}renda/i;

export function limiteRendaDoTexto(texto) {
    const m = String(texto || '').match(RE_RENDA);
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    return n > 0 && n <= 100 ? n : null;
}

const CAMPOS_REGRA = ['act_installment_value', 'rp_installment_value', 'max_installments', 'max_entry_value', 'rp_rule'];

/**
 * Fichas do empreendimento (até 3 anos), com os módulos.
 *
 * A regra é a da ficha MAIS RECENTE (pedido do usuário: "as regras estão na
 * ficha comercial mais recente"). Ela só confere reservas feitas a partir do
 * mês da PRIMEIRA ficha da série: medido em 01/10/2026, conferir venda de 2021
 * contra a ficha de outubro/2026 marcava o Parque dos Ipês inteiro por uma
 * parcela mínima que nem existia na época. Conferir pela ficha do mês da
 * reserva também foi testado e descartado: as fichas de maio a agosto do Ingá
 * (rascunhos nunca autorizados) pediam ato de R$ 1.200 e acusavam 41 de 53.
 */
async function carregarFichas(idemp) {
    const fichas = await sequelize.query(
        `SELECT id, reference_month, status, ${CAMPOS_REGRA.join(', ')}
           FROM enterprise_conditions
          WHERE idempreendimento = :idemp
          ORDER BY reference_month DESC, id DESC
          LIMIT 36`,
        { ...Q, replacements: { idemp } });
    if (!fichas.length) return null;
    const modulos = await sequelize.query(
        `SELECT id, condition_id, idetapa, module_name, ${CAMPOS_REGRA.join(', ')}
           FROM enterprise_condition_modules
          WHERE condition_id IN (:ids)
          ORDER BY sort_order, id`,
        { ...Q, replacements: { ids: fichas.map((f) => f.id) } });
    const porFicha = new Map(fichas.map((f) => [f.id, []]));
    for (const m of modulos) porFicha.get(m.condition_id)?.push(m);
    const mesDe = (v) => diaDe(v).slice(0, 7);
    // Uma ficha por mês; havendo mais de uma, a autorizada ganha.
    const porMes = new Map();
    const ok = (x) => x.status === 'approved' || x.status === 'closed';
    for (const f of fichas) {
        f.modulos = porFicha.get(f.id) || [];
        const k = mesDe(f.reference_month);
        const atual = porMes.get(k);
        if (!atual || (!ok(atual) && ok(f))) porMes.set(k, f);
    }
    return { fichas, porMes, maisRecente: fichas[0], primeiroMes: mesDe(fichas[fichas.length - 1].reference_month) };
}

function regraDaFicha(ficha, idetapa) {
    if (!ficha) return null;
    const mods = ficha.modulos || [];
    const m = mods.find((x) => x.idetapa && Number(x.idetapa) === Number(idetapa))
        || (mods.length === 1 ? mods[0] : null);
    return { ...regrasDoModulo(ficha, m), ficha: { id: ficha.id, mes: diaDe(ficha.reference_month), status: ficha.status } };
}

function regrasDoModulo(base, modulo) {
    const pick = (k) => {
        const v = modulo?.[k];
        return v !== null && v !== undefined && v !== '' ? v : base?.[k] ?? null;
    };
    const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const textoRp = pick('rp_rule');
    return {
        modulo: modulo ? { id: modulo.id, nome: modulo.module_name, idetapa: modulo.idetapa } : null,
        atoMinimo: n(pick('act_installment_value')),
        parcelaMinima: n(pick('rp_installment_value')),
        maxParcelas: n(pick('max_installments')),
        maxEntradaPct: n(pick('max_entry_value')),
        regraRp: textoRp || null,
        limiteRendaPct: limiteRendaDoTexto(textoRp),
    };
}

/** Conferência da condição contra a regra. Só aponta; não muda valor. */
export function conferir(c, regra) {
    const fora = [];
    const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // Reserva sem série de ato (ato embutido em outra série) não é "ato zero".
    if (regra.atoMinimo > 0 && c.ato > 0 && c.ato + 0.005 < regra.atoMinimo) {
        fora.push({ codigo: 'ato', texto: `Ato de ${brl(c.ato)} abaixo do mínimo da ficha (${brl(regra.atoMinimo)})` });
    }
    if (regra.maxParcelas > 0 && c.nMensais > regra.maxParcelas) {
        fora.push({ codigo: 'parcelas', texto: `${c.nMensais} parcelas, a ficha permite até ${regra.maxParcelas}` });
    }
    if (regra.parcelaMinima > 0 && c.nMensais > 0 && c.parcelaMensal + 0.005 < regra.parcelaMinima) {
        fora.push({ codigo: 'parcela_min', texto: `Parcela de ${brl(c.parcelaMensal)} abaixo do mínimo da ficha (${brl(regra.parcelaMinima)})` });
    }
    // "Máx. Entrada (%)" da ficha fica FORA da conferência de propósito: a
    // ficha não diz sobre qual base o percentual é medido (venda? avaliação?
    // ato + parcelas?), e medido sobre a venda ele marcava 117 das 320 reservas
    // do Jardim Mônaco. O valor aparece no quadro de regras, sem julgamento.
    return fora;
}

// ── Recebido (Sienge ao vivo + Office) ───────────────────────────────────────

const TTL_MS = 10 * 60_000;
const _cache = new Map();

async function getIncome(params, tentativas = 3) {
    for (let i = 1; ; i++) {
        try {
            const { data } = await apiSienge.get('/bulk-data/v1/income', { params });
            return Array.isArray(data?.data) ? data.data : [];
        } catch (e) {
            const status = e.response?.status;
            if (status !== 429 || i >= tentativas) {
                console.error(`[recurso-proprio] Sienge ${status ?? 'sem status'}: ${e.message}`);
                throw e;
            }
            const reset = Number(e.response?.headers?.['ratelimit-reset']) || 5;
            await new Promise((r) => setTimeout(r, Math.min(reset + 1, 65) * 1000));
        }
    }
}

const isoDia = (d) => d.toISOString().slice(0, 10);
// data_reserva chega como Date (timestamp) ou texto, conforme a coluna.
const diaDe = (v) => {
    if (!v) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoDia(v);
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : '';
};

/** Recebimentos de uma empresa num período, em janelas de 6 meses (resposta sem paginação). */
async function incomeDaEmpresa(companyId, inicio, fim) {
    const chave = `${companyId}|${inicio}|${fim}`;
    const hit = _cache.get(chave);
    if (hit && Date.now() - hit.t < TTL_MS) return hit;
    const bills = [];
    let a = new Date(`${inicio}T00:00:00Z`);
    const f = new Date(`${fim}T00:00:00Z`);
    while (a <= f) {
        const b = new Date(a);
        b.setUTCMonth(b.getUTCMonth() + 6);
        b.setUTCDate(b.getUTCDate() - 1);
        const ate = b < f ? b : f;
        bills.push(...await getIncome({ startDate: isoDia(a), endDate: isoDia(ate), selectionType: 'P', companyId }));
        a = new Date(ate);
        a.setUTCDate(a.getUTCDate() + 1);
    }
    if (_cache.size > 30) for (const [k, o] of _cache) if (Date.now() - o.t >= TTL_MS) _cache.delete(k);
    const v = { t: Date.now(), bills };
    _cache.set(chave, v);
    return v;
}

const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Uma linha por recebimento que conta, agrupada pelo cliente do Sienge. */
function recebimentosPorCliente(bills, config) {
    const docs = new Set(config.sienge_documentos);
    const exclCond = new Set(config.sienge_condicoes_excluidas);
    const contaOp = new Set(config.sienge_operacoes_contam.map(Number));
    const atoCond = new Set(config.sienge_condicoes_ato);
    const porId = new Map();
    const porNome = new Map();
    for (const b of bills) {
        const doc = String(b.documentIdentificationId || '').trim().toUpperCase();
        if (docs.size && !docs.has(doc)) continue;
        const cond = String(b.paymentTerm?.id || '').trim().toUpperCase();
        if (exclCond.has(cond)) continue;
        for (const r of b.receipts || []) {
            if (!contaOp.has(Number(r.operationTypeId))) continue;
            const valor = num(r.netAmount);
            if (!valor) continue;
            const item = {
                unidade: normNome(b.mainUnit),
                data: String(r.paymentDate || '').slice(0, 10),
                valor,
                condicao: cond,
                ato: atoCond.has(cond),
                titulo: b.billId,
                parcela: b.installmentNumber || null,
            };
            const id = Number(b.clientId);
            if (Number.isFinite(id)) {
                if (!porId.has(id)) porId.set(id, []);
                porId.get(id).push(item);
            }
            const nome = normNome(b.clientName);
            if (nome) {
                if (!porNome.has(nome)) porNome.set(nome, []);
                porNome.get(nome).push(item);
            }
        }
    }
    return { porId, porNome };
}

/** Ato = recebimento em condição de ato; sem nenhum, o primeiro recebimento do cliente. */
function separarAto(itens) {
    const ord = [...itens].sort((a, b) => a.data.localeCompare(b.data));
    let atos = ord.filter((i) => i.ato);
    if (!atos.length && ord.length) atos = [ord[0]];
    const set = new Set(atos);
    const mensais = ord.filter((i) => !set.has(i));
    const porCondicao = {};
    for (const i of ord) porCondicao[i.condicao || '?'] = cents((porCondicao[i.condicao || '?'] || 0) + i.valor);
    return {
        porCondicao,
        // Lista do detalhe (mais nova primeiro). Teto de 240 para o payload do
        // Terras V (724 reservas) não estourar com cliente de 20 anos de carnê.
        itens: [...ord].reverse().slice(0, 240).map((i) => ({
            data: i.data, valor: cents(i.valor), condicao: i.condicao, titulo: i.titulo,
            parcela: i.parcela, ato: set.has(i),
        })),
        ato: cents(atos.reduce((s, i) => s + i.valor, 0)),
        mensais: cents(mensais.reduce((s, i) => s + i.valor, 0)),
        nMensais: mensais.length,
        ultimo: ord.length ? ord[ord.length - 1].data : null,
    };
}

async function pagoNoOffice(ids) {
    if (!ids.length) return { atos: new Map(), parcelas: new Map() };
    const atosRows = await sequelize.query(
        `SELECT idreserva, SUM(COALESCE(valor, 0))::float AS valor, MAX(paid_at) AS pago_em
           FROM boleto_history
          WHERE idreserva IN (:ids) AND parcela_id IS NULL
            AND status = 'success' AND payment_status = 'paid' AND ignorado = false
          GROUP BY idreserva`,
        { ...Q, replacements: { ids } }).catch(() => []);
    const parcRows = await sequelize.query(
        `SELECT idreserva, COUNT(*)::int AS n, SUM(COALESCE(valor_cobrado, valor, 0))::float AS valor
           FROM ato_parcelas
          WHERE idreserva IN (:ids) AND status = 'paga'
          GROUP BY idreserva`,
        { ...Q, replacements: { ids } }).catch(() => []);
    return {
        atos: new Map(atosRows.map((r) => [Number(r.idreserva), r])),
        parcelas: new Map(parcRows.map((r) => [Number(r.idreserva), r])),
    };
}

// ── Relatório ────────────────────────────────────────────────────────────────

/** Estoque de UMA etapa (módulo), pelo mesmo critério do resumo do empreendimento. */
async function estoqueDaEtapa(idetapa) {
    const blocos = await sequelize.query(
        `SELECT idbloco FROM cv_enterprise_blocks WHERE idetapa = :idetapa`,
        { ...Q, replacements: { idetapa } });
    if (!blocos.length) return null;
    const unidades = await sequelize.query(
        `SELECT idunidade, situacao_mapa_disponibilidade, data_bloqueio
           FROM cv_enterprise_units WHERE idbloco IN (:ids)`,
        { ...Q, replacements: { ids: blocos.map((b) => b.idbloco) } });
    if (!unidades.length) return null;
    const segurado = await setEstoqueComercial(unidades.map((u) => u.idunidade));
    const e = { totalUnits: 0, soldUnits: 0, reservedUnits: 0, blockedUnits: 0, availableUnits: 0, commercialStockUnits: 0 };
    for (const u of unidades) {
        e.totalUnits++;
        const st = classifyUnitStatus(u);
        if (st.isSold) e.soldUnits++;
        else if (st.isReserved) e.reservedUnits++;
        else if (st.isBlocked) {
            e.blockedUnits++;
            if (segurado.has(Number(u.idunidade))) e.commercialStockUnits++;
        } else e.availableUnits++;
    }
    e.availableForSale = e.availableUnits + e.commercialStockUnits;
    return e;
}

export async function getRelatorio(user, idempRaw, idetapaRaw = null) {
    const idemp = await exigirEmpreendimento(user, idempRaw);
    const idetapaPedida = parseInt(idetapaRaw, 10);
    const { config } = await getConfig();

    const reservas = await sequelize.query(
        `SELECT r.idreserva, r.idprecadastro, r.data_reserva, r.condicoes,
                COALESCE(r.situacao->>'situacao', r.status_reserva) AS situacao,
                r.titular->>'nome' AS titular_nome,
                r.titular->>'idpessoa_int' AS titular_sienge,
                r.titular->>'renda_familiar' AS titular_renda,
                r.unidade_json->>'unidade' AS unidade,
                r.unidade_json->>'etapa' AS etapa,
                r.unidade_json->>'idetapa_cv' AS idetapa,
                r.unidade_json->>'idempreendimento_int' AS empresa_int,
                r.unidade_json->>'area_terreno' AS area_terreno,
                r.unidade_json->>'area_privativa' AS area_privativa,
                COALESCE(NULLIF(r.corretor->>'corretor',''), NULLIF(r.corretor->>'nome','')) AS corretor,
                COALESCE(NULLIF(r.imobiliaria->>'nome',''), NULLIF(r.corretor->>'imobiliaria','')) AS imobiliaria,
                p.renda_total AS renda_precadastro,
                (SELECT jsonb_agg(jsonb_build_object('nome', a->>'nome', 'tipo', a->>'tipo_associado'))
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.associados) = 'array' THEN r.associados ELSE '[]'::jsonb END) a
                  WHERE a->>'tipo_associado' ILIKE 'Fiador%') AS fiadores,
                n.texto AS nota_texto, n.tom AS nota_tom, n.updated_by_name AS nota_por, n.updated_at AS nota_em
           FROM reservas r
           LEFT JOIN cv_precadastros p ON p.idprecadastro = r.idprecadastro
           LEFT JOIN recurso_proprio_notas n ON n.idreserva = r.idreserva
          WHERE r.idempreendimento_cv = :idemp`,
        { ...Q, replacements: { idemp } });

    const excl = new Set(config.situacoes_excluidas);
    // Módulos (etapas do CV) com reserva ativa: é o seletor ao lado do
    // empreendimento. Contado ANTES do recorte, para o seletor não encolher.
    const porEtapa = new Map();
    for (const r of reservas) {
        if (excl.has(r.situacao) || !r.idetapa) continue;
        const k = Number(r.idetapa);
        const m = porEtapa.get(k) || { idetapa: k, nome: r.etapa || `Etapa ${k}`, reservas: 0 };
        m.reservas++;
        porEtapa.set(k, m);
    }
    const modulos = [...porEtapa.values()].sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR', { numeric: true }));
    const idetapa = Number.isFinite(idetapaPedida) && porEtapa.has(idetapaPedida) ? idetapaPedida : null;

    const excluidas = {};
    const ativas = [];
    for (const r of reservas) {
        if (idetapa && Number(r.idetapa) !== idetapa) continue;
        if (excl.has(r.situacao)) excluidas[r.situacao] = (excluidas[r.situacao] || 0) + 1;
        else ativas.push(r);
    }

    // Regra: a ficha mais recente, para reservas do tempo das fichas (ver carregarFichas).
    const fr = await carregarFichas(idemp);
    const regraDe = (dataReserva, idetapa) => {
        if (!fr) return null;
        const mes = diaDe(dataReserva).slice(0, 7);
        if (!mes || mes < fr.primeiroMes) return null;
        return regraDaFicha(fr.maisRecente, idetapa);
    };

    // Recebido
    const recebido = { fonte: 'sienge', empresas: [], consultadoEm: null, erro: null };
    let porId = new Map();
    let porNome = new Map();
    const empresas = new Set();
    const [ent] = await sequelize.query(
        `SELECT company_id FROM enterprises WHERE cv_id = :idemp AND company_id IS NOT NULL LIMIT 1`,
        { ...Q, replacements: { idemp } });
    if (ent?.company_id) empresas.add(Number(ent.company_id));
    for (const r of ativas) {
        // idempreendimento_int traz ora a empresa (106), ora o centro de custo
        // (10601): só serve como empresa quando tem cara de empresa.
        const e = parseInt(r.empresa_int, 10);
        if (Number.isFinite(e) && e > 0 && e < 1000) empresas.add(e);
    }
    if (ativas.length && empresas.size) {
        const datas = ativas.map((r) => diaDe(r.data_reserva)).filter(Boolean).sort();
        const ini = new Date(`${datas[0] || isoDia(new Date())}T00:00:00Z`);
        ini.setUTCDate(ini.getUTCDate() - config.recebido_folga_dias);
        try {
            const bills = [];
            let t = Date.now();
            for (const e of empresas) {
                const res = await incomeDaEmpresa(e, isoDia(ini), isoDia(new Date()));
                bills.push(...res.bills);
                t = Math.min(t, res.t);
            }
            ({ porId, porNome } = recebimentosPorCliente(bills, config));
            recebido.consultadoEm = new Date(t).toISOString();
        } catch (e) {
            recebido.erro = 'Não foi possível consultar o Sienge agora. O recebido mostra só o que foi pago no Office.';
        }
    } else if (ativas.length) {
        recebido.erro = 'Empreendimento sem empresa do Sienge pareada. O recebido mostra só o que foi pago no Office.';
    }
    recebido.empresas = [...empresas];

    // Homônimo entre os titulares não casa por nome: o dinheiro iria para o errado.
    const contNome = new Map();
    const contCliente = new Map();
    for (const r of ativas) {
        const k = normNome(r.titular_nome);
        contNome.set(k, (contNome.get(k) || 0) + 1);
        const c = parseInt(r.titular_sienge, 10);
        if (Number.isFinite(c)) contCliente.set(c, (contCliente.get(c) || 0) + 1);
    }

    const office = await pagoNoOffice(ativas.map((r) => Number(r.idreserva)));

    const linhas = ativas.map((r) => {
        const c = lerCondicao(r.condicoes, config.series);
        const renda = num(r.renda_precadastro) || num(r.titular_renda);
        const pct = renda > 0 && c.parcelaMensal > 0 ? c.parcelaMensal / renda : 0;
        const regra = regraDe(r.data_reserva, r.idetapa);

        const desde = (() => {
            const d = diaDe(r.data_reserva);
            if (!d) return '';
            const x = new Date(`${d}T00:00:00Z`);
            x.setUTCDate(x.getUTCDate() - config.recebido_folga_dias);
            return isoDia(x);
        })();
        const idSienge = parseInt(r.titular_sienge, 10);
        const nomeK = normNome(r.titular_nome);
        let itens = (Number.isFinite(idSienge) && porId.get(idSienge)) || null;
        let casouPor = itens ? 'cliente' : null;
        if (!itens && contNome.get(nomeK) === 1 && porNome.get(nomeK)) {
            itens = porNome.get(nomeK);
            casouPor = 'nome';
        }
        let doCliente = (itens || []).filter((i) => !desde || i.data >= desde);
        // Cliente com mais de uma reserva (investidor; no Boulevard são três
        // unidades do mesmo titular): sem separar pela unidade, o recebido dele
        // entrava inteiro em cada uma das reservas.
        const variasUnidades = (Number.isFinite(idSienge) && contCliente.get(idSienge) > 1) || contNome.get(nomeK) > 1;
        if (variasUnidades) {
            const un = normNome(r.unidade);
            doCliente = un ? doCliente.filter((i) => i.unidade && (i.unidade === un || i.unidade.endsWith(` ${un}`) || un.endsWith(` ${i.unidade}`))) : [];
        }
        const rec = separarAto(doCliente);

        const pend = [];
        const offAto = office.atos.get(Number(r.idreserva));
        if (!rec.ato && offAto && offAto.valor > 0) {
            rec.ato = cents(offAto.valor);
            pend.push('ato pago no Office, ainda não lançado no Sienge');
        }
        const offParc = office.parcelas.get(Number(r.idreserva));
        if (offParc && offParc.n > rec.nMensais) {
            const media = offParc.n ? offParc.valor / offParc.n : 0;
            const faltam = offParc.n - rec.nMensais;
            rec.mensais = cents(rec.mensais + media * faltam);
            rec.nMensais = offParc.n;
            pend.push(`${faltam} ${faltam > 1 ? 'parcelas pagas' : 'parcela paga'} no Office, ainda não ${faltam > 1 ? 'lançadas' : 'lançada'} no Sienge`);
        }

        // Contrato antigo de vertical: o Sienge baixa como "Entrega de Chaves" o
        // que o CV registrou como Financiamento, e o recebido passa do recurso
        // próprio. Não dá para separar com segurança, então a linha avisa.
        if (c.recursoProprio > 0 && rec.ato + rec.mensais > c.recursoProprio * 1.02) {
            pend.push('recebido passa do recurso próprio: o Sienge pode estar baixando como parcela o que o CV registrou como financiamento');
        }

        return {
            id: Number(r.idreserva),
            pc: r.idprecadastro ? Number(r.idprecadastro) : null,
            nome: r.titular_nome || '(sem titular)',
            situacao: r.situacao,
            dataReserva: r.data_reserva,
            unidade: r.unidade,
            etapa: r.etapa,
            idetapa: r.idetapa ? Number(r.idetapa) : null,
            area: num(r.area_terreno) || num(r.area_privativa) || null,
            corretor: r.corretor,
            imobiliaria: r.imobiliaria,
            renda,
            rendaFonte: num(r.renda_precadastro) ? 'precadastro' : (renda ? 'reserva' : null),
            venda: c.venda,
            financiamento: c.financiamento,
            fgts: c.fgts,
            federal: c.federal,
            estadual: c.estadual,
            desconto: c.desconto,
            ato: c.ato,
            parcelas: c.parcelas,
            outrasParcelas: c.outrasParcelas,
            recursoProprio: c.recursoProprio,
            nParcelas: c.nMensais,
            parcela: c.parcelaMensal,
            pctRenda: pct,
            recebidoAto: rec.ato,
            recebidoMensais: rec.mensais,
            nRecebidas: rec.nMensais,
            recebidoPorCondicao: rec.porCondicao || {},
            ultimoRecebimento: rec.ultimo,
            casouPor: variasUnidades && casouPor ? `${casouPor}+unidade` : casouPor,
            pendencias: pend,
            seriesNaoClassificadas: c.naoClassificadas,
            series: c.linhas,
            fiadores: Array.isArray(r.fiadores) ? r.fiadores : [],
            recebimentos: rec.itens || [],
            modulo: regra?.modulo?.nome || null,
            fichaUsada: regra?.ficha || null,
            foraDaRegra: regra ? conferir(c, regra) : [],
            // Limite da renda pela ficha ATUAL do módulo, mesmo em reserva antiga
            // (só pinta a coluna; acusar regra continua só para quem é conferido).
            limiteRendaPct: (fr ? regraDaFicha(fr.maisRecente, r.idetapa)?.limiteRendaPct : null) ?? null,
            nota: r.nota_texto ? { texto: r.nota_texto, tom: r.nota_tom, por: r.nota_por, em: r.nota_em } : null,
        };
    });

    // Limite da renda: só o da ficha (por módulo). Sem limite na ficha, não há
    // régua: a % aparece neutra, sem cor e sem acusar regra.
    const brlR = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    for (const l of linhas) {
        if (l.limiteRendaPct == null) {
            l.nivelRenda = 'ok';
            l.rendaComFiador = false;
            continue;
        }
        const daFicha = !!l.fichaUsada;
        const lim = l.limiteRendaPct / 100;
        const tol = config.tolerancia_renda_pct / 100;
        l.nivelRenda = l.pctRenda > lim + tol ? 'alto' : l.pctRenda > lim ? 'atencao' : 'ok';
        // O limite da renda É regra da ficha: passou dele, está fora da regra,
        // mesmo que pouco (a tolerância só decide amarelo x vermelho). Ficava
        // só no cartão "Acima de 30%" e a Viviane, com 63%, saía "dentro da
        // regra" (01/10/2026). Sem ficha, o limite configurado não acusa regra.
        // A ficha costuma permitir passar do limite COM FIADOR ("acima disso com
        // fiador limitando a renda do fiador a 30%", Ingá). O CV registra quem é
        // o fiador (associado "Fiador 1/2") mas não a renda dele: com fiador a
        // reserva sai de "fora da regra" e fica marcada para conferir a renda.
        l.rendaComFiador = l.nivelRenda !== 'ok' && l.fiadores.length > 0;
        if (daFicha && l.nivelRenda !== 'ok' && !l.rendaComFiador) {
            const p = (l.pctRenda * 100).toFixed(1).replace('.', ',');
            l.foraDaRegra.push({
                codigo: 'renda',
                texto: `Parcela de ${brlR(l.parcela)} é ${p}% da renda (${brlR(l.renda)}), a ficha permite até ${String(l.limiteRendaPct).replace('.', ',')}%`,
            });
        }
    }

    // Quadro do topo: a ficha mais recente (as regras de hoje). O limite da
    // renda costuma estar no módulo, não na ficha: vale o primeiro que disser.
    const atual = fr?.maisRecente || null;
    const autorizada = fr?.fichas.find((f) => f.status === 'approved' || f.status === 'closed') || null;
    const regraBase = atual ? regrasDoModulo(atual, null) : null;
    let modulosAtual = (atual?.modulos || []).map((m) => regrasDoModulo(atual, m));
    // Com módulo escolhido, o quadro de regras mostra só ele (com vários
    // módulos o quadro ficava enorme - Adhara, 02/10/2026).
    if (idetapa && modulosAtual.length) {
        const so = modulosAtual.filter((m) => Number(m.modulo?.idetapa) === idetapa);
        modulosAtual = so.length ? so : (modulosAtual.length === 1 ? modulosAtual : []);
    }
    const limiteFicha = idetapa
        ? (modulosAtual[0]?.limiteRendaPct ?? regraBase?.limiteRendaPct ?? null)
        : (regraBase?.limiteRendaPct ?? modulosAtual.map((m) => m.limiteRendaPct).find((v) => v != null) ?? null);
    const nome = await nomeAtual(idemp).catch(() => null);
    // Estoque pelo MESMO núcleo do espelho, da ficha e da projeção: bloqueada
    // por estratégia comercial conta como à venda (unitStockService).
    const u = await (idetapa ? estoqueDaEtapa(idetapa) : summarizeUnitsFromDb(idemp)).catch((e) => {
        console.warn('[recurso-proprio] estoque:', e.message);
        return null;
    });
    const estoque = u && u.totalUnits ? {
        total: u.totalUnits,
        vendidas: u.soldUnits,
        reservadas: u.reservedUnits,
        disponiveis: u.availableUnits,
        bloqueadasComercial: u.commercialStockUnits,
        bloqueadasOutras: Math.max(0, u.blockedUnits - u.commercialStockUnits),
        aVenda: u.availableForSale,
    } : null;
    return {
        modulos,
        idetapa,
        estoque,
        empreendimento: { id: idemp, nome: nome || `Empreendimento ${idemp}` },
        geradoEm: new Date().toISOString(),
        ficha: atual ? {
            id: atual.id,
            mes: diaDe(atual.reference_month),
            status: atual.status,
            ultimaAutorizada: autorizada ? { id: autorizada.id, mes: diaDe(autorizada.reference_month) } : null,
            confereDesde: fr.primeiroMes,
            regras: regraBase,
            modulos: modulosAtual,
        } : null,
        limites: {
            rendaPct: limiteFicha,
            rendaOrigem: limiteFicha != null ? 'ficha' : null,
            toleranciaPct: config.tolerancia_renda_pct,
        },
        recebido,
        excluidas,
        linhas,
    };
}

// ── Observação por reserva ───────────────────────────────────────────────────

export async function salvarNota(user, idreservaRaw, { texto, tom } = {}) {
    const idreserva = parseInt(idreservaRaw, 10);
    if (!Number.isFinite(idreserva)) throw erro(400, 'Reserva inválida.');
    const [r] = await sequelize.query(
        `SELECT idempreendimento_cv FROM reservas WHERE idreserva = :idreserva`,
        { ...Q, replacements: { idreserva } });
    if (!r) throw erro(404, 'Reserva não encontrada.');
    await exigirEmpreendimento(user, r.idempreendimento_cv);

    const t = String(texto ?? '').trim().slice(0, 1000);
    if (!t) {
        await sequelize.query(`DELETE FROM recurso_proprio_notas WHERE idreserva = :idreserva`, { replacements: { idreserva } });
        return null;
    }
    const tomOk = tom === 'info' ? 'info' : 'alerta';
    const por = user?.name || user?.username || user?.email || null;
    await sequelize.query(
        `INSERT INTO recurso_proprio_notas (idreserva, texto, tom, updated_by, updated_by_name, updated_at)
         VALUES (:idreserva, :t, :tom, :uid, :por, NOW())
         ON CONFLICT (idreserva) DO UPDATE
            SET texto = EXCLUDED.texto, tom = EXCLUDED.tom, updated_by = EXCLUDED.updated_by,
                updated_by_name = EXCLUDED.updated_by_name, updated_at = NOW()`,
        { replacements: { idreserva, t, tom: tomOk, uid: user?.id ?? null, por } });
    return { texto: t, tom: tomOk, por, em: new Date().toISOString() };
}

export default {
    DEFAULTS, getConfig, saveConfig, catalogoSeries, listarEmpreendimentos, getRelatorio, salvarNota,
    lerCondicao, conferir, limiteRendaDoTexto,
};
