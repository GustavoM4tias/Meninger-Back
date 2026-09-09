// lib/atoParcelas.js
//
// Regras PURAS da gestao de parcelas do Ato: derivar o plano a partir das
// condicoes do CV, calcular encargos de atraso e decidir o que fazer com cada
// parcela. Sem banco, sem rede - tudo aqui e testavel com `npm test`.
//
// Por que existe: depois do ato pago, as mensais ("Recurso Proprio Parcelado")
// ficam paradas ate o Financeiro faturar o contrato no Sienge. Medido em
// 05/09/2026: 288 parcelas ja vencidas (R$ 344,9 mil) em 245 reservas sem
// faturamento. O plano de parcelas e o que permite o Office cobrar esse
// intervalo - e PARAR sozinho quando o Sienge assume.
//
// Toda constante deste arquivo e FALLBACK: o valor que vale e o de
// `boleto_settings` (editavel na tela). Ver models/sequelize/boleto/boletoSettings.js.
import { addBusinessDays, _internal as _cal } from './businessCalendar.js';

export const PARCELAS_DEFAULTS = Object.freeze({
    // Series do CV que sao "mensais cobraveis pelo Office": so a 20 (Recurso
    // Proprio Parcelado). PARCELAS MENSAIS (1) e Parcelas Mensais URBAN (37)
    // sairam em 09/09/2026 (Gustavo): nao sao do Office.
    idseries: [20],
    exigirAtoPago: true,
    antecedenciaDias: 10,
    encerrarQuandoFaturado: true,      // Sienge assumiu = venda faturada (financial_institution_date)
    // Etapas do REPASSE no CV em que o plano tambem encerra (Gustavo, 08/09/2026):
    // a partir de "Contrato Emitido CAIXA" (45) vem a confissao de divida, a
    // assinatura e o faturamento - cobrar parcela dai em diante gera pagamento
    // sem a informacao para os contratos. Linha principal do workflow de 45 em
    // diante (ids do CV; a tela lista os nomes).
    encerrarEtapasRepasse: [45, 27, 57, 47, 48, 46, 54, 33, 34, 35, 36],
    // CEP recusado pela Caixa ("CEP SACADO INVALIDO" - o CEP generico da cidade,
    // 86360-000, 14940-000): o boleto sai mesmo assim com o endereco da Menin
    // (o CEP tambem esta no contrato) e a reserva fica com alerta para corrigir
    // o cadastro no CV (Gustavo, 08/09/2026). Endereco configuravel na tela.
    cepContingenciaAtivo: true,
    cepContingencia: { cep: '17500005', endereco: 'Rua São Luiz', numero: '231', complemento: '', bairro: 'Centro', cidade: 'Marília', estado: 'SP' },
    vencidasNaAdesao: 'emitir',        // 'emitir' | 'ignorar'
    // Reemissao de parcela vencida: A PEDIDO (cliente responde SIM ao aviso, ou
    // pela tela), sempre para o proximo dia util. `true` liga a reemissao
    // automatica pela rodada.
    atrasoReemitir: false,
    // Vias novas por parcela = avisos de atraso com oferta de nova via. Acabaram
    // as vias (ou o aviso ficou N dias sem resposta), sai o AVISO FINAL: sem
    // nova via, "procure o seu corretor" (Gustavo, 09/09/2026: "2 avisos, nao 3").
    atrasoMaxReemissoes: 2,
    atrasoCobrarEncargos: true,
    atrasoMultaPct: 2,                 // % sobre o valor, uma vez
    atrasoJurosMesPct: 1,              // % ao mes, pro rata dia
    lembreteDiasAntes: 3,              // 0 desliga
    avisoAtrasoDiasDepois: 1,          // 0 desliga
    avisoFinalSemRespostaDias: 15,     // aviso final quando o aviso de atraso fica N dias sem resposta (0 desliga)
    horaRodada: 9,                     // hora cheia, Brasilia
    maxEmissoesRodada: 0,              // 0 = sem teto: tudo que esta na janela sai no mesmo dia
    loteTamanho: 10,                   // emissoes por lote
    lotePausaMin: 5,                   // pausa entre lotes (min)
});

