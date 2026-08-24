// services/userede/UseredeLinkService.js
//
// Emissão do link de pagamento no cartão, de ponta a ponta: cria no portal,
// registra no histórico e envia ao cliente.
//
// É o equivalente do BoletoGenerationService para o cartão, mas MUITO menor:
// o gate do webhook (série, titular, teto, vencimento, re-trigger, janela) fica
// no fluxo comum do Ato, não aqui. Este serviço faz uma coisa - emitir - e
// registra o que aconteceu.
import db from '../../models/sequelize/index.js';
import { withSession } from './UseredeSessionService.js';
import { abrirLinkPagamento, excluirLink } from '../../playwright/modules/userede/navegacao.js';
import { criarLink, montarNome, rotuloPrazo } from '../../playwright/modules/userede/criarLink.js';
import { enviarLinkAoTitular } from './UseredeNotifyService.js';
import Eventos from '../cobrancaAto/eventoService.js';

const TAG = '[UREDE][LINK]';

const formatarBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Limites físicos do portal - acima disto o formulário não aceita. */
export const REDE_MAX_PARCELAS = 12;
export const REDE_MAX_DIAS = 15;
export const REDE_MAX_VALOR = 30000;

async function getSettings() {
    return db.UseredeSettings.findByPk(1);
}

/**
 * Valida contra as regras configuradas E contra os limites do portal.
 * Devolve `null` quando está tudo certo, ou a mensagem do impedimento.
 *
 * Barrar aqui é barato; descobrir no formulário custa uma sessão de navegador
 * e deixa lixo no portal.
 */
export function validar({ valor, parcelas, validade }, settings) {
    const teto = settings?.valor_maximo != null ? Number(settings.valor_maximo) : REDE_MAX_VALOR;
    if (!(Number(valor) > 0)) return 'Valor precisa ser maior que zero.';
    if (Number(valor) > teto) {
        return `Valor ${Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} excede o teto de `
             + `${teto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`;
    }
    if (Number(valor) > REDE_MAX_VALOR) return `A Rede não aceita link acima de R$ ${REDE_MAX_VALOR.toLocaleString('pt-BR')}.`;

    const limite = Number(settings?.max_parcelas) || REDE_MAX_PARCELAS;
    const n = Number(parcelas) || 1;
    if (n < 1) return 'Número de parcelas inválido.';
    if (n > limite) return `Condição pede ${n}x, acima do limite configurado de ${limite}x.`;
    if (n > REDE_MAX_PARCELAS) return `A Rede não aceita parcelamento acima de ${REDE_MAX_PARCELAS}x.`;

    // `rotuloPrazo` devolve null para os DOIS extremos; separar aqui porque a
    // ação do operador é diferente: data no passado se corrige na condição, e
    // data longe demais é limite do portal.
    const hoje = new Date();
    const diasAteVenc = Math.round(
        (new Date(new Date(validade).toDateString()) - new Date(hoje.toDateString())) / 86400000,
    );
    if (diasAteVenc < 0) return 'Vencimento está no passado. Corrija a condição de pagamento da reserva.';
    if (!rotuloPrazo(validade)) {
        return `Vencimento em ${diasAteVenc} dias: o portal da Rede só oferece de hoje até ${REDE_MAX_DIAS} dias.`;
    }
    const maxDias = Number(settings?.max_dias_vencimento);
    if (Number.isFinite(maxDias) && diasAteVenc > maxDias) {
        return `Vencimento em ${diasAteVenc} dias, acima do máximo configurado (${maxDias}).`;
    }
    return null;
}

/**
 * Emite o link para uma reserva e registra tudo.
 *
 * @param {object} dados
 * @param {number} dados.idreserva
 * @param {object} dados.titular       { nome, email, telefone/celular/whatsapp, idpessoa_cv }
 * @param {string} dados.empreendimento
 * @param {string} dados.unidade
 * @param {number} dados.valor         soma das parcelas da série
 * @param {number} dados.parcelas      quantas parcelas a série tem = limite ofertado
 * @param {Date}   dados.validade      vencimento da série
 * @param {boolean} [dados.enviarAoCliente=true]
 * @returns {Promise<object>} o registro do histórico
 */
