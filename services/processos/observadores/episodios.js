// services/processos/observadores/episodios.js
//
// DETECÇÃO DE EPISÓDIOS. Módulo PURO: sem banco, sem rede, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE O MOTOR OBSERVA, E POR QUE NÃO É "O ESTADO"
//
// A tentação é observar situação: "este lead está parado". Não serve, por duas
// razões, e as duas doem:
//
//   1. NÃO SE APRENDE NADA COM ISSO. "Está parado" não tem desfecho. O que
//      ensina é o EPISÓDIO FECHADO: ficou parado 6 dias, foi redistribuído,
//      e aí converteu. Aí existe causa, ação e resultado - as três coisas que
//      fazem uma regra.
//
//   2. INFLA A EVIDÊNCIA E QUEBRA O PORTÃO. O coletor roda todo dia. Um lead
//      parado observado a cada rodada vira 30 observações em um mês, e UM caso
//      passaria sozinho pelo mínimo de 5 evidências - o motor proporia uma
//      regra da empresa a partir de um lead só, exatamente o que a trava de
//      largura existe para impedir.
//
// Por isso aqui se detecta EPISÓDIO FECHADO, e cada episódio tem uma chave
// estável (`caso_ref`) que o torna idempotente: observado uma vez, nunca mais.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE MÓDULO NÃO FAZ
//
// Não decide se o episódio é bom ou ruim, e não escreve regra. Ele extrai FATO
// com desfecho. Quem transforma fato repetido em regra candidata é a mineração
// (services/processos/mineracao.js), e quem transforma candidata em regra é uma
// pessoa na tela.

const DIA = 86400000;

export const PADROES = {
    lead_parado_dias: 3,
    reserva_etapa_dias: 7,
    repasse_atraso_dias: 5,
    // Episódio velho não entra: o processo de seis meses atrás pode não ser o
    // de hoje, e aprender com ele é aprender a empresa que a gente era.
    janela_dias: 90,
};

const dias = (a, b) => (!a || !b) ? null : Math.floor((new Date(b) - new Date(a)) / DIA);
const data = (v) => { const d = v ? new Date(v) : null; return (d && !Number.isNaN(d.getTime())) ? d : null; };
const iso = (d) => d ? new Date(d).toISOString().slice(0, 10) : 'sd';

/** Faixa de dias em rótulo. Regra não se escreve com "6,4 dias". */
export function faixaDeDias(n) {
    if (n == null) return 'sem data';
    if (n <= 1) return 'no mesmo dia';
    if (n <= 3) return 'em até 3 dias';
    if (n <= 7) return 'em até 1 semana';
    if (n <= 15) return 'em até 15 dias';
    if (n <= 30) return 'em até 1 mês';
    return 'em mais de 1 mês';
}

/**
 * Um lead que ficou parado e DESTRAVOU. O episódio é o destrave.
 *
 * @param {{id, criado_em, ultimo_contato_em, destravado_em, situacao, situacao_anterior,
 *          corretor, redistribuido, escopo}} lead   já normalizado pelo coletor
 */
export function episodioDeLead(lead = {}, { cfg = {}, agora = new Date() } = {}) {
    const c = { ...PADROES, ...cfg };
    const destrave = data(lead.destravado_em);
    if (!destrave) return null;                       // ainda aberto: não ensina
    if (dias(destrave, agora) > c.janela_dias) return null;

    const inicio = data(lead.ultimo_contato_em) || data(lead.criado_em);
    if (!inicio) return null;

    const parado = dias(inicio, destrave);
    if (parado == null || parado < c.lead_parado_dias) return null;   // nunca travou

    // O QUE destravou é a informação que vira regra. Sem isso o episódio
    // conta que algo aconteceu sem dizer o quê, e nenhuma regra sai daí.
    const comoDestravou = lead.redistribuido ? 'redistribuicao'
        : (lead.situacao && lead.situacao !== lead.situacao_anterior) ? 'mudanca_de_situacao'
            : 'contato_do_corretor';

    return {
        caso_tipo: 'lead',
        // Chave estável: o mesmo destrave nunca é observado duas vezes.
        caso_ref: `${lead.id}:destrave:${iso(destrave)}`,
        ...lead.escopo,
        visto: {
            dias_parado: parado,
            faixa: faixaDeDias(parado),
            como_destravou: comoDestravou,
            situacao_final: lead.situacao || null,
            teve_reserva: !!lead.teve_reserva,
        },
        acao: `Lead ficou ${parado} dia(s) sem contato e destravou por ${comoDestravou.replace(/_/g, ' ')}.`,
        resultado: lead.teve_reserva ? 'converteu' : 'seguiu_no_funil',
        occurred_at: destrave,
    };
}

/**
 * Um lead parado que MORREU. Também é episódio fechado, e ensina tanto quanto
 * o que destravou: saber o que costuma preceder a perda é metade da regra.
 *
 * O marco é a data do descarte, não "hoje" - é o que mantém a idempotência.
 */
export function episodioDeLeadPerdido(lead = {}, { cfg = {}, agora = new Date() } = {}) {
    const c = { ...PADROES, ...cfg };
    const perda = data(lead.perdido_em);
    if (!perda) return null;
    if (dias(perda, agora) > c.janela_dias) return null;

    const inicio = data(lead.ultimo_contato_em) || data(lead.criado_em);
    const parado = dias(inicio, perda);
    if (parado == null || parado < c.lead_parado_dias) return null;

    return {
        caso_tipo: 'lead',
        caso_ref: `${lead.id}:perda:${iso(perda)}`,
        ...lead.escopo,
        visto: {
            dias_parado: parado,
            faixa: faixaDeDias(parado),
            motivo: lead.motivo_perda || null,
            situacao_final: lead.situacao || null,
        },
        acao: `Lead ficou ${parado} dia(s) sem contato e foi encerrado.`,
        resultado: 'perdido',
        occurred_at: perda,
    };
}

