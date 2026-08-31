// services/cv/cvWebhookService.js
//
// Entrada em tempo real do CV.
//
// A régua que este módulo segue, e o porquê de cada uma:
//
//   1. O payload é CAMPAINHA, não dado. Dele sai só o id; tudo o que for
//      gravado vem de uma busca em /v1/comercial/reservas/{id}. A API do CV
//      tem histórico de responder uma coisa e ter feito outra (o POST de
//      correspondentes grava e devolve erro; a troca de situação responde 200
//      e não aplica), então o corpo de um evento não é fonte de verdade. Além
//      disso, buscar no momento do processamento resolve de graça a ordem de
//      chegada: o que se grava é sempre o estado ATUAL, nunca o de um evento
//      antigo que chegou atrasado.
//
//   2. Reaproveita o ReservaFullSweepService. Ele já é o caminho por id que o
//      gap horário usa há meses, com retry, 404 -> cv_reserva_id_dead e a
//      comparação de snapshot. Um caminho novo em paralelo divergiria do que
//      roda de verdade - foi por isso que o "rodar agora" da tela de crons
//      também executa exatamente o mesmo `run` do agendamento.
//
//   3. Coalescência por id. Os dois gatilhos do CV (alteração de situação e
//      entrada em situação) podem disparar juntos na criação, e uma reserva
//      que anda rápido gera rajada. Duas execuções simultâneas para o mesmo id
//      brigariam pelo mesmo array `status`. Aqui, o segundo evento de um id em
//      processamento não abre execução nova: marca que é preciso repetir UMA
//      vez ao final, o que garante que o estado final seja lido depois do
//      último evento sem multiplicar chamadas.
//
//   4. Teto de simultaneidade. Uma rajada não pode virar uma enxurrada de
//      chamadas ao CV - é assim que se ganha 429.

import db from '../../models/sequelize/index.js';
import ReservaFullSweepService from '../bulkData/cv/ReservaFullSweepService.js';
import RepasseSyncService from '../bulkData/cv/RepasseSyncService.js';
import LeadSyncService from '../bulkData/cv/LeadSyncService.js';
import PrecadastroSyncService from '../bulkData/cv/PrecadastroSyncService.js';
import { registrar } from './cvIntegrationLog.js';

const MAX_SIMULTANEOS = parseInt(process.env.CV_WEBHOOK_MAX_CONCURRENT || '3', 10);

const sweep = new ReservaFullSweepService();
const repasses = new RepasseSyncService();
const leads = new LeadSyncService();
const precadastros = new PrecadastroSyncService();

// Chaveados por FUNCIONALIDADE + id, nunca só pelo id: o lead 100 e a reserva
// 100 são coisas diferentes, e uma trava só numérica faria um esperar pelo
// outro (ou pior, marcar o outro como duplicado e descartar o evento).
const emProcessamento = new Set();   // "funcionalidade:id" rodando agora
const precisaRepetir = new Set();    // os que receberam evento durante a execução
const chaveDe = (funcionalidade, id) => `${funcionalidade}:${id}`;
let emVoo = 0;
const fila = [];

// ── Extração do id ───────────────────────────────────────────────────────────
// O formato exato do corpo do CV não está documentado e varia por
// funcionalidade, então a leitura é generosa: procura em vários nomes e também
// um nível abaixo. O corpo cru vai inteiro para o histórico, então um formato
// não previsto aparece na tela em vez de sumir num 400.
const CHAVES_POR_FUNCIONALIDADE = {
    reservas: ['idreserva', 'id_reserva', 'reserva_id', 'idReserva', 'id'],
    repasses: ['idrepasse', 'id_repasse', 'repasse_id', 'idRepasse', 'ID', 'idreserva', 'id'],
    leads: ['idlead', 'id_lead', 'lead_id', 'idLead', 'id'],
    precadastros: ['idprecadastro', 'id_precadastro', 'precadastro_id', 'idPrecadastro', 'id'],
};

export function extrairId(corpo, funcionalidade) {
    const chaves = CHAVES_POR_FUNCIONALIDADE[funcionalidade] || ['id'];
    const candidatos = [corpo, corpo?.dados, corpo?.data, corpo?.payload, corpo?.reserva, corpo?.repasse];

    for (const objeto of candidatos) {
        if (!objeto || typeof objeto !== 'object') continue;
        for (const chave of chaves) {
            const valor = Number(objeto[chave]);
            if (Number.isFinite(valor) && valor > 0) return valor;
        }
    }
    return null;
}

// ── Fila com teto de simultaneidade ──────────────────────────────────────────
function proximo() {
    if (emVoo >= MAX_SIMULTANEOS || !fila.length) return;
    const tarefa = fila.shift();
    emVoo++;
    tarefa().finally(() => { emVoo--; proximo(); });
}

function enfileirar(tarefa) {
    fila.push(tarefa);
    proximo();
}