export const PLANO_STATUS = Object.freeze({
    ATIVO: 'ativo',
    PAUSADO: 'pausado',
    ENCERRADO: 'encerrado',
    CANCELADO: 'cancelado',
});

export const PARCELA_STATUS = Object.freeze({
    PREVISTA: 'prevista',       // ainda nao emitida
    EMITIDA: 'emitida',         // boleto vivo, aguardando pagamento
    VENCIDA: 'vencida',         // boleto venceu e foi baixado; aguarda reemissao/decisao
    PAGA: 'paga',
    TRANSFERIDA: 'transferida', // Sienge faturou: quem cobra agora e o ERP
    CANCELADA: 'cancelada',     // reserva morreu
    ERRO: 'erro',               // ultima emissao falhou; volta a tentar
});

// ── Datas ─────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' de um Date construido por ymdToDate (componentes UTC). */
export function dateToYmd(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Date UTC-meia-noite de um 'YYYY-MM-DD' (aceita Date e ISO com hora). */
export function ymdToDate(v) {
    if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
    const s = String(v ?? '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error(`Data invalida: ${v}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Hoje em 'YYYY-MM-DD' no fuso de Brasilia (o Railway roda em UTC). */
export function hojeYmd(now = new Date(), tz = 'America/Sao_Paulo') {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Soma meses preservando o dia quando existe e presando ao ultimo dia do mes
 * quando nao existe (31/01 + 1 = 28/02 ou 29/02). E assim que o CV e o Sienge
 * geram as mensais (conferido em ecrcparcela: 12/09, 12/10, 12/11...).
 */
export function addMonthsClamp(ymd, meses) {
    const d = ymdToDate(ymd);
    const dia = d.getUTCDate();
    const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + meses, 1));
    const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
    alvo.setUTCDate(Math.min(dia, ultimoDia));
    return dateToYmd(alvo);
}

export function addDays(ymd, dias) {
    const d = ymdToDate(ymd);
    d.setUTCDate(d.getUTCDate() + dias);
    return dateToYmd(d);
}

/** Dias corridos de a ate b (b - a). Negativo quando b e anterior. */
export function diffDays(a, b) {
    return Math.round((ymdToDate(b) - ymdToDate(a)) / 86400000);
}

// ── Derivacao do plano ────────────────────────────────────────────────────────

/**
 * Deriva as parcelas a partir de `condicoes.series[]` da reserva do CV.
 *
 * Cada linha de serie configurada vira `quantidade` parcelas mensais a partir
 * do `vencimento` dela, com `valor` (POR parcela). Linhas da mesma serie sao
 * independentes: o CV manda a mensal em uma linha (59x) e o residuo em outra
 * (1x, anos depois) - as duas entram. A numeracao e unica no plano, em ordem
 * de vencimento, porque e assim que o cliente le ("parcela 3 de 60").
 *
 * @param {Array} series  condicoes.series do CV
 * @param {object} [opts]
 * @param {number[]} [opts.idseries]  series consideradas mensais
 * @returns {Array<{ numero, total, idserie, serie_nome, sigla, idcondicao, vencimento, valor, indice_na_serie }>}
 */
export function derivarParcelas(series, { idseries = PARCELAS_DEFAULTS.idseries } = {}) {
    const alvo = new Set((idseries || []).map(Number));
    // Linhas validas, ordenadas por serie e vencimento: o ORDINAL da linha
    // dentro da serie e a identidade dela. O CV nao manda idcondicao nas
    // mensais, e a linha de 59x e a do residuo (1x, anos depois) sao a mesma
    // serie - sem o ordinal as duas "parcela 1" colidiriam.
    const linhas = (Array.isArray(series) ? series : [])
        .filter(s => alvo.has(Number(s?.idserie)))
        .map(s => ({ s, qtd: Math.max(0, Math.trunc(Number(s.quantidade) || 0)), valor: Number(s.valor) }))
        .filter(l => l.qtd && Number.isFinite(l.valor) && l.valor > 0 && l.s.vencimento)
        .sort((a, b) => (Number(a.s.idserie) - Number(b.s.idserie))
            || String(a.s.vencimento).localeCompare(String(b.s.vencimento)));
    const ordinal = new Map();
    const out = [];
    for (const { s, qtd, valor } of linhas) {
        const idserie = Number(s.idserie);
        const linha = ordinal.get(idserie) || 0;
        ordinal.set(idserie, linha + 1);
        for (let k = 0; k < qtd; k++) {
            out.push({
                idserie,
                linha,
                serie_nome: s.serie || null,
                sigla: s.sigla || null,
                idcondicao: s.idcondicao ?? null,
                indice_na_serie: k + 1,
                vencimento: addMonthsClamp(s.vencimento, k),
                valor: Number(valor.toFixed(2)),
            });
        }
    }
    out.sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : a.idserie - b.idserie));
    const total = out.length;
    return out.map((p, i) => ({ ...p, numero: i + 1, total }));
}

