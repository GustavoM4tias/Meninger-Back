// services/comercial/reconciliacaoService.js
//
// O MAPA DE UNIDADES E AS RESERVAS PRECISAM CONTAR A MESMA HISTÓRIA.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE OS DOIS NUNCA BATIAM
//
// Perguntaram "quantas reservas em Sarandi" e a resposta veio 149, enquanto o
// mapa do CV mostrava 48 unidades reservadas. Os dois estavam certos, e
// mediam coisas diferentes:
//
//   MAPA       ESTOQUE. O estado de cada unidade AGORA.
//   RESERVAS   FLUXO. Os registros criados no período - e a mesma unidade pode
//              ter sido reservada, distratada e reservada de novo.
//
// Comparar os dois totais nunca ia fechar, e ninguém tinha como saber se a
// diferença era normal ou defeito. Esta reconciliação responde isso: ela não
// compara TOTAIS, compara UNIDADE A UNIDADE, e devolve só onde os dois
// discordam - com o nome da divergência.
//
// ─────────────────────────────────────────────────────────────────────────────
// SEMPRE POR ID
//
// A junção é por `idunidade` e o recorte por `cv_id` do empreendimento. Nome
// não entra em lugar nenhum: o CV renomeia ("Park Alameda" virou "Park
// Alameda - Sarandi") e o nome que a reserva guardou é o da época dela.

import db from '../../models/sequelize/index.js';
import { QueryTypes } from 'sequelize';

/** O que cada código do mapa de disponibilidade significa. */
export const SITUACAO_MAPA = {
    1: 'disponivel',
    2: 'reservada',
    3: 'vendida',
    4: 'bloqueada',
    5: 'em_processo',
};

/** Reserva que ainda "ocupa" a unidade. Mesma regra do funil (bucket). */
const RESERVA_VIVA = `
  NOT (
    LOWER(COALESCE(r.situacao->>'nome', r.status_reserva, '')) ~ 'cancelad|distrato|reprovad|negad|vencid'
    OR LOWER(COALESCE(r.status_repasse, '')) ~ 'cancelad|distrato'
  )
`;

/**
 * O VEREDITO DE UMA UNIDADE. Puro: recebe a linha, devolve o tipo.
 *
 * Quatro divergências, e cada uma é um problema DIFERENTE de operação:
 *
 *   ocupada_sem_reserva   o mapa diz reservada/vendida e não há reserva viva.
 *                         Unidade fora do estoque sem ninguém atrás dela.
 *   reserva_sem_ocupacao  há reserva viva e o mapa diz disponível. A unidade
 *                         pode ser vendida DE NOVO para outra pessoa.
 *   estado_divergente     os dois concordam que está ocupada e discordam de
 *                         COMO (mapa "vendida" x reserva ainda em análise).
 *   duplicada             mais de uma reserva viva na mesma unidade.
 *
 * A ordem importa: `duplicada` é testada primeiro porque uma unidade com duas
 * reservas também casaria com outras regras, e é a mais grave das quatro - ela
 * e a `reserva_sem_ocupacao` terminam do mesmo jeito, com duas pessoas
 * comprando o mesmo apartamento.
 *
 * Bloqueada não gera divergência por falta de reserva: bloquear é justamente
 * tirar a unidade do estoque sem vender.
 */
export function classificarUnidade(linha = {}) {
    const mapa = SITUACAO_MAPA[linha.situacao_mapa] || 'desconhecido';
    const vivas = Number(linha.reservas_vivas) || 0;
    const ocupadaNoMapa = ['reservada', 'vendida', 'em_processo'].includes(mapa);

    if (vivas > 1) {
        return { mapa, vivas, tipo: 'duplicada',
            explicacao: `${vivas} reservas vivas na mesma unidade. Duas pessoas podem estar comprando o mesmo imóvel.` };
    }
    if (ocupadaNoMapa && vivas === 0) {
        return { mapa, vivas, tipo: 'ocupada_sem_reserva',
            explicacao: `O mapa diz "${mapa}" mas não há reserva viva. A unidade está fora do estoque sem ninguém atrás dela.` };
    }
    if (!ocupadaNoMapa && mapa !== 'bloqueada' && vivas === 1) {
        return { mapa, vivas, tipo: 'reserva_sem_ocupacao',
            explicacao: `Há reserva viva (${linha.etapa_reserva || 'sem etapa'}) mas o mapa diz "${mapa}". A unidade pode ser vendida de novo.` };
    }
    if (mapa === 'vendida' && vivas === 1 && linha.tem_vendida === false) {
        return { mapa, vivas, tipo: 'estado_divergente',
            explicacao: `O mapa diz "vendida" e a reserva está em "${linha.etapa_reserva || 'sem etapa'}". Um dos dois está atrasado.` };
    }
    return { mapa, vivas, tipo: null, explicacao: null };
}

