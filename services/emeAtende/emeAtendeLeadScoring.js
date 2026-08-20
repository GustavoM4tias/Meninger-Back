// services/emeAtende/emeAtendeLeadScoring.js
//
// Gestão de lead da Eme Atende: temperatura, estágio, chance de venda, motivo de
// perda e política de recontato.
//
// ── A regra que sustenta tudo ────────────────────────────────────────────────
// A IA REGISTRA O QUE O LEAD DECLAROU. Quem JULGA é este arquivo.
//
// Ela nunca escreve "lead tem perfil", "chance alta" ou "não passa no crédito":
// ela grava "o lead disse que tem restrição no nome" e o cálculo acontece aqui,
// em código auditável, com peso que dá pra explicar e mudar. É a mesma postura
// da trava anti-invenção, aplicada ao CRM: modelo de linguagem coleta, sistema
// conclui. Sem isso a temperatura viraria opinião do Gemini naquele dia.
//
// ── De onde vem o desenho ────────────────────────────────────────────────────
// Base BANT (orçamento, decisão, necessidade, prazo) adaptada ao funil de
// incorporadora, mais os impeditivos específicos do Minha Casa Minha Vida, que
// são o que realmente derruba venda nesse público: restrição no nome, renda
// fora da faixa, já possuir imóvel e financiamento ativo. Temperatura com
// decaimento por tempo (lead esfria sozinho) é padrão de CRM; motivo de perda
// com política de recontato é o que separa "perdido" de "perdido para sempre".

// ── Vocabulário (o que a IA pode registrar) ─────────────────────────────────
export const MOMENTO_COMPRA = ['imediato', 'ate_3_meses', 'ate_6_meses', 'ate_12_meses', 'sem_prazo', 'nao_informado'];
export const FINALIDADE = ['moradia', 'investimento', 'familiar', 'nao_informado'];
export const APROVACAO_CREDITO = ['aprovada', 'pre_aprovada', 'em_analise', 'nao_iniciada', 'reprovada', 'nao_informado'];
export const SIM_NAO = ['sim', 'nao', 'nao_informado'];

/**
 * Motivo de perda + política de recontato.
 *
 * `reconversao` responde "vale voltar nesse lead?" e `dias` diz quando. O ponto
 * não óbvio: restrição no nome é o motivo com MAIOR chance de reconversão, não
 * a menor - nome limpa. Quem já comprou ou pediu opt-out não volta nunca.
 */
export const MOTIVOS_PERDA = {
    sem_interesse:      { rotulo: 'Sem interesse',                    reconversao: 'baixa',  dias: 180 },
    so_pesquisando:     { rotulo: 'Só pesquisando',                   reconversao: 'media',  dias: 90 },
    preco_alto:         { rotulo: 'Achou caro',                       reconversao: 'media',  dias: 120 },
    renda_insuficiente: { rotulo: 'Renda fora da faixa',              reconversao: 'baixa',  dias: 180 },
    restricao_credito:  { rotulo: 'Restrição no nome',                reconversao: 'alta',   dias: 90 },
    aguardando_recurso: { rotulo: 'Juntando entrada / aguardando FGTS', reconversao: 'alta', dias: 90 },
    prazo_entrega:      { rotulo: 'Prazo de entrega longo',           reconversao: 'media',  dias: 120 },
    quer_pronto:        { rotulo: 'Quer imóvel pronto',               reconversao: 'baixa',  dias: 180 },
    localizacao:        { rotulo: 'Localização não serve',            reconversao: 'baixa',  dias: 180 },
    quer_outro_produto: { rotulo: 'Procura outro produto',            reconversao: 'media',  dias: 120 },
    possui_imovel:      { rotulo: 'Já possui imóvel (impeditivo MCMV)', reconversao: 'baixa', dias: 365 },
    ja_comprou:         { rotulo: 'Já comprou em outro lugar',        reconversao: 'nula',   dias: null },
    contato_invalido:   { rotulo: 'Contato inválido',                 reconversao: 'nula',   dias: null },
    nao_responde:       { rotulo: 'Parou de responder',               reconversao: 'media',  dias: 30 },
    opt_out:            { rotulo: 'Pediu para não receber mais',      reconversao: 'nula',   dias: null },
    outro:              { rotulo: 'Outro',                            reconversao: 'media',  dias: 120 },
};

// Etapas do funil que a Eme enxerga. O que vem depois (proposta, contrato) é do
// consultor e não passa por aqui - inventar etapa que ninguém alimenta só cria
// relatório mentiroso.
export const ESTAGIOS = ['novo', 'contatado', 'engajado', 'qualificado', 'visita', 'repassado', 'perdido', 'opt_out'];

/**
 * Pesos do score. Somados e limitados a 0-100.
 *
 * Negativo existe de propósito: restrição declarada e imóvel próprio derrubam o
 * lead abaixo do neutro porque são impeditivos reais do programa, não detalhes.
 */