/** Chave estavel de uma parcela derivada, para casar com o que ja esta gravado. */
export function chaveParcela(p) {
    return `${p.idserie}:${Number(p.linha) || 0}:${p.indice_na_serie}`;
}

/**
 * Compara o plano gravado com o derivado agora do CV e diz o que mudou.
 * Parcela ja emitida/paga/vencida NUNCA e alterada aqui (o boleto existe): so
 * aparece em `divergentes` para a tela avisar. Prevista acompanha o CV.
 */
export function diffPlano(gravadas, derivadas) {
    const porChave = new Map(gravadas.map(g => [g.chave || chaveParcela(g), g]));
    const vistas = new Set();
    const novas = [];
    const atualizar = [];
    const divergentes = [];
    for (const d of derivadas) {
        const k = chaveParcela(d);
        vistas.add(k);
        const g = porChave.get(k);
        if (!g) { novas.push(d); continue; }
        const mudou = Number(g.valor).toFixed(2) !== Number(d.valor).toFixed(2)
            || String(g.vencimento).slice(0, 10) !== d.vencimento
            || Number(g.numero) !== d.numero || Number(g.total) !== d.total;
        if (!mudou) continue;
        if (g.status === PARCELA_STATUS.PREVISTA) atualizar.push({ id: g.id, ...d });
        else divergentes.push({ id: g.id, atual: { valor: g.valor, vencimento: g.vencimento }, cv: d });
    }
    const remover = gravadas.filter(g => !vistas.has(g.chave || chaveParcela(g)) && g.status === PARCELA_STATUS.PREVISTA);
    const orfas = gravadas.filter(g => !vistas.has(g.chave || chaveParcela(g)) && g.status !== PARCELA_STATUS.PREVISTA);
    return { novas, atualizar, divergentes, remover, orfas };
}

// ── Encargos ──────────────────────────────────────────────────────────────────

/**
 * Multa (uma vez) + juros ao mes pro rata dia sobre o valor original.
 * `diasAtraso` conta do vencimento ORIGINAL ate hoje; zero ou negativo = sem juros.
 * Arredondamento so no fim, em cada componente, para a soma bater com o boleto.
 */
export function calcularEncargos({ valor, vencimentoOriginal, hoje, multaPct = 0, jurosMesPct = 0 }) {
    const base = Number(valor) || 0;
    const dias = Math.max(0, diffDays(vencimentoOriginal, hoje));
    const multa = dias > 0 ? Number((base * (Number(multaPct) || 0) / 100).toFixed(2)) : 0;
    const juros = dias > 0 ? Number((base * (Number(jurosMesPct) || 0) / 100 * (dias / 30)).toFixed(2)) : 0;
    const total = Number((multa + juros).toFixed(2));
    return { diasAtraso: dias, multa, juros, total, valorCobrado: Number((base + total).toFixed(2)) };
}

// ── Decisoes ──────────────────────────────────────────────────────────────────

/**
 * O que a rodada faz com uma parcela hoje.
 *   'emitir'    prevista (ou erro) e vence em ate `antecedenciaDias` (ou ja venceu)
 *   'reemitir'  vencida, ainda cabe via (ver max) e a politica permite
 *   'aguardar'  nada a fazer hoje
 *   'parar'     vencida e esgotou as reemissoes (fila humana)
 */
