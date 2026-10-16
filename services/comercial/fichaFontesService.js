// services/comercial/fichaFontesService.js
//
// O que a ficha comercial MOSTRA sem ninguém digitar. Regra do produto: o CV
// manda; o Office só complementa o que o CV não tem. Cada bloco daqui sai de
// uma fonte que já existe:
//
//   tabela vigente da etapa, preço e fluxo   → cv_enterprise_price_tables (CV)
//   desconto construtora                     → enterprise_unit_adimplencia
//   estoque e espelho                        → montarEspelho (unidades do CV)
//   regra de reservas                        → foto da regra lida no painel do CV
//   avaliação e perfil de quem compra        → cv_precadastros (CV)
//   teto da faixa                            → mcmv_municipios (portaria MCMV)
//   reservas por mês                         → reservas (CV)
//   obra e entrega                           → cv_enterprises (CV)
//
// Cada bloco é isolado: se um falhar, ele volta null e os outros seguem.

import db from '../../models/sequelize/index.js';
import { montarEspelho } from '../../controllers/cv/mirrorDb.js';
import { lerSnapshotRegra, regraParaFicha } from '../cv/cvRegraSnapshotService.js';

const UF = {
    'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM', 'bahia': 'BA', 'ceara': 'CE',
    'distrito federal': 'DF', 'espirito santo': 'ES', 'goias': 'GO', 'maranhao': 'MA', 'mato grosso': 'MT',
    'mato grosso do sul': 'MS', 'minas gerais': 'MG', 'para': 'PA', 'paraiba': 'PB', 'parana': 'PR',
    'pernambuco': 'PE', 'piaui': 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
    'rio grande do sul': 'RS', 'rondonia': 'RO', 'roraima': 'RR', 'santa catarina': 'SC',
    'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
};
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ufDe = (ent) => (ent?.sigla && /^[A-Z]{2}$/.test(ent.sigla) ? ent.sigla : UF[semAcento(ent?.estado)] || null);

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const mediana = (arr) => {
    const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const dataBR = (txt) => {
    const m = String(txt || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}/.test(String(txt || '')) ? String(txt).slice(0, 10) : null);
};

async function isolar(nome, fn) {
    try { return await fn(); }
    catch (err) {
        console.warn(`[Ficha fontes] bloco "${nome}" falhou: ${err.message}`);
        return null;
    }
}

// ── Tipo de produto ──────────────────────────────────────────────────────────

export const TIPOS_PRODUTO = {
    loteamento_mcmv: { rotulo: 'Loteamento MCMV', mcmv: true, pagamento: 'mcmv', espelho: 'lote' },
    vertical_mcmv: { rotulo: 'Vertical MCMV', mcmv: true, pagamento: 'mcmv', espelho: 'torre' },
    vertical_alto_padrao: { rotulo: 'Vertical alto padrão', mcmv: false, pagamento: 'fluxo', espelho: 'torre' },
    lote_urbanizado: { rotulo: 'Lote urbanizado', mcmv: false, pagamento: 'fluxo', espelho: 'lote' },
};

export function tipoProduto(ent, override = null) {
    if (override && TIPOS_PRODUTO[override]) return override;
    const horizontal = /horizontal|loteamento|casa|lote/i.test(ent?.tipo_empreendimento_nome || '');
    const popular = !/luxo|alto|m[eé]dio/i.test(ent?.segmento_nome || '');
    if (horizontal) return popular ? 'loteamento_mcmv' : 'lote_urbanizado';
    return popular ? 'vertical_mcmv' : 'vertical_alto_padrao';
}

// ── Tabela vigente da etapa ──────────────────────────────────────────────────

const unidadesDaTabela = (raw) => {
    const a = Array.isArray(raw?.unidades) ? raw.unidades : [];
    return a.length ? a : (Array.isArray(raw?.metadados?.unidades) ? raw.metadados.unidades : []);
};

/**
 * A tabela que vale para o módulo: aprovada, vigente hoje e com o maior número
 * de unidades da etapa com preço. Sem vigente, a mais recente com unidades da
 * etapa. As tabelas marcadas na ficha (`price_table_ids`) são só desempate.
 */