export async function emitir(dados) {
    const settings = await getSettings();
    const {
        idreserva, titular = {}, empreendimento, unidade,
        valor, parcelas, validade, enviarAoCliente = true,
        // Vindos do fluxo comum do Ato: o valor JA passou pelo percentual do
        // empreendimento, e guardamos o original para a tela mostrar os dois.
        valorOriginal = null, comissaoPercentual = null,
        // Link anterior que este substitui (ja excluido no portal pelo gate de
        // re-trigger antes de chegar aqui).
        substituiId = null,
    } = dados;

    const registro = await db.UseredeLinkHistory.create({
        idreserva,
        idpessoa_cv: titular.idpessoa_cv || null,
        titular_nome: titular.nome || null,
        empreendimento: empreendimento || null,
        unidade: unidade || null,
        pv: settings?.pv_principal || null,
        valor,
        valor_original: valorOriginal ?? valor,
        comissao_percentual_aplicada: comissaoPercentual,
        parcelas_limite: parcelas,
        validade,
        substitui_id: substituiId,
        status: 'processing',
    });

    const impedimento = validar({ valor, parcelas, validade }, settings);
    if (impedimento) {
        console.warn(`${TAG} Reserva ${idreserva} barrada: ${impedimento}`);
        await registro.update({ status: 'error', error_message: impedimento });
        await Eventos.registrar({
            forma: 'cartao', historyId: registro.id, idreserva,
            type: 'validation_failed', severity: 'error', message: impedimento,
            data: { valor, parcelas, validade },
        });
        return registro;
    }

    const nome = montarNome({
        empreendimento, cliente: titular.nome, unidade, referencia: `R${idreserva}`,
    });
    // A string completa vai na descrição (150 chars), porque o nome cabe em 50
    // e é lá que a conciliação sobrevive.
    const descricao = [empreendimento, titular.nome, unidade, `Reserva ${idreserva}`]
        .filter(Boolean).join(' - ').slice(0, 150);

    try {
        const criado = await withSession(async ({ page }) => {
            await abrirLinkPagamento(page);
            return criarLink(page, {
                nome, valor, parcelas,
                prazoRotulo: rotuloPrazo(validade),
                descricao,
            });
        });

        if (!criado?.url) {
            await registro.update({
                status: 'error',
                error_message: 'Link criado no portal mas a URL não pôde ser determinada. Confira na aba Gerenciar.',
            });
            return registro;
        }

        const pedidoId = (criado.url.match(/\/pagamentos\/[a-z]{2}\/([a-z0-9]+)/i) || [])[1] || null;
        await registro.update({
            status: 'success',
            payment_status: 'pending',
            link_url: criado.url,
            pedido_id: pedidoId ? pedidoId.toUpperCase() : null,
        });
        console.log(`${TAG} Reserva ${idreserva}: link ${criado.url}`);
        await Eventos.registrar({
            forma: 'cartao', historyId: registro.id, idreserva,
            type: 'link_created', severity: 'success',
            message: `Link criado no portal - ${formatarBRL(valor)} em ate ${parcelas}x, valido ate ${new Date(validade).toLocaleDateString('pt-BR')}.`,
            data: { pedidoId, url: criado.url, valor, parcelas },
        });

        // Fecha a cadeia: o antigo aponta para quem o substituiu. Sem isso a
        // listagem agrupada por reserva nao sabe qual e a via vigente.
        if (substituiId) {
            await db.UseredeLinkHistory.update(
                { substituido_por_id: registro.id },
                { where: { id: substituiId } },
            ).catch(() => {});
        }
    } catch (err) {
        console.error(`${TAG} Reserva ${idreserva} falhou: ${err.message}`);
        await registro.update({
            status: 'error',
            error_message: String(err.message).slice(0, 500),
        });
        await Eventos.registrar({
            forma: 'cartao', historyId: registro.id, idreserva,
            type: 'link_failed', severity: 'error', message: String(err.message).slice(0, 400),
        });
        return registro;
    }

    if (enviarAoCliente) {
        const envio = await enviarLinkAoTitular({
            titular,
            dados: { empreendimento, unidade, valor, parcelas, validade, url: registro.link_url },
        });
        await registro.update({
            cliente_email_enviado: !!envio.email?.ok,
            cliente_whatsapp_enviado: !!envio.whatsapp?.ok,
            cliente_envio_em: (envio.email?.ok || envio.whatsapp?.ok) ? new Date() : null,
            warnings: [
                ...(envio.email?.ok ? [] : [{ etapa: 'cliente_email', erro: envio.email?.error }]),
                ...(envio.whatsapp?.ok ? [] : [{ etapa: 'cliente_whatsapp', erro: envio.whatsapp?.error }]),
            ].filter(w => w.erro) || null,
        });
        for (const [canal, r] of [['client_email', envio.email], ['client_whatsapp', envio.whatsapp]]) {
            await Eventos.registrar({
                forma: 'cartao', historyId: registro.id, idreserva,
                type: r?.ok ? canal : `${canal}_skipped`,
                severity: r?.ok ? 'success' : 'warning',
                message: r?.ok ? `Enviado para ${r.to}` : (r?.error || 'nao enviado'),
                data: { to: r?.to || null, freeWindow: r?.freeWindow ?? null },
            });
        }
    }

    return registro;
}

/**
 * Exclui o link no portal e marca no histórico.
 *
 * É o equivalente à baixa do boleto e existe pelo mesmo motivo: sem isso, um
 * link emitido por engano continua pagável até vencer. Diferença importante -
 * link JÁ PAGO não se exclui, só se estorna pelo portal.
 */
export async function excluir(registroId, { motivo = null } = {}) {
    const registro = await db.UseredeLinkHistory.findByPk(registroId);
    if (!registro) throw new Error('Registro não encontrado.');
    if (!registro.pedido_id) throw new Error('Registro sem identificação do pedido - nada a excluir no portal.');
    if (registro.payment_status === 'paid') {
        throw new Error('Link já pago: exclusão não se aplica. O caminho é estorno pelo portal (vendas > cancelamento de vendas).');
    }

    const r = await withSession(async ({ page }) => {
        await abrirLinkPagamento(page);
        return excluirLink(page, registro.pedido_id);
    });

    if (!r.excluido) {
        throw new Error(`Não foi possível excluir o link no portal (${r.motivo}).`);
    }

    await registro.update({
        excluido_no_portal: true,
        payment_status: 'cancelled',
        cancelled_at: new Date(),
        error_message: motivo || registro.error_message,
    });
    await Eventos.registrar({
        forma: 'cartao', historyId: registro.id, idreserva: registro.idreserva,
        type: 'link_deleted', severity: 'warning',
        message: motivo || `Link ${registro.pedido_id} excluido no portal.`,
        data: { pedidoId: registro.pedido_id },
    });
    return registro;
}

export default { emitir, excluir, validar };
