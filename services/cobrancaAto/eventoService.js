// services/cobrancaAto/eventoService.js
//
// Timeline unificada da cobrança do Ato.
//
// Grava no lugar certo conforme a forma e LÊ as duas juntas, ordenadas por
// tempo - que é como a operação enxerga: "o que aconteceu com a cobrança desta
// reserva", sem se importar se foi boleto ou cartão. Quando a condição muda e a
// forma troca, os eventos das duas aparecem na mesma linha do tempo.
//
// Best-effort na escrita, igual ao BoletoEventLogger: registrar evento nunca
// pode derrubar uma emissão.
import db from '../../models/sequelize/index.js';
import BoletoEventLogger from '../boleto/BoletoEventLogger.js';

/**
 * Registra um evento.
 *
 * @param {object} p
 * @param {'boleto'|'cartao'} p.forma
 * @param {number} p.historyId  id na tabela da forma
 * @param {number} p.idreserva
 * @param {string} p.type
 * @param {string} [p.message]
 * @param {'info'|'warning'|'error'|'success'} [p.severity]
 * @param {object} [p.data]
 */
export async function registrar({ forma, historyId, idreserva, type, message = null, severity = 'info', data = null }) {
    if (forma === 'boleto') {
        return BoletoEventLogger.log({ historyId, idreserva, type, message, severity, data });
    }
    if (!type || !historyId) {
        console.warn(`[ATO_EVENTO] registrar(${type}) sem ids — pulando.`);
        return null;
    }
    try {
        // idreserva é obrigatório na tabela; recupera do histórico se não veio.
        if (!idreserva) {
            const reg = await db.UseredeLinkHistory.findByPk(historyId, { attributes: ['idreserva'] });
            idreserva = reg?.idreserva;
        }
        if (!idreserva) return null;
        return await db.UseredeLinkEvent.create({
            link_history_id: historyId, idreserva, type, severity, message, data,
        });
    } catch (err) {
        console.warn(`[ATO_EVENTO] Falha ao gravar "${type}": ${err.message}`);
        return null;
    }
}

/** Formato comum, para a tela não precisar saber de qual tabela veio. */
function normalizar(linha, forma) {
    return {
        id: `${forma}:${linha.id}`,
        forma,
        historyId: forma === 'boleto' ? linha.boleto_history_id : linha.link_history_id,
        idreserva: linha.idreserva,
        type: linha.type,
        severity: linha.severity,
        message: linha.message,
        data: linha.data,
        created_at: linha.created_at,
    };
}

/**
 * Todos os eventos da reserva, das DUAS formas, em ordem cronológica.
 * É a visão que o modal usa: a história completa da cobrança daquele ato.
 */
export async function listarPorReserva(idreserva, { limit = 500 } = {}) {
    const [boleto, cartao] = await Promise.all([
        db.BoletoEvent.findAll({
            where: { idreserva }, order: [['created_at', 'ASC'], ['id', 'ASC']], limit, raw: true,
        }).catch(() => []),
        db.UseredeLinkEvent.findAll({
            where: { idreserva }, order: [['created_at', 'ASC'], ['id', 'ASC']], limit, raw: true,
        }).catch(() => []),
    ]);

    return [
        ...boleto.map(l => normalizar(l, 'boleto')),
        ...cartao.map(l => normalizar(l, 'cartao')),
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

/**
 * Todas as tentativas de cobrança da reserva, das duas formas - o painel
 * "tentativas" do modal. Ordenadas da mais antiga para a mais nova.
 */
export async function listarTentativas(idreserva) {
    const [boletos, links] = await Promise.all([
        db.BoletoHistory.findAll({ where: { idreserva }, order: [['id', 'ASC']], raw: true }).catch(() => []),
        db.UseredeLinkHistory.findAll({ where: { idreserva }, order: [['id', 'ASC']], raw: true }).catch(() => []),
    ]);

    const tentativas = [
        ...boletos.map(b => ({
            uid: `boleto:${b.id}`, id: b.id, forma: 'boleto',
            documento: b.nosso_numero, valor: b.valor, vencimento: b.vencimento,
            status: b.status, payment_status: b.payment_status,
            arquivo_url: b.boleto_supabase_url,
            parcelas_limite: null, parcelas_escolhidas: null,
            ignorado: b.ignorado, created_at: b.created_at,
        })),
        ...links.map(c => ({
            uid: `cartao:${c.id}`, id: c.id, forma: 'cartao',
            documento: c.pedido_id, valor: c.valor, vencimento: c.validade,
            status: c.status, payment_status: c.payment_status,
            arquivo_url: c.link_url,
            parcelas_limite: c.parcelas_limite, parcelas_escolhidas: c.parcelas_escolhidas,
            ignorado: c.ignorado, created_at: c.created_at,
        })),
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return tentativas;
}

export default { registrar, listarPorReserva, listarTentativas };
