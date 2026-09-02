// services/fleet/fleetCalendarService.js
//
// Enquanto o carro está ocupado, existe um evento no calendário Microsoft com
// as pessoas da alçada como participantes. É a ponte entre o Office e o hábito
// que já existe: quem só olha o Outlook continua vendo o carro ocupado.
//
// POR QUE TOKEN DE APLICAÇÃO, E NÃO O LOGIN DA PESSOA
//
// O caminho delegado está morto na prática: nenhum dos usuários tem refresh
// token da Microsoft guardado, então "criar na agenda de quem está logado"
// falharia para todo mundo. O token de aplicação foi medido em 27/08/2026 e
// tem `Calendars.ReadWrite` de Aplicação, que cria evento em qualquer caixa.
//
// POR QUE O EVENTO É "LIVRE" E OS PARTICIPANTES SÃO OPCIONAIS
//
// O carro estar ocupado não significa que a PESSOA está ocupada. Evento
// marcado como busy pintaria a agenda de 19 pessoas de vermelho e o primeiro
// pedido seria para desligar tudo. Ambos são configuráveis na tela.
import db from '../../models/sequelize/index.js';
import graph from '../microsoft/MicrosoftGraphService.js';
import { getSettings, usuariosDaAlcada } from './fleetConfig.js';
import { urlDeEnv, ehProducao } from '../../utils/envUrl.js';

const FRONT_PROD = 'https://office.menin.com.br';
const FRONT_DEV = 'http://localhost:5173';

function urlDaTela() {
    return `${urlDeEnv('FRONTEND_URL', ehProducao() ? FRONT_PROD : FRONT_DEV)}/frota`;
}

// Mandamos o instante em UTC e deixamos o Outlook exibir no fuso de quem lê.
// Formatar "hora local" à mão aqui seria reintroduzir o bug de fuso que a
// montagem da janela já resolveu.
function instante(data) {
    return { dateTime: new Date(data).toISOString(), timeZone: 'UTC' };
}

function nomeDe(user) {
    // `users` não tem coluna `name`: o nome legível é o username.
    return user?.username || user?.email || 'Sem nome';
}

function rotuloVeiculo(veiculo) {
    if (!veiculo) return 'Veículo corporativo';
    return veiculo.apelido || `${veiculo.modelo} (${veiculo.placa})`;
}

/**
 * A caixa que ORGANIZA o evento. Configurável porque uma caixa dedicada
 * (frota@) mantém o histórico quando a pessoa sai da empresa; sem ela, cai na
 * caixa do próprio condutor, que é o que funciona sem pedir nada ao TI.
 */
async function resolverOrganizador(condutorEmail, settings) {
    const configurado = (settings.evento_organizador_email || '').trim();
    return configurado || condutorEmail || null;
}

async function montarParticipantes(settings, organizadorEmail) {
    if (settings.evento_participantes !== 'alcada') return [];
    const pessoas = await usuariosDaAlcada();
    return pessoas
        .filter(p => p.email && p.email.toLowerCase() !== String(organizadorEmail || '').toLowerCase())
        .map(p => ({
            emailAddress: { address: p.email, name: nomeDe(p) },
            // opcional de propósito: ninguém precisa aceitar nada, é só visão.
            type: 'optional',
        }));
}

function corpoDoEvento({ titulo, linhas }) {
    const itens = linhas.filter(Boolean).map(l => `<li>${l}</li>`).join('');
    return {
        contentType: 'HTML',
        content: `<p><strong>${titulo}</strong></p><ul>${itens}</ul>`
            + `<p><a href="${urlDaTela()}">Abrir a agenda do veículo no Office</a></p>`,
    };
}

/**
 * Cria ou atualiza o evento da reserva. Nunca deixa o erro subir: reserva
 * gravada com evento falho é um problema pequeno; reserva perdida porque o
 * Graph estava fora do ar é um problema grande.
 */