// ── Processadores por funcionalidade ─────────────────────────────────────────
// Um processador por funcionalidade. Todos reaproveitam o mesmo serviço que o
// cron usa, e não um caminho novo em paralelo: dois caminhos gravando a mesma
// tabela com regras próprias acabam divergindo, e a divergência aparece como
// registro que "muda sozinho" toda vez que a outra origem passa - foi
// exatamente o defeito entre o delta e o sweep de reservas.
const PROCESSADORES = {
    async reservas(idreserva) {
        // skipDead: false — um id que já foi 404 pode passar a existir, e se o
        // CV está avisando sobre ele agora, é porque existe.
        return sweep.run({ ids: [idreserva], skipDead: false });
    },

    // O id do aviso de repasse pode ser idrepasse ou idreserva; o serviço
    // confere qual é em vez de supor. Ver syncPorIdDoWebhook.
    async repasses(id) {
        return repasses.syncPorIdDoWebhook(id);
    },

    async leads(idlead) {
        return leads.syncOne(idlead);
    },

    async precadastros(idprecadastro) {
        return precadastros.upsertOne(idprecadastro);
    },
};

/**
 * Processa um evento já autenticado. Roda em segundo plano: quem chama é o
 * controller, que já respondeu 200 ao CV.
 */
async function processar({ endpoint, idEntidade, corpo }) {
    const funcionalidade = endpoint.funcionalidade;
    const t0 = Date.now();

    const finalizar = async (status, mensagem, stats = null) => {
        await registrar({
            origem: 'webhook',
            funcionalidade,
            entidade_id: idEntidade,
            status,
            mensagem,
            duracao_ms: Date.now() - t0,
            payload: corpo,
            stats,
        });
        try {
            await db.CvWebhookEndpoint.update(
                {
                    last_event_at: new Date(),
                    last_status: status,
                    last_message: mensagem || null,
                    eventos_recebidos: db.Sequelize.literal('eventos_recebidos + 1'),
                },
                { where: { funcionalidade } },
            );
        } catch (err) {
            console.warn(`[CV webhook] falha ao atualizar saúde de "${funcionalidade}":`, err?.message);
        }
    };

    if (!idEntidade) {
        return finalizar('erro', 'Não foi possível achar o id no corpo do evento. O corpo está registrado aqui.');
    }

    // Modo escuta: aceita, registra e não age.
    if (!endpoint.processa) {
        return finalizar('escuta', `Evento recebido em modo escuta; nada foi sincronizado (id=${idEntidade}).`);
    }

    const processador = PROCESSADORES[funcionalidade];
    if (!processador) {
        return finalizar('ignorado',
            `Ainda não há processamento para "${funcionalidade}". Deixe em modo escuta até o formato do payload estar confirmado.`);
    }

    // Já tem uma execução deste id em pé: marca para repetir uma vez e sai.
    const chave = chaveDe(funcionalidade, idEntidade);
    if (emProcessamento.has(chave)) {
        precisaRepetir.add(chave);
        return finalizar('duplicado', `Já havia sincronização em andamento para ${funcionalidade} ${idEntidade}; será repetida ao final.`);
    }

    emProcessamento.add(chave);
    try {
        const stats = await processador(idEntidade);
        await finalizar('ok', null, stats);
    } catch (err) {
        await finalizar('erro', err?.message || String(err));
    } finally {
        emProcessamento.delete(chave);
        // Chegou evento novo enquanto rodava: uma repetição basta, porque a
        // busca lê o estado atual e não o do evento.
        if (precisaRepetir.delete(chave)) {
            enfileirar(() => processar({ endpoint, idEntidade, corpo: { _repeticao: true, de: corpo } }));
        }
    }
}

/**
 * Ponto de entrada do controller. Enfileira e devolve na hora - o CV não pode
 * ficar esperando as chamadas de volta ao próprio CV.
 */
export function agendarProcessamento({ endpoint, idEntidade, corpo }) {
    enfileirar(() => processar({ endpoint, idEntidade, corpo })
        .catch(err => console.error('[CV webhook] erro no processamento:', err?.message || err)));
}

/**
 * Mesma execução do webhook, disparada pela tela para um id específico.
 * Existe pelo motivo de sempre: um botão que processa por outro caminho
 * acabaria divergindo do que roda de verdade.
 */
export async function reprocessar({ funcionalidade, idEntidade, usuarioId = null }) {
    const endpoint = await db.CvWebhookEndpoint.findByPk(funcionalidade);
    if (!endpoint) throw new Error(`Funcionalidade desconhecida: ${funcionalidade}`);

    const processador = PROCESSADORES[funcionalidade];
    if (!processador) throw new Error(`Ainda não há processamento para "${funcionalidade}".`);

    const t0 = Date.now();
    try {
        const stats = await processador(idEntidade);
        await registrar({
            origem: 'manual',
            funcionalidade,
            entidade_id: idEntidade,
            status: 'ok',
            mensagem: usuarioId ? `Reprocessado pela tela (usuário ${usuarioId}).` : 'Reprocessado pela tela.',
            duracao_ms: Date.now() - t0,
            stats,
        });
        return stats;
    } catch (err) {
        await registrar({
            origem: 'manual',
            funcionalidade,
            entidade_id: idEntidade,
            status: 'erro',
            mensagem: err?.message || String(err),
            duracao_ms: Date.now() - t0,
        });
        throw err;
    }
}

export default { extrairId, agendarProcessamento, reprocessar };
