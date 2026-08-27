// services/sienge/envioSiengeWatchService.js
//
// VIGIA DO ENVIO DA VENDA AO ERP.
//
// Uma pergunta só: quais reservas entraram em "Envio Sienge" há mais de N
// minutos e ainda não foram enviadas ao Sienge? Passou do prazo, deu erro - e
// erro se conserta na hora, não daqui a uma semana.
//
// Por que existe: entre junho e agosto de 2026, 13% a 16% das vendas que
// passaram pelo fluxo do ato nunca viraram contrato no Sienge - 28 delas com o
// ato já PAGO - e não havia lugar nenhum que dissesse isso.
//
// ── O RELÓGIO (a parte que é fácil errar) ───────────────────────────────────
//
// O lote do CV roda de 5 em 5 minutos. Medido em 27/08/2026: os envios caem
// todos em minuto múltiplo de 5 (259 de 262) e, contando da ENTRADA na etapa,
// 226 de 238 vendas foram ao ERP em até 5 minutos, com mediana de 2. Por isso
// 30 minutos (~6 rodadas) já significa erro.
//
// A entrada na etapa vem do acionamento do webhook do ato (`boleto_history`),
// que é disparado pelo CV justamente quando a reserva entra em Envio Sienge -
// inclusive quando não há série de ato, caso em que o registro sai como
// `skipped`.
//
// NÃO use `erp_sienge.data_cad` como relógio: ele é a data de CRIAÇÃO da reserva
// (710 de 720 batem com `data_reserva`), não a entrada na etapa. Medir por ele
// dá a impressão de uma fila lenta de ~19 horas, que é o ciclo da venda inteiro,
// e faz o vigia tolerar erro por horas. Ele fica só como último recurso, para
// reserva que nunca acionou o webhook.
//
// O motivo do erro não dá para trazer: o CV nunca preenche
// `reserva_sienge_descricao_problema`, a API não expõe nada de integração (405
// em todos os caminhos) e o painel Gestor está atrás de um desafio Cloudflare.
// A lista aponta a reserva; o diagnóstico é no painel.
//
// O sinal, esse, é confiável: as 89 pendentes de agosto foram conferidas uma a
// uma contra a API do Sienge (`/v1/sales-contracts?externalId=`) e 89 de 89
// estavam mesmo sem contrato.

import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

/** Configuração viva; cria a linha singleton no primeiro uso. */
export async function getSettings() {
    const { EnvioSiengeWatchSettings } = db;
    let s = await EnvioSiengeWatchSettings.findByPk(1);
    if (!s) s = await EnvioSiengeWatchSettings.create({ id: 1 });
    return s;
}

/**
 * As reservas que passaram do prazo em Envio Sienge sem chegar ao ERP.
 *
 * @param {object} [opts]
 * @param {number} [opts.minutos] - sobrepõe o limite das settings, para a tela
 *   experimentar outro corte sem precisar salvar.
 */
export async function listarPendentes(opts = {}) {
    const settings = await getSettings();
    const minutos = Number(opts.minutos ?? settings.minutos_limite ?? 30);
    const idsituacao = String(settings.idsituacao_vigiada ?? 17);

    return db.sequelize.query(`
        WITH entrada AS (
            -- Acionamento do webhook do ato = momento em que o CV colocou a
            -- reserva em Envio Sienge. O mais recente, porque a reserva pode ter
            -- entrado na etapa mais de uma vez.
            SELECT idreserva::int AS idreserva, MAX(created_at) AS entrou_em
            FROM boleto_history
            GROUP BY 1
        )
        SELECT r.idreserva,
               r.empreendimento,
               r.unidade,
               r.titular->>'nome'  AS titular_nome,
               r.data_reserva,
               COALESCE(
                   e.entrou_em,
                   -- Último recurso: reserva que nunca acionou o webhook. É a
                   -- data de criação da reserva, então superestima a espera.
                   (r.erp_sienge->>'data_cad')::timestamp AT TIME ZONE 'America/Sao_Paulo'
               ) AS entrou_em,
               (e.entrou_em IS NULL) AS entrada_estimada,
               round(EXTRACT(EPOCH FROM (NOW() - COALESCE(
                   e.entrou_em,
                   (r.erp_sienge->>'data_cad')::timestamp AT TIME ZONE 'America/Sao_Paulo'
               ))) / 60) AS minutos_esperando,
               EXISTS (
                   SELECT 1 FROM boleto_history h
                   WHERE h.idreserva::int = r.idreserva AND h.payment_status = 'paid' AND h.ignorado = false
               ) OR EXISTS (
                   SELECT 1 FROM userede_link_history u
                   WHERE u.idreserva::int = r.idreserva AND u.payment_status = 'paid' AND u.ignorado = false
               ) AS ato_pago
        FROM reservas r
        LEFT JOIN entrada e ON e.idreserva = r.idreserva
        WHERE r.situacao->>'idsituacao' = :idsituacao
          AND COALESCE(r.erp_sienge->>'enviado', 'N') <> 'S'
          AND COALESCE(
                  e.entrou_em,
                  (r.erp_sienge->>'data_cad')::timestamp AT TIME ZONE 'America/Sao_Paulo'
              ) < NOW() - (:minutos * INTERVAL '1 minute')
        ORDER BY 6 ASC`, {
        replacements: { idsituacao, minutos },
        type: db.Sequelize.QueryTypes.SELECT,
    });
}