export async function tabelaDaEtapa(idempreendimento, etapaNome, marcadas = []) {
    const [rows] = await db.sequelize.query(`
        SELECT idtabela, nome, aprovado, data_vigencia_de, data_vigencia_ate, raw
          FROM cv_enterprise_price_tables
         WHERE idempreendimento = :id
         ORDER BY data_vigencia_de DESC NULLS LAST, idtabela DESC
    `, { replacements: { id: Number(idempreendimento) } });
    const hoje = new Date().toISOString().slice(0, 10);
    const alvo = semAcento(etapaNome);
    const marc = new Set((marcadas || []).map(Number));
    const candidatas = rows.map((t) => {
        const us = unidadesDaTabela(t.raw).filter((u) => Number(u.valor_total) > 0);
        const daEtapa = alvo ? us.filter((u) => semAcento(u.etapa) === alvo).length : us.length;
        const de = ymd(t.data_vigencia_de), ate = ymd(t.data_vigencia_ate);
        return {
            idtabela: t.idtabela, nome: t.nome, aprovado: t.aprovado !== false,
            data_vigencia_de: de, data_vigencia_ate: ate,
            vigente: (!de || de <= hoje) && (!ate || ate >= hoje),
            unidades_etapa: daEtapa,
            marcada: marc.has(Number(t.idtabela)),
        };
    }).filter((t) => t.unidades_etapa > 0);
    // Tabela com vigência declarada vence a "sem vigência" (que vale para sempre
    // e costuma ser a de lançamento esquecida ativa); depois, a que cobre mais
    // unidades da etapa, a mais recente e, por último, a marcada na ficha.
    const ordem = (a, b) => (Number(Boolean(b.data_vigencia_de)) - Number(Boolean(a.data_vigencia_de)))
        || (b.unidades_etapa - a.unidades_etapa)
        || String(b.data_vigencia_de || '').localeCompare(String(a.data_vigencia_de || ''))
        || (Number(b.marcada) - Number(a.marcada));
    const vigentes = candidatas.filter((t) => t.vigente && t.aprovado).sort(ordem);
    const escolhida = vigentes[0] || candidatas[0] || null;
    if (!escolhida) return null;
    return { ...escolhida, outras_vigentes: vigentes.slice(1).map((t) => ({ idtabela: t.idtabela, nome: t.nome, data_vigencia_ate: t.data_vigencia_ate })) };
}

// ── Preço e condição padrão ──────────────────────────────────────────────────

function tipoSerie(nome) {
    const n = semAcento(nome);
    if (/subsid/.test(n)) return 'subsidio';
    if (/financ|entrega das chaves|chaves/.test(n)) return 'financiamento';
    if (/semestr/.test(n)) return 'semestrais';
    if (/anua/.test(n)) return 'anuais';
    if (/parcelad|mensa/.test(n)) return 'mensais';
    if (/\bato\b|a vista|sinal|entrada/.test(n)) return 'ato';
    if (/desconto/.test(n)) return 'desconto';
    return 'outras';
}
const ROTULO_SERIE = {
    ato: 'Ato', mensais: 'Parcelado', semestrais: 'Semestrais', anuais: 'Anuais',
    subsidio: 'Subsídio', financiamento: 'Financiamento', desconto: 'Desconto', outras: 'Outras',
};

/** Fluxo de uma unidade a partir das séries da tabela. */
export function fluxoDaUnidade(series = [], valorTabela = null) {
    const linhas = (series || [])
        .map((s) => {
            const valor = num(s.valor) || 0;
            const qtd = num(s.qtd_parcelas) || 1;
            return { tipo: tipoSerie(s.nome), nome: s.nome, qtd, valor: r2(valor), total: r2(valor * qtd), primeiro_vencimento: dataBR(s.data_vencimento) };
        })
        .filter((l) => l.total > 0);
    const total = valorTabela || linhas.reduce((s, l) => s + l.total, 0) || null;
    for (const l of linhas) {
        l.rotulo = ROTULO_SERIE[l.tipo];
        l.pct = total ? r2((l.total / total) * 100) : null;
    }
    const soma = (tipos) => r2(linhas.filter((l) => tipos.includes(l.tipo)).reduce((s, l) => s + l.total, 0));
    const recursoProprio = soma(['ato', 'mensais', 'semestrais', 'anuais', 'outras']);
    return {
        linhas,
        total: r2(total),
        recurso_proprio: recursoProprio,
        recurso_proprio_pct: total ? r2((recursoProprio / total) * 100) : null,
        financiamento: soma(['financiamento']),
        subsidio: soma(['subsidio']),
    };
}