export function decidirParcela(parcela, { hoje, antecedenciaDias, atrasoReemitir, atrasoMaxReemissoes }) {
    if (parcela.status === PARCELA_STATUS.PREVISTA || parcela.status === PARCELA_STATUS.ERRO) {
        const faltam = diffDays(hoje, parcela.vencimento);
        return faltam <= antecedenciaDias ? 'emitir' : 'aguardar';
    }
    if (parcela.status === PARCELA_STATUS.VENCIDA) {
        if (!atrasoReemitir) return 'parar';
        // emissoes conta a 1a via; reemissoes = emissoes - 1
        const reemissoesFeitas = Math.max(0, (Number(parcela.emissoes) || 1) - 1);
        return reemissoesFeitas < atrasoMaxReemissoes ? 'reemitir' : 'parar';
    }
    return 'aguardar';
}

/**
 * Classificacao COMPLETA de uma parcela para a rodada diaria: e o que o
 * scheduler usa, com a data de hoje EXPLICITA (o `cfg` de cfgParcelas nao
 * carrega `hoje`; em 08/09/2026 a rodada passou o cfg direto para
 * decidirParcela e caiu em "Data invalida: undefined" na 1a parcela).
 *   'retroativa'  vencimento original antes de `cfg.cobrarAPartirDe` (trabalho manual)
 *   'pulada'      prevista, nunca emitida, ja vencida e politica 'ignorar'
 *   'emitir' | 'reemitir' | 'aguardar' | 'parar'  como decidirParcela
 */
export function classificarParaRodada(parcela, cfg, hoje) {
    if (!hoje) throw new Error('classificarParaRodada exige `hoje` (YYYY-MM-DD).');
    const venc = String(parcela.vencimento).slice(0, 10);
    if (cfg.cobrarAPartirDe && venc < cfg.cobrarAPartirDe) return 'retroativa';
    const decisao = decidirParcela(parcela, { ...cfg, hoje });
    if (decisao === 'aguardar' || decisao === 'parar') return decisao;
    if (parcela.status === PARCELA_STATUS.PREVISTA && (Number(parcela.emissoes) || 0) === 0
        && cfg.vencidasNaAdesao === 'ignorar' && venc < hoje) return 'pulada';
    return decisao;
}

/** Proximo dia util DEPOIS de hoje (feriados nacionais de lib/businessCalendar.js). */
export function proximoDiaUtil(hoje) {
    const d = ymdToDate(hoje);
    const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return _cal.ymd(addBusinessDays(local, 1));
}

/**
 * Vencimento e valor do boleto a emitir para a parcela hoje.
 * - Parcela futura: vencimento e valor originais.
 * - Parcela ja vencida (na adesao ou reemissao): vencimento = PROXIMO DIA UTIL
 *   (padrao fixado em 07/09/2026: sem prazo configuravel, e sempre o mesmo).
 *   Encargos so quando `cobrarEncargos` E a parcela ja teve boleto - e nesta
 *   etapa `cobrarEncargos` e sempre false (multa e juros ficaram para depois).
 */
export function condicaoDeEmissao(parcela, { hoje, cobrarEncargos = false, multaPct = 0, jurosMesPct = 0 }) {
    const venceuAntes = diffDays(hoje, parcela.vencimento) < 0;
    if (!venceuAntes) {
        return { vencimento: parcela.vencimento, valor: Number(parcela.valor), encargos: null, motivo: 'no_prazo' };
    }
    const jaTeveBoleto = (Number(parcela.emissoes) || 0) > 0;
    const encargos = (cobrarEncargos && jaTeveBoleto)
        ? calcularEncargos({ valor: parcela.valor, vencimentoOriginal: parcela.vencimento, hoje, multaPct, jurosMesPct })
        : null;
    return {
        vencimento: proximoDiaUtil(hoje),
        valor: encargos ? encargos.valorCobrado : Number(parcela.valor),
        encargos,
        motivo: jaTeveBoleto ? 'reemissao_atraso' : 'adesao_vencida',
    };
}