/**
 * Olha e avisa. Avisa cada reserva UMA vez: sem isso, rodando de 15 em 15
 * minutos, a mesma pendência viraria aviso a cada quarto de hora.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.notificar=true]
 */
export async function runWatch(opts = {}) {
    const notificar = opts.notificar !== false;
    const settings = await getSettings();
    const pendentes = await listarPendentes();

    const idsAgora = pendentes.map(p => Number(p.idreserva));
    const jaAvisados = (Array.isArray(settings.avisados_ids) ? settings.avisados_ids : []).map(Number);
    const novos = pendentes.filter(p => !jaAvisados.includes(Number(p.idreserva)));
    const comAtoPago = novos.filter(p => p.ato_pago);

    const resumo = {
        pendentes: pendentes.length,
        novos: novos.length,
        com_ato_pago: comAtoPago.length,
        minutos_limite: Number(settings.minutos_limite ?? 30),
    };

    const users = Array.isArray(settings.notify_user_ids)
        ? settings.notify_user_ids.map(Number).filter(Boolean) : [];

    if (notificar && novos.length && users.length) {
        const tempo = (m) => (m >= 120 ? `${Math.round(m / 60)}h` : `${m} min`);
        const linhas = novos.slice(0, 15).map(p =>
            `• Reserva ${p.idreserva} - ${p.empreendimento || '?'} ${p.unidade || ''}`
            + ` (${tempo(Number(p.minutos_esperando))}${p.ato_pago ? ', ATO JÁ PAGO' : ''})`);
        const corpo = [
            `${novos.length} venda(s) em "Envio Sienge" há mais de ${settings.minutos_limite} minutos sem chegar ao Sienge.`,
            'O lote do CV roda de 5 em 5 minutos, então isto é erro, não demora.',
            comAtoPago.length ? `${comAtoPago.length} dela(s) com o ato JÁ PAGO.` : null,
            '',
            ...linhas,
            novos.length > 15 ? `... e mais ${novos.length - 15}.` : null,
            '',
            'Abra a reserva no CV para ver o que o envio apontou, corrija e devolva a etapa para Envio Sienge.',
        ].filter(Boolean).join('\n');

        await NotificationService.notify({
            type: NotificationType.SIENGE_ENVIO_PENDENTE,
            recipients: { users },
            title: comAtoPago.length
                ? `${novos.length} venda(s) travadas para o ERP (${comAtoPago.length} com ato pago)`
                : `${novos.length} venda(s) travadas para o ERP`,
            body: corpo,
            data: { total: pendentes.length, novos: novos.length, comAtoPago: comAtoPago.length, reservas: novos.map(p => p.idreserva) },
            importance: comAtoPago.length ? 8 : 6,
        }).catch(err => console.warn('[ENVIO_SIENGE_WATCH] notify falhou:', err?.message));
        resumo.avisados = novos.length;
    }

    // Só continuam marcadas as que ainda estão pendentes: quem foi para o ERP sai
    // da lista e, se um dia voltar a travar, avisa de novo.
    await settings.update({
        avisados_ids: notificar ? idsAgora : jaAvisados.filter(id => idsAgora.includes(id)),
        last_run_at: new Date(),
        last_run_resumo: resumo,
    });
    console.log(`[ENVIO_SIENGE_WATCH] ${JSON.stringify(resumo)}`);
    return resumo;
}

export default { runWatch, getSettings, listarPendentes };
