// services/cv/cvIntegrationLog.js
//
// O registro de execuções da integração com o CV - a peça que não existia.
//
// Até aqui o único rastro era `cv_sync_state`: uma linha por job, sobrescrita
// a cada rodada. Dava para responder "a última execução deu certo?" e nada
// mais. Nem "quantas vezes falhou hoje", nem "o CV entregou o evento desta
// reserva", nem "o webhook chegou antes ou depois do cron" - que é exatamente
// a comparação que decide se o cron pode virar só validador.
//
// Vale para TODAS as funcionalidades e para as três origens (cron, webhook,
// manual), de propósito: um histórico que só cobrisse o webhook deixaria a
// metade antiga da integração no escuro, e a pergunta interessante é sempre a
// comparação entre as duas.
//
// Regras que este módulo se impõe:
//   - NUNCA estoura. Registro é observação; derrubar um sync porque o log
//     falhou seria trocar um problema pequeno por um grande.
//   - Corpo do webhook é gravado como veio, mas com teto de tamanho: payload
//     de origem externa não pode encher a tabela.
//   - A retenção é configurável na tela (cv_panel_settings), com o código
//     servindo só de fallback.

import db from '../../models/sequelize/index.js';

const RETENCAO_PADRAO_DIAS = 30;

// Teto do corpo gravado. O payload serve para descobrir o formato do CV e
// auditar um caso, não para ser um arquivo morto: 16 kB cobre qualquer evento
// real com folga e impede que um corpo anômalo vire um problema de disco.
const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Número positivo ou null. `null`/`undefined`/'' nunca viram 0. */
function numeroOuNulo(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
}

function payloadEnxuto(corpo) {
    if (corpo === null || corpo === undefined) return null;
    try {
        const texto = JSON.stringify(corpo);
        if (texto.length <= MAX_PAYLOAD_BYTES) return corpo;
        return {
            _truncado: true,
            _tamanho_original: texto.length,
            _amostra: texto.slice(0, MAX_PAYLOAD_BYTES),
        };
    } catch {
        return { _nao_serializavel: true };
    }
}

/**
 * Grava um evento. Não lança e não precisa de await de quem chama - mas o
 * await é preferível quando o processo pode terminar logo em seguida.
 *
 * @param {object} evento
 * @param {'webhook'|'cron'|'manual'} evento.origem
 * @param {string}  evento.funcionalidade  reservas | repasses | leads | ...
 * @param {number} [evento.entidade_id]
 * @param {string}  evento.status          ok | erro | ignorado | duplicado | parcial | escuta
 * @param {string} [evento.mensagem]
 * @param {number} [evento.duracao_ms]
 * @param {object} [evento.payload]        corpo cru, quando houver
 * @param {object} [evento.stats]
 */
export async function registrar(evento) {
    try {
        await db.CvIntegrationEvent.create({
            origem: evento.origem,
            funcionalidade: evento.funcionalidade,
            // Number(null) é 0 e passa no isFinite: sem o descarte explícito,
            // "evento sem id" virava "evento do id 0" no histórico.
            entidade_id: numeroOuNulo(evento.entidade_id),
            status: evento.status,
            mensagem: evento.mensagem ? String(evento.mensagem).slice(0, 4000) : null,
            duracao_ms: Number.isFinite(Number(evento.duracao_ms)) ? Number(evento.duracao_ms) : null,
            payload: payloadEnxuto(evento.payload),
            stats: evento.stats ?? null,
        });
    } catch (err) {
        console.warn('[CV histórico] falha ao registrar evento:', err?.message || err);
    }
}

/** Dias de retenção configurados na tela; o padrão do código é só fallback. */
async function diasDeRetencao() {
    try {
        const s = await db.CvPanelSettings.findByPk(1);
        const dias = Number(s?.historico_eventos_dias);
        return Number.isFinite(dias) && dias > 0 ? dias : RETENCAO_PADRAO_DIAS;
    } catch {
        return RETENCAO_PADRAO_DIAS;
    }
}

/**
 * Poda o histórico. Chamado no boot e no fim de cada rodada de cron, nunca em
 * caminho de webhook - o webhook precisa responder rápido, e uma limpeza no
 * meio dele só adicionaria latência a uma coisa que já vai acontecer sozinha.
 */
export async function podar() {
    try {
        const dias = await diasDeRetencao();
        const [, meta] = await db.sequelize.query(
            `DELETE FROM cv_integration_events WHERE created_at < NOW() - (:dias || ' days')::interval`,
            { replacements: { dias } },
        );
        const n = meta?.rowCount ?? 0;
        if (n) console.log(`[CV histórico] ${n} evento(s) além de ${dias} dia(s) removido(s).`);
        return n;
    } catch (err) {
        console.warn('[CV histórico] falha ao podar:', err?.message || err);
        return 0;
    }
}

/**
 * Últimos eventos, com os filtros que a tela oferece.
 * Devolve `{ eventos, total }` para a tela conseguir paginar.
 */
export async function listar({ funcionalidade, origem, status, entidade_id, limite = 50, offset = 0 } = {}) {
    const where = {};
    if (funcionalidade) where.funcionalidade = funcionalidade;
    if (origem) where.origem = origem;
    if (status) where.status = status;
    const idFiltro = numeroOuNulo(entidade_id);
    if (idFiltro !== null) where.entidade_id = idFiltro;

    const { rows, count } = await db.CvIntegrationEvent.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: Math.min(Math.max(Number(limite) || 50, 1), 200),
        offset: Math.max(Number(offset) || 0, 0),
    });
    return { eventos: rows, total: count };
}

/**
 * Resumo das últimas 24h por funcionalidade e origem. É o número que responde
 * "o webhook está entregando?" sem precisar ler o histórico linha a linha.
 */
export async function resumo() {
    try {
        return await db.sequelize.query(`
            SELECT funcionalidade, origem,
                   COUNT(*)                                    AS total,
                   COUNT(*) FILTER (WHERE status = 'erro')     AS erros,
                   COUNT(*) FILTER (WHERE status = 'ignorado') AS ignorados,
                   MAX(created_at)                             AS ultimo
              FROM cv_integration_events
             WHERE created_at > NOW() - INTERVAL '24 hours'
             GROUP BY funcionalidade, origem
             ORDER BY funcionalidade, origem
        `, { type: db.Sequelize.QueryTypes.SELECT });
    } catch (err) {
        console.warn('[CV histórico] falha ao resumir:', err?.message || err);
        return [];
    }
}

export default { registrar, podar, listar, resumo };
