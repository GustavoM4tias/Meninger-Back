// services/userede/UseredeConciliacaoService.js
//
// Conciliação dos links de cartão: descobre o que foi pago, negado, expirou ou
// foi estornado, e atualiza o histórico.
//
// ── Uma passada, não uma por link ─────────────────────────────────────────────
// A aba Gerenciar já traz o status na própria linha. Lemos a listagem inteira
// de uma vez e casamos pelo identificador do pedido; só os que MUDARAM de
// status são expandidos, para pegar em quantas vezes o cliente parcelou e o
// motivo da recusa. Abrir link por link custaria segundos cada.
//
// ── Existe caminho melhor, e ele não é este ───────────────────────────────────
// O portal manda e-mail a cada link pago ou negado (Configurar > Notificação de
// transação, até 5 endereços). Ler essa caixa dá conciliação quase em tempo
// real, contra o atraso de uma varredura agendada. Este serviço é a rede de
// segurança - e continua útil mesmo com o e-mail, porque cobre o que se perdeu.
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { withSession } from './UseredeSessionService.js';
import { abrirLinkPagamento, listarLinks, detalharLink } from '../../playwright/modules/userede/navegacao.js';

const TAG = '[UREDE][CONCILIA]';

// Status que ainda podem mudar. `paid` e `refunded` são finais para nós;
// `expired`/`denied` também, mas relemos por alguns dias porque o portal às
// vezes só marca a expiração no dia seguinte.
const ABERTOS = ['pending'];

/** Carimbos que cada desfecho deixa no registro. */
function camposPorStatus(status, agora) {
    switch (status) {
        case 'paid':      return { payment_status: 'paid', paid_at: agora };
        case 'expired':   return { payment_status: 'expired', cancelled_at: agora };
        case 'denied':    return { payment_status: 'denied' };
        case 'refunded':  return { payment_status: 'refunded', cancelled_at: agora };
        default:          return { payment_status: status };
    }
}

/**
 * Roda a conciliação.
 *
 * @param {object} [opts]
 * @param {number[]} [opts.idreservas] limita a certas reservas (uso manual/debug)
 * @returns {Promise<{ lidos, atualizados, semCorrespondencia, mudancas }>}
 */
export async function conciliar({ idreservas = null } = {}) {
    const where = {
        status: 'success',
        payment_status: { [Op.in]: ABERTOS },
        pedido_id: { [Op.ne]: null },
        ...(idreservas?.length ? { idreserva: { [Op.in]: idreservas } } : {}),
    };

    const pendentes = await db.UseredeLinkHistory.findAll({ where });
    if (!pendentes.length) {
        console.log(`${TAG} Nada pendente para conciliar.`);
        return { lidos: 0, atualizados: 0, semCorrespondencia: 0, mudancas: [] };
    }
    console.log(`${TAG} ${pendentes.length} link(s) pendente(s).`);

    const porPedido = new Map(pendentes.map(p => [String(p.pedido_id).toUpperCase(), p]));
    const mudancas = [];
    let lidos = 0;

    await withSession(async ({ page }) => {
        await abrirLinkPagamento(page);
        await page.keyboard.press('Escape').catch(() => {});

        const linhas = await listarLinks(page);
        lidos = linhas.length;
        const agora = new Date();

        for (const linha of linhas) {
            const registro = porPedido.get(linha.pedidoId);
            if (!registro) continue;                       // link que não é nosso
            porPedido.delete(linha.pedidoId);

            await registro.update({
                last_checked_at: agora,
                last_check_situation: linha.statusTexto || null,
            });

            if (!linha.status || linha.status === registro.payment_status) continue;

            const atualizacao = camposPorStatus(linha.status, agora);

            // Só quem mudou é expandido: é aí que vive em quantas vezes o
            // cliente parcelou (o TETO que ofertamos não diz isso) e o motivo
            // da recusa.
            if (['paid', 'denied'].includes(linha.status)) {
                const det = await detalharLink(page, linha.pedidoId).catch(() => null);
                if (det) {
                    if (det.parcelas) atualizacao.parcelas_escolhidas = det.parcelas;
                    if (det.motivo) atualizacao.motivo_recusa = String(det.motivo).slice(0, 200);
                }
            }

            await registro.update(atualizacao);
            mudancas.push({
                id: registro.id,
                idreserva: registro.idreserva,
                pedidoId: linha.pedidoId,
                de: 'pending',
                para: linha.status,
                parcelas: atualizacao.parcelas_escolhidas || null,
            });
            console.log(`${TAG} #${linha.pedidoId} (reserva ${registro.idreserva}): pending -> ${linha.status}`
                + (atualizacao.parcelas_escolhidas ? ` em ${atualizacao.parcelas_escolhidas}x` : ''));
        }
    });

    // Sobrou no mapa = está no nosso histórico mas não apareceu na listagem.
    // Normal quando o link é antigo e caiu fora da janela de datas do portal;
    // registramos para não parecer que foi conferido.
    const semCorrespondencia = porPedido.size;
    if (semCorrespondencia) {
        console.warn(`${TAG} ${semCorrespondencia} link(s) não apareceram na listagem: `
            + [...porPedido.keys()].join(', '));
    }

    return { lidos, atualizados: mudancas.length, semCorrespondencia, mudancas };
}

export default { conciliar };