const aVenda = (c) => c.status === 'disponivel' || (c.status === 'bloqueada' && c.estoque_comercial);

function precoEcondicao(espelho, tipo) {
    const cells = espelho.torres.flatMap((t) => t.andares.flatMap((a) => a.unidades));
    const venda = cells.filter((c) => aVenda(c) && c.valor > 0);
    const base = venda.length ? venda : cells.filter((c) => c.valor > 0);
    if (!base.length) return { preco: null, condicao: null };

    // Faixas de preço de venda (já com o desconto construtora): a mais comum
    // primeiro. No loteamento isso separa lote padrão de esquina sem chute.
    const porValor = new Map();
    for (const c of base) {
        const k = r2(c.valor);
        if (!porValor.has(k)) porValor.set(k, { valor: k, valor_tabela: r2(c.valor_cheio), desconto: r2(c.adimplencia_premiada || 0), qtd: 0 });
        porValor.get(k).qtd++;
    }
    const faixas = [...porValor.values()].sort((a, b) => (b.qtd - a.qtd) || (a.valor - b.valor));

    // Por área (tipologia): o que importa no vertical e no lote urbanizado.
    const porArea = new Map();
    for (const c of base) {
        const k = c.area ? r2(c.area) : 0;
        if (!porArea.has(k)) porArea.set(k, { area: k || null, qtd: 0, min: Infinity, max: -Infinity, andares: new Set() });
        const g = porArea.get(k);
        g.qtd++; g.min = Math.min(g.min, c.valor); g.max = Math.max(g.max, c.valor);
        if (c.andar != null) g.andares.add(c.andar);
    }
    const tipologias = [...porArea.values()].sort((a, b) => (a.area || 0) - (b.area || 0)).map((g) => ({
        area: g.area, qtd: g.qtd, min: r2(g.min), max: r2(g.max),
        andar_min: g.andares.size ? Math.min(...g.andares) : null,
        andar_max: g.andares.size ? Math.max(...g.andares) : null,
    }));

    const valores = base.map((c) => c.valor);
    const m2 = base.filter((c) => c.area).map((c) => c.valor / c.area);
    const preco = {
        a_venda: venda.length,
        principal: faixas[0],
        faixas,
        tipologias,
        min: r2(Math.min(...valores)),
        max: r2(Math.max(...valores)),
        mediana: r2(mediana(valores)),
        m2_medio: m2.length ? r2(m2.reduce((s, x) => s + x, 0) / m2.length) : null,
    };

    // Unidade de referência da condição padrão: no MCMV, uma da faixa mais
    // comum; no fluxo (30/70, lote), a de preço mais perto da mediana.
    let ref;
    if (TIPOS_PRODUTO[tipo]?.pagamento === 'mcmv') ref = base.find((c) => r2(c.valor) === faixas[0].valor && c.series?.length);
    else ref = [...base].filter((c) => c.series?.length).sort((a, b) => Math.abs(a.valor - preco.mediana) - Math.abs(b.valor - preco.mediana))[0];
    ref = ref || base.find((c) => c.series?.length) || null;

    const condicao = ref ? {
        unidade: { idunidade: ref.idunidade, nome: ref.nome, torre: ref.torre_nome, andar: ref.andar, area: ref.area },
        valor_tabela: r2(ref.valor_cheio),
        desconto: r2(ref.adimplencia_premiada || 0),
        preco_venda: r2(ref.valor),
        fluxo: fluxoDaUnidade(ref.series, ref.valor_cheio),
    } : null;
    return { preco, condicao };
}

// ── Avaliação, teto e perfil de quem compra (pré-cadastros) ──────────────────