export const PESOS = {
    momento: { imediato: 25, ate_3_meses: 20, ate_6_meses: 12, ate_12_meses: 6, sem_prazo: 0, nao_informado: 0 },
    aprovacao: { aprovada: 25, pre_aprovada: 18, em_analise: 10, nao_iniciada: 3, reprovada: -20, nao_informado: 0 },
    restricao: { nao: 10, sim: -15, nao_informado: 0 },
    possui_imovel: { nao: 5, sim: -20, nao_informado: 0 },
    entrada: { sim: 8, nao: 0, nao_informado: 0 },
    fgts: { sim: 7, nao: 0, nao_informado: 0 },
    // Sinais de comportamento na conversa - o que a pessoa FEZ, não o que disse.
    pediu_material: 5,
    pediu_visita: 12,
    visita_agendada: 20,
    respondeu_varias: 5,   // 4+ mensagens do lead na conversa
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * Score 0-100 a partir do que foi declarado + comportamento.
 * @param {object} q qualificação declarada
 * @param {object} sinais { pediu_material, pediu_visita, visita_agendada, mensagens_lead }
 */
export function calcularScore(q = {}, sinais = {}) {
    let s = 0;
    s += PESOS.momento[q.momento_compra] ?? 0;
    s += PESOS.aprovacao[q.aprovacao_credito] ?? 0;
    s += PESOS.restricao[q.restricao_nome] ?? 0;
    s += PESOS.possui_imovel[q.possui_imovel] ?? 0;
    s += PESOS.entrada[q.entrada_disponivel] ?? 0;
    s += PESOS.fgts[q.usa_fgts] ?? 0;

    if (sinais.pediu_material) s += PESOS.pediu_material;
    if (sinais.pediu_visita) s += PESOS.pediu_visita;
    if (sinais.visita_agendada) s += PESOS.visita_agendada;
    if ((sinais.mensagens_lead || 0) >= 4) s += PESOS.respondeu_varias;

    return clamp(Math.round(s), 0, 100);
}

/**
 * Temperatura = score COM decaimento por tempo sem falar.
 *
 * Lead esfria sozinho: sem isso um "quente" de março continuaria quente em
 * agosto e a lista de prioridade viraria ficção.
 */
export function calcularTemperatura(score, ultimaInteracaoEm = null, agora = null) {
    const base = score >= 65 ? 3 : score >= 40 ? 2 : score >= 20 ? 1 : 0;
    let nivel = base;

    if (ultimaInteracaoEm) {
        const dias = Math.floor((( agora ? agora.getTime() : Date.now()) - new Date(ultimaInteracaoEm).getTime()) / 86400000);
        if (dias > 30) nivel -= 2;
        else if (dias > 7) nivel -= 1;
    }
    return ['gelado', 'frio', 'morno', 'quente'][clamp(nivel, 0, 3)];
}

/**
 * Chance de venda, em faixa. Deliberadamente NÃO é porcentagem: seria número
 * inventado, e número inventado vira meta. Faixa comunica ordem de grandeza sem
 * fingir precisão que não existe.
 */
export function calcularChance(score, estagio) {
    if (estagio === 'perdido' || estagio === 'opt_out') return 'nula';
    if (estagio === 'visita' || estagio === 'repassado') return score >= 40 ? 'alta' : 'media';
    if (score >= 65) return 'alta';
    if (score >= 40) return 'media';
    if (score >= 20) return 'baixa';
    return 'muito_baixa';
}

/** Política de recontato a partir do motivo de perda. */
export function politicaRecontato(motivo, agora = null) {
    const m = MOTIVOS_PERDA[motivo] || MOTIVOS_PERDA.outro;
    if (!m.dias) return { reconversao: m.reconversao, recontatar_em: null };
    const base = agora ? new Date(agora) : new Date();
    base.setDate(base.getDate() + m.dias);
    return { reconversao: m.reconversao, recontatar_em: base };
}

/** Avanço de estágio: nunca volta atrás sozinho. */
export function avancarEstagio(atual, novo) {
    const ordem = ESTAGIOS.indexOf(atual) < 0 ? 0 : ESTAGIOS.indexOf(atual);
    const alvo = ESTAGIOS.indexOf(novo);
    if (alvo < 0) return atual;
    // perdido e opt_out são finais e podem vir de qualquer lugar
    if (novo === 'perdido' || novo === 'opt_out') return novo;
    if (atual === 'perdido' || atual === 'opt_out') return atual;
    return alvo > ordem ? novo : atual;
}

/** Recalcula os derivados de um lead. Chamado a cada mudança relevante. */
export function recalcular(lead, sinais = {}) {
    const q = lead.qualificacao || {};
    const score = calcularScore(q, sinais);
    const temperatura = calcularTemperatura(score, lead.ultima_interacao_em);
    const chance = calcularChance(score, lead.estagio);
    return { score, temperatura, chance };
}

export default {
    MOMENTO_COMPRA, FINALIDADE, APROVACAO_CREDITO, SIM_NAO, MOTIVOS_PERDA, ESTAGIOS, PESOS,
    calcularScore, calcularTemperatura, calcularChance, politicaRecontato, avancarEstagio, recalcular,
};