export async function sincronizarEvento(reservationId) {
    const settings = await getSettings();
    if (!settings.evento_ativo) return null;

    const reserva = await db.VehicleReservation.findByPk(reservationId, {
        include: [
            { model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false },
            { model: db.Vehicle, as: 'veiculo', required: false },
        ],
    });
    if (!reserva) return null;
    if (!['reservada', 'em_uso'].includes(reserva.status)) return null;

    const organizador = await resolverOrganizador(reserva.condutor?.email, settings);
    if (!organizador) {
        await reserva.update({ calendar_error: 'Sem caixa para organizar o evento (condutor sem e-mail e nenhuma caixa configurada).' });
        return null;
    }

    const emUso = reserva.status === 'em_uso';
    const corpo = {
        subject: `${emUso ? '🚗 Em uso' : '🗓️ Reservado'}: ${rotuloVeiculo(reserva.veiculo)} - ${nomeDe(reserva.condutor)}`,
        body: corpoDoEvento({
            titulo: emUso ? 'Veículo retirado' : 'Veículo reservado',
            linhas: [
                `Condutor: ${nomeDe(reserva.condutor)}`,
                reserva.destino ? `Destino: ${reserva.destino}` : null,
                reserva.departamento ? `Departamento: ${reserva.departamento}` : null,
                reserva.solicitado_por ? `A pedido de: ${reserva.solicitado_por}` : null,
                reserva.observacao ? `Observação: ${reserva.observacao}` : null,
            ],
        }),
        start: instante(reserva.inicio),
        end: instante(reserva.fim),
        location: { displayName: reserva.destino || rotuloVeiculo(reserva.veiculo) },
        showAs: settings.evento_mostrar_como === 'busy' ? 'busy' : 'free',
        isReminderOn: settings.evento_lembrete_minutos > 0,
        reminderMinutesBeforeStart: settings.evento_lembrete_minutos || 0,
        responseRequested: false,
        allowNewTimeProposals: false,
        attendees: await montarParticipantes(settings, organizador),
    };

    try {
        if (reserva.calendar_event_id && reserva.calendar_organizer) {
            const caminho = `/users/${encodeURIComponent(reserva.calendar_organizer)}/events/${reserva.calendar_event_id}`;
            const atualizado = await graph.appPatch(caminho, corpo);
            await reserva.update({ calendar_error: null });
            return atualizado;
        }

        const criado = await graph.appPost(`/users/${encodeURIComponent(organizador)}/events`, corpo);
        await reserva.update({
            calendar_event_id: criado?.id || null,
            calendar_organizer: organizador,
            calendar_error: null,
        });
        return criado;
    } catch (err) {
        // Guardar o motivo deixa a tela dizer "evento não criado" em vez de
        // fingir que está tudo certo.
        const motivo = err?.message || 'Falha desconhecida ao falar com o calendário.';
        console.warn(`[Frota] Evento da reserva ${reserva.id} falhou: ${motivo}`);
        await reserva.update({ calendar_error: motivo }).catch(() => {});
        return null;
    }
}

/**
 * Devolveu antes (ou depois) da hora: o evento passa a terminar quando o carro
 * realmente voltou. Ficar até o fim previsto faria o calendário mentir sobre
 * um carro que já está livre.
 */
export async function encerrarEvento(reserva) {
    if (!reserva?.calendar_event_id || !reserva.calendar_organizer) return null;
    const settings = await getSettings();
    if (!settings.evento_ativo) return null;

    const fim = reserva.devolvido_em || new Date();
    const caminho = `/users/${encodeURIComponent(reserva.calendar_organizer)}/events/${reserva.calendar_event_id}`;

    try {
        return await graph.appPatch(caminho, {
            subject: `✅ Devolvido: ${rotuloVeiculo(reserva.veiculo)}`,
            // Evento não pode terminar antes de começar: devolução no mesmo
            // minuto da retirada viraria 400 do Graph.
            end: instante(new Date(fim) > new Date(reserva.inicio) ? fim : reserva.inicio),
        });
    } catch (err) {
        console.warn(`[Frota] Encerrar evento da reserva ${reserva.id} falhou: ${err.message}`);
        return null;
    }
}

export async function removerEvento(registro) {
    if (!registro?.calendar_event_id || !registro.calendar_organizer) return null;
    const caminho = `/users/${encodeURIComponent(registro.calendar_organizer)}/events/${registro.calendar_event_id}`;
    try {
        await graph.appDelete(caminho);
        await registro.update({ calendar_event_id: null, calendar_organizer: null }).catch(() => {});
        return true;
    } catch (err) {
        console.warn(`[Frota] Remover evento falhou: ${err.message}`);
        return null;
    }
}

/** Manutenção também ocupa o carro, então também vira evento. */
export async function sincronizarBloqueio(blockId) {
    const settings = await getSettings();
    if (!settings.evento_ativo) return null;

    const bloqueio = await db.VehicleBlock.findByPk(blockId, {
        include: [{ model: db.Vehicle, as: 'veiculo', required: false }],
    });
    if (!bloqueio) return null;

    // Bloqueio não tem condutor: sem caixa configurada não há de quem pendurar
    // o evento, e forçar a caixa de um admin qualquer seria invasivo.
    const organizador = (settings.evento_organizador_email || '').trim();
    if (!organizador) return null;

    try {
        const criado = await graph.appPost(`/users/${encodeURIComponent(organizador)}/events`, {
            subject: `🔧 Indisponível: ${rotuloVeiculo(bloqueio.veiculo)}`,
            body: corpoDoEvento({
                titulo: bloqueio.tipo === 'manutencao' ? 'Veículo em manutenção' : 'Veículo indisponível',
                linhas: [bloqueio.motivo, bloqueio.observacao],
            }),
            start: instante(bloqueio.inicio),
            end: instante(bloqueio.fim),
            showAs: 'free',
            isReminderOn: false,
            responseRequested: false,
            attendees: await montarParticipantes(settings, organizador),
        });
        await bloqueio.update({ calendar_event_id: criado?.id || null, calendar_organizer: organizador });
        return criado;
    } catch (err) {
        console.warn(`[Frota] Evento do bloqueio ${bloqueio.id} falhou: ${err.message}`);
        return null;
    }
}

export default { sincronizarEvento, encerrarEvento, removerEvento, sincronizarBloqueio };