async function tetoMcmv(ent) {
    const uf = ufDe(ent);
    if (!ent?.cidade || !uf) return null;
    const [[row]] = await db.sequelize.query(`
        SELECT vr_faixa2, vr_faixa3, co_periodo
          FROM mcmv_municipios
         WHERE upper(unaccent(no_municipio)) = upper(unaccent(:cidade)) AND sg_uf = :uf
         ORDER BY co_periodo DESC LIMIT 1
    `, { replacements: { cidade: ent.cidade, uf } });
    return row ? { faixa2: num(row.vr_faixa2), faixa3: num(row.vr_faixa3), periodo: row.co_periodo } : null;
}

async function precadastros(idempreendimento, teto) {
    // Avaliação fora de uma faixa plausível é erro de digitação no CV
    // (R$ 235,00 e R$ 99.999.999,99 aparecem). A faixa acompanha o teto.
    const lo = teto ? teto * 0.4 : 60000;
    const hi = teto ? teto * 1.6 : 1500000;
    const [[r]] = await db.sequelize.query(`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE situacao_nome ILIKE 'reprovad%')::int AS reprovados,
               count(*) FILTER (WHERE valor_avaliacao BETWEEN :lo AND :hi)::int AS n_avaliacao,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_avaliacao) FILTER (WHERE valor_avaliacao BETWEEN :lo AND :hi) AS avaliacao,
               min(valor_avaliacao) FILTER (WHERE valor_avaliacao BETWEEN :lo AND :hi) AS avaliacao_min,
               max(valor_avaliacao) FILTER (WHERE valor_avaliacao BETWEEN :lo AND :hi) AS avaliacao_max,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_aprovado) FILTER (WHERE valor_aprovado > 0 AND valor_aprovado < :hi) AS financiamento,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_subsidio) FILTER (WHERE valor_subsidio > 0 AND valor_subsidio < 200000) AS subsidio,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_fgts) FILTER (WHERE valor_fgts > 0 AND valor_fgts < :hi) AS fgts,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_prestacao) FILTER (WHERE valor_prestacao > 0 AND valor_prestacao < 50000) AS prestacao
          FROM cv_precadastros
         WHERE idempreendimento = :id AND data_cad >= NOW() - INTERVAL '90 days'
    `, { replacements: { id: Number(idempreendimento), lo, hi } });
    return {
        dias: 90,
        n: r.n,
        reprovados_pct: r.n ? r2((r.reprovados / r.n) * 100) : null,
        avaliacao: { mediana: num(r.avaliacao), min: num(r.avaliacao_min), max: num(r.avaliacao_max), n: r.n_avaliacao },
        financiamento: r2(num(r.financiamento)),
        subsidio: r2(num(r.subsidio)),
        fgts: r2(num(r.fgts)),
        prestacao: r2(num(r.prestacao)),
    };
}

// ── Reservas por mês da etapa ────────────────────────────────────────────────

async function reservasPorMes(idempreendimento, etapaNome, meses = 6) {
    const [rows] = await db.sequelize.query(`
        SELECT to_char(date_trunc('month', data_reserva AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
               count(*)::int AS feitas,
               count(*) FILTER (WHERE situacao->>'situacao' IN ('Cancelada', 'Vencida', 'Distrato', 'Distratada'))::int AS caidas
          FROM reservas
         WHERE idempreendimento_cv = :id
           AND (CAST(:etapa AS text) IS NULL OR upper(unaccent(etapa)) = upper(unaccent(CAST(:etapa AS text))))
           AND data_reserva >= date_trunc('month', NOW()) - make_interval(months => :meses - 1)
         GROUP BY 1 ORDER BY 1
    `, { replacements: { id: Number(idempreendimento), etapa: etapaNome || null, meses } });
    const porMes = new Map(rows.map((r) => [r.mes, r]));
    const out = [];
    const d = new Date();
    for (let i = meses - 1; i >= 0; i--) {
        const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
        const mes = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
        const r = porMes.get(mes);
        out.push({ mes, feitas: r?.feitas || 0, caidas: r?.caidas || 0, ficaram: (r?.feitas || 0) - (r?.caidas || 0) });
    }
    return out;
}

// ── Montagem ─────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/**
 * Fontes de um módulo da ficha. `modulo` precisa de idetapa, price_table_ids
 * e product_type_override; `idempreendimento` vem da ficha.
 */