/**
 * As divergências entre o mapa e as reservas, unidade a unidade.
 *
 * O recorte é por cv_id e a junção por idunidade. Nome não entra.
 */
export async function reconciliarUnidades(cvId, { limite = 200 } = {}) {
    const id = Number(cvId);
    if (!Number.isFinite(id)) {
        return { erro: 'Informe o id do empreendimento no CV (cv_id).' };
    }

    const linhas = await db.sequelize.query(`
        WITH unidades AS (
            SELECT u.idunidade, u.nome AS unidade, b.nome AS bloco, s.nome AS etapa,
                   u.situacao_mapa_disponibilidade AS situacao_mapa
              FROM cv_enterprise_stages s
              JOIN cv_enterprise_blocks  b ON b.idetapa  = s.idetapa
              JOIN cv_enterprise_units   u ON u.idbloco  = b.idbloco
             WHERE s.idempreendimento = :id
        ),
        vivas AS (
            SELECT
                NULLIF(r.unidade_json->>'idunidade_cv','')::int AS idunidade,
                COUNT(*)                                        AS n,
                MIN(r.idreserva)                                AS idreserva,
                MIN(COALESCE(r.situacao->>'nome', r.status_reserva)) AS etapa_reserva,
                BOOL_OR(r.vendida = 'S')                        AS tem_vendida
              FROM reservas r
             WHERE ${RESERVA_VIVA}
               AND NULLIF(r.unidade_json->>'idunidade_cv','')::int IS NOT NULL
             GROUP BY 1
        )
        SELECT un.idunidade, un.unidade, un.bloco, un.etapa, un.situacao_mapa,
               COALESCE(v.n, 0) AS reservas_vivas,
               v.idreserva, v.etapa_reserva, v.tem_vendida
          FROM unidades un
          LEFT JOIN vivas v ON v.idunidade = un.idunidade
         ORDER BY un.etapa, un.bloco, un.unidade
    `, { replacements: { id }, type: QueryTypes.SELECT });

    if (!linhas.length) {
        return {
            erro: `Nenhuma unidade sincronizada para o empreendimento ${id}. `
                + 'O mapa de disponibilidade precisa ter sido sincronizado do CV.',
        };
    }

    const divergencias = [];
    const resumo = {
        unidades: linhas.length,
        conferem: 0,
        ocupada_sem_reserva: 0,
        reserva_sem_ocupacao: 0,
        estado_divergente: 0,
        duplicada: 0,
    };

    for (const l of linhas) {
        const { tipo, explicacao, mapa, vivas } = classificarUnidade(l);
        if (!tipo) { resumo.conferem++; continue; }

        resumo[tipo]++;
        if (divergencias.length < limite) {
            divergencias.push({
                idunidade: l.idunidade,
                unidade: [l.etapa, l.bloco, l.unidade].filter(Boolean).join(' / '),
                mapa,
                reservas_vivas: vivas,
                idreserva: l.idreserva || null,
                etapa_reserva: l.etapa_reserva || null,
                tipo,
                explicacao,
            });
        }
    }

    const totalDivergente = resumo.unidades - resumo.conferem;
    resumo.taxa_divergencia = resumo.unidades
        ? Math.round((totalDivergente / resumo.unidades) * 1000) / 10
        : 0;

    return {
        cv_id: id,
        resumo,
        divergencias,
        truncado: totalDivergente > divergencias.length,
    };
}

export default { reconciliarUnidades, classificarUnidade, SITUACAO_MAPA };