/**
 * O Sienge assumiu a cobranca? UM sinal: o contrato foi "faturado como venda"
 * (`contracts.financial_institution_date`), a mesma regra do relatorio de
 * Faturamento. O titulo gerado (`receivable_bill_id`) NAO entra na conta -
 * decisao de 07/09/2026, reafirmada em 08/09 ("o titulo pode ser adiantamento").
 * Contrato cancelado nunca assume.
 */
export function siengeAssumiu(contrato) {
    if (!contrato) return false;
    if (String(contrato.situation || '').toLowerCase() === 'cancelado') return false;
    return !!contrato.financial_institution_date;
}

/** O repasse chegou a uma etapa em que a Caixa ja emitiu o contrato (ou depois)? */
export function repasseAssumiu(repasseSituacaoId, etapas = PARCELAS_DEFAULTS.encerrarEtapasRepasse) {
    const id = Number(repasseSituacaoId);
    if (!Number.isInteger(id) || id <= 0) return false;
    return (Array.isArray(etapas) ? etapas : []).map(Number).includes(id);
}

/**
 * O plano deve encerrar? Qualquer uma das regras basta:
 *   reserva_cancelada         reserva morta no CV
 *   sienge_faturado           venda faturada no Sienge (contracts.financial_institution_date)
 *   repasse_contrato_emitido  repasse do CV em "Contrato Emitido CAIXA" ou etapa posterior
 *                             (configuravel em `encerrarEtapasRepasse`; [] desliga)
 */
export function motivoEncerramento({
    contrato, reservaCancelada, encerrarQuandoFaturado = true, situacaoMorta = false,
    repasseSituacaoId = null, encerrarEtapasRepasse = PARCELAS_DEFAULTS.encerrarEtapasRepasse,
}) {
    if (reservaCancelada || situacaoMorta) return 'reserva_cancelada';
    if (encerrarQuandoFaturado && siengeAssumiu(contrato)) return 'sienge_faturado';
    if (repasseAssumiu(repasseSituacaoId, encerrarEtapasRepasse)) return 'repasse_contrato_emitido';
    return null;
}

/** A Caixa recusou o CEP do sacado? (mensagem do portal Ecobranca) */
export function ehErroDeCep(mensagem) {
    return /CEP\s+(DO\s+)?SACADO\s+INVALIDO|CEP\s+INVALIDO/i.test(String(mensagem || ''));
}

/**
 * Titular com o endereco de contingencia no lugar do proprio (CEP recusado
 * pela Caixa). Nome e documento continuam os do cliente; complemento e limpo.
 */
export function titularComEnderecoContingencia(titular, contingencia = PARCELAS_DEFAULTS.cepContingencia) {
    const c = { ...PARCELAS_DEFAULTS.cepContingencia, ...(contingencia || {}) };
    return {
        ...titular,
        cep: String(c.cep || '').replace(/\D/g, ''),
        endereco: c.endereco, numero: String(c.numero || ''), complemento: c.complemento || '',
        bairro: c.bairro, cidade: c.cidade, estado: c.estado,
    };
}

/** Motivos em que o ERP/contrato passa a cobrar: previstas viram `transferida`, nao `cancelada`. */
export const MOTIVOS_TRANSFERENCIA = ['sienge_faturado', 'repasse_contrato_emitido'];

/** Rotulo "3/60" e texto "parcela 3 de 60" - um lugar so para nao divergir. */
export function rotuloParcela(p) {
    return `${p.numero}/${p.total}`;
}
export function descricaoParcela(p) {
    return `parcela ${p.numero} de ${p.total}`;
}

export default {
    PARCELAS_DEFAULTS, PLANO_STATUS, PARCELA_STATUS,
    dateToYmd, ymdToDate, hojeYmd, addMonthsClamp, addDays, diffDays,
    derivarParcelas, chaveParcela, diffPlano, calcularEncargos,
    decidirParcela, classificarParaRodada, condicaoDeEmissao, proximoDiaUtil, siengeAssumiu, repasseAssumiu, motivoEncerramento, MOTIVOS_TRANSFERENCIA,
    ehErroDeCep, titularComEnderecoContingencia, rotuloParcela, descricaoParcela,
};