export async function montarFontes({ idempreendimento, modulo, semCache = false }) {
    const idemp = Number(idempreendimento);
    if (!idemp) return null;
    const chave = `${idemp}:${modulo?.idetapa || 0}:${modulo?.product_type_override || ''}:${(modulo?.price_table_ids || []).join(',')}`;
    const hit = cache.get(chave);
    if (!semCache && hit && Date.now() - hit.em < CACHE_MS) return hit.dados;

    const [[ent]] = await db.sequelize.query(`
        SELECT idempreendimento, nome, cidade, estado, sigla, bairro, data_entrega, andamento,
               situacao_obra_nome, situacao_comercial_nome, tipo_empreendimento_nome, segmento_nome, matricula, logo
          FROM cv_enterprises WHERE idempreendimento = :id
    `, { replacements: { id: idemp } });
    if (!ent) return null;
    const [[etapa]] = modulo?.idetapa
        ? await db.sequelize.query('SELECT idetapa, nome FROM cv_enterprise_stages WHERE idetapa = :id', { replacements: { id: Number(modulo.idetapa) } })
        : [[null]];

    const tipo = tipoProduto(ent, modulo?.product_type_override);
    const cfgTipo = TIPOS_PRODUTO[tipo];

    const tabela = await isolar('tabela', () => tabelaDaEtapa(idemp, etapa?.nome, modulo?.price_table_ids));
    const espelho = await isolar('espelho', () => montarEspelho(idemp, {
        idetapa: etapa?.idetapa || null, idtabela: tabela?.idtabela || null, precoDaTabela: Boolean(tabela), comReserva: true,
    }));
    const { preco, condicao } = (espelho && (await isolar('preco', () => precoEcondicao(espelho, tipo)))) || {};
    const teto = cfgTipo.mcmv ? await isolar('teto', () => tetoMcmv(ent)) : null;
    const compradores = cfgTipo.mcmv ? await isolar('precadastros', () => precadastros(idemp, teto?.faixa2)) : null;

    // Faixa MCMV pela avaliação: até o teto da Faixa 2 é Faixa 2; acima, Faixa 3.
    let avaliacao = null;
    if (cfgTipo.mcmv && compradores?.avaliacao?.mediana) {
        const a = compradores.avaliacao.mediana;
        const faixa = teto?.faixa2 && a <= teto.faixa2 ? 2 : (teto?.faixa3 && a <= teto.faixa3 ? 3 : null);
        avaliacao = { ...compradores.avaliacao, faixa, teto: faixa === 2 ? teto.faixa2 : (faixa === 3 ? teto.faixa3 : null), teto_periodo: teto?.periodo || null };
    }

    const dados = {
        gerado_em: new Date().toISOString(),
        empreendimento: {
            idempreendimento: ent.idempreendimento, nome: ent.nome, cidade: ent.cidade, uf: ufDe(ent), bairro: ent.bairro,
            matricula: ent.matricula, logo: ent.logo, segmento: ent.segmento_nome, tipo_cv: ent.tipo_empreendimento_nome,
        },
        etapa: etapa ? { idetapa: etapa.idetapa, nome: etapa.nome } : null,
        tipo_produto: { chave: tipo, ...cfgTipo, automatico: !modulo?.product_type_override },
        tabela,
        preco,
        condicao,
        regra_cv: await isolar('regra', async () => regraParaFicha(await lerSnapshotRegra(idemp))),
        avaliacao,
        compradores: compradores ? { ...compradores, avaliacao: undefined } : null,
        estoque: espelho ? {
            modo: espelho.modo,
            resumo: espelho.resumo,
            torres: espelho.torres,
        } : null,
        reservas_mes: await isolar('reservas', () => reservasPorMes(idemp, etapa?.nome)),
        obra: {
            entrega: dataBR(ent.data_entrega),
            andamento: num(ent.andamento),
            situacao_obra: ent.situacao_obra_nome || null,
            situacao_comercial: ent.situacao_comercial_nome || null,
        },
    };
    cache.set(chave, { em: Date.now(), dados });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return dados;
}

export function limparCacheFontes() { cache.clear(); }

export default { montarFontes, tipoProduto, tabelaDaEtapa, fluxoDaUnidade, TIPOS_PRODUTO, limparCacheFontes };