/**
 * Uma reserva que ANDOU: saiu de uma etapa e entrou na próxima.
 *
 * O valor está em quanto tempo cada etapa levou. É disso que sai "documentação
 * que passa de 15 dias não vira contrato", que é uma regra acionável, e não
 * "reservas demoram", que não é.
 */
export function episodioDeReserva(reserva = {}, { cfg = {}, agora = new Date() } = {}) {
    const c = { ...PADROES, ...cfg };
    const saida = data(reserva.mudou_em);
    if (!saida) return null;
    if (dias(saida, agora) > c.janela_dias) return null;

    const entrada = data(reserva.entrou_na_etapa_em) || data(reserva.criada_em);
    if (!entrada) return null;

    const duracao = dias(entrada, saida);
    if (duracao == null) return null;

    const virouContrato = !!reserva.data_contrato;
    const caiu = reserva.status_final && /cancel|distrat|desist/i.test(reserva.status_final);

    return {
        caso_tipo: 'reserva',
        caso_ref: `${reserva.id}:etapa:${reserva.etapa_anterior || 'inicio'}:${iso(saida)}`,
        ...reserva.escopo,
        visto: {
            etapa: reserva.etapa_anterior || null,
            proxima_etapa: reserva.etapa || null,
            dias_na_etapa: duracao,
            faixa: faixaDeDias(duracao),
            // O sinal que separa demora normal de demora que custa a venda.
            passou_do_prazo: duracao > c.reserva_etapa_dias,
        },
        acao: `Reserva passou ${duracao} dia(s) na etapa "${reserva.etapa_anterior || 'inicial'}".`,
        resultado: caiu ? 'caiu' : (virouContrato ? 'virou_contrato' : 'seguiu'),
        occurred_at: saida,
    };
}

/**
 * Um repasse que DESTRAVOU. O episódio é o destrave, e o que importa é o par
 * (tipo de pendência, o que destravou) - é ele que vira regra de acionamento.
 */
export function episodioDeRepasse(repasse = {}, { cfg = {}, agora = new Date() } = {}) {
    const c = { ...PADROES, ...cfg };
    const destrave = data(repasse.destravado_em);
    if (!destrave) return null;
    if (dias(destrave, agora) > c.janela_dias) return null;

    const inicio = data(repasse.travou_em);
    if (!inicio) return null;

    const preso = dias(inicio, destrave);
    if (preso == null || preso < c.repasse_atraso_dias) return null;

    // O SLA do próprio repasse vence o padrão do módulo quando existe: é o
    // prazo que a operação acordou para aquele caso, e ignorá-lo faria o motor
    // chamar de atraso o que estava dentro do combinado.
    const prazo = Number(repasse.sla_dias) > 0 ? Number(repasse.sla_dias) : c.repasse_atraso_dias;

    return {
        caso_tipo: 'repasse',
        caso_ref: `${repasse.id}:destrave:${iso(destrave)}`,
        ...repasse.escopo,
        visto: {
            pendencia: repasse.pendencia || repasse.etapa_anterior || null,
            dias_preso: preso,
            faixa: faixaDeDias(preso),
            passou_do_sla: preso > prazo,
            sla_dias: prazo,
            destravou_por: repasse.destravou_por || null,
        },
        acao: `Repasse ficou ${preso} dia(s) preso em "${repasse.pendencia || 'pendência não classificada'}".`,
        resultado: 'destravou',
        occurred_at: destrave,
    };
}

/**
 * Um fechamento de semana de um corretor.
 *
 * DESVIO, não ranking. O episódio só existe quando a semana foge da média do
 * PRÓPRIO corretor, porque comparar todo mundo com o melhor produz um alerta
 * toda semana para a metade do time - e alerta que sempre acende ninguém lê.
 *
 * Sem nome de pessoa no texto: a regra que sair daqui é lida por quem não
 * enxerga aquele time. O `caso_ref` guarda o id, e o id fica na evidência.
 */
export function episodioDePerformance(semana = {}, { cfg = {}, agora = new Date() } = {}) {
    const c = { ...PADROES, ...cfg };
    const fim = data(semana.fim);
    if (!fim) return null;
    if (dias(fim, agora) > c.janela_dias) return null;

    const media = Number(semana.media_propria);
    const atual = Number(semana.conversao);
    if (!Number.isFinite(media) || !Number.isFinite(atual) || media <= 0) return null;

    const desvio = (atual - media) / media;
    // Menos de 30% de variação é ruído de semana curta, feriado, férias.
    if (Math.abs(desvio) < 0.3) return null;

    return {
        caso_tipo: 'corretor_semana',
        caso_ref: `${semana.corretor_id}:semana:${iso(fim)}`,
        ...semana.escopo,
        visto: {
            desvio_pct: Math.round(desvio * 100),
            leads_recebidos: Number(semana.leads) || 0,
            tempo_resposta_h: semana.tempo_resposta_h ?? null,
            // O cruzamento que vira regra: quem responde rápido converte mais?
            respondeu_rapido: semana.tempo_resposta_h != null && semana.tempo_resposta_h <= 2,
        },
        acao: desvio > 0
            ? `Semana ${Math.round(desvio * 100)}% acima da média do próprio corretor.`
            : `Semana ${Math.abs(Math.round(desvio * 100))}% abaixo da média do próprio corretor.`,
        resultado: desvio > 0 ? 'acima' : 'abaixo',
        occurred_at: fim,
    };
}

export default {
    PADROES, faixaDeDias,
    episodioDeLead, episodioDeLeadPerdido, episodioDeReserva,
    episodioDeRepasse, episodioDePerformance,
};
