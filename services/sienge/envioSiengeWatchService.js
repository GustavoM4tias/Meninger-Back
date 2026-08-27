// services/sienge/envioSiengeWatchService.js
//
// VIGIA DO ENVIO DA VENDA AO ERP.
//
// O problema que ele resolve: entre junho e agosto de 2026, 13% a 16% das vendas
// que passaram pelo fluxo do ato nunca viraram contrato no Sienge - 28 delas com
// o ato já PAGO. Ninguém percebia, porque não existia lugar nenhum que dissesse
// "esta venda não chegou ao ERP".
//
// ── O QUE APRENDEMOS MEDINDO (27/08/2026) ───────────────────────────────────
//
// 1. O sinal confiável é `reservas.erp_sienge.enviado`. Conferimos as 89
//    pendentes contra a API do Sienge (por externalId): 89 de 89 realmente sem
//    contrato. Zero falso positivo.
//
// 2. O envio NÃO é um lote de minutos, é uma FILA LENTA. Sobre 1274 envios de
//    2026: p50 20h, p75 116h (~5 dias), p90 605h (~25 dias), vazão de 5 a 13 por
//    dia. Por isso o vigia NÃO alarma por "não enviado" - alarma por esperar
//    mais do que a fila costuma levar. Alarmar cedo seria transformar o vigia em
//    ruído diário.
//
// 3. O relógio tem que ser nosso. `erp_sienge.data_cad` é quando o CV preparou o
//    registro, não quando a venda entrou na fila: reservas que passaram meses
//    fora de "Envio Sienge" apareciam com 110 dias de espera tendo entrado na
//    fila no dia anterior. O vigia carimba `pendente_desde` quando VÊ a reserva
//    pendente pela primeira vez.
//
// 4. Reserva parada na etapa, sem nenhuma alteração, parece nunca ser
//    reprocessada: nas 48h seguintes à migração, das 48 paradas há semanas saíram
//    ZERO, e das 46 que foram mexidas saíram 5 - uma delas esperava 110 dias.
//    Por isso o vigia sugere o gesto de reprocessar (tirar da etapa e devolver),
//    mas NÃO o executa sozinho: a volta a "Envio Sienge" redispara o webhook do
//    ato e pode gerar cobrança nova ao cliente.
//
// 5. O CV não conta o motivo. `reserva_sienge_descricao_problema` existe no JSON
//    e nunca é preenchido; a API v1/v3 não expõe nada de integração (405 em todo
//    caminho de pessoa/ERP); e o motivo só aparece no painel Gestor, que está
//    atrás de um desafio Cloudflare. Então o vigia aponta o CASO e a pessoa abre
//    o painel - ele não tem como trazer a causa mastigada.
//
// O que ele faz, portanto: acompanha, mede a espera com relógio próprio,
// classifica por severidade e avisa uma vez por mudança de severidade.

import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import apiSienge from '../../lib/apiSienge.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const HORA_MS = 60 * 60 * 1000;

/** Configuração viva; cria a linha singleton no primeiro uso. */
export async function getSettings() {
    const { EnvioSiengeWatchSettings } = db;
    let s = await EnvioSiengeWatchSettings.findByPk(1);
    if (!s) s = await EnvioSiengeWatchSettings.create({ id: 1 });
    return s;
}

/**
 * Confirma no CV, AO VIVO, se a reserva já foi ao ERP.
 *
 * A tabela local é sincronizada de hora em hora e atrasa mais do que isso
 * (ficou um dia inteiro para trás depois da migração de etapas), então perguntar
 * ao CV evita alarme por dado velho. São dezenas de chamadas, não milhares.
 *
 * @returns {Promise<{enviado: boolean, codigo: string|null}|null>} null = não deu para ler
 */
async function conferirNoCv(idreserva) {
    try {
        const { data } = await apiCv.get(`/v1/comercial/reservas/${idreserva}/erp/sienge`);
        return {
            enviado: String(data?.enviado || '').toUpperCase() === 'S',
            codigo: data?.codigointerno ?? null,
        };
    } catch {
        return null;
    }
}

/**
 * A palavra final: existe contrato ativo no Sienge para esta reserva?
 * O CV grava o idreserva no `externalId` do contrato.
 */
async function conferirNoSienge(idreserva) {
    try {
        const { data } = await apiSienge.get('/v1/sales-contracts', {
            params: { externalId: String(idreserva), limit: 50, offset: 0 },
        });
        const ativos = (data?.results || [])
            .filter(x => String(x?.situation || '').toUpperCase() !== 'CANCELADO');
        return { existe: ativos.length > 0, contrato: ativos[0]?.number ?? null };
    } catch {
        return null;
    }
}

function severidadeDe({ horas, atoPago, settings }) {
    const dias = horas / 24;
    if (settings.ato_pago_e_critico && atoPago) return 'critica';
    if (dias >= Number(settings.dias_critico ?? 15)) return 'critica';
    if (dias >= Number(settings.dias_atraso ?? 5)) return 'atrasada';
    return 'na_fila';
}

/**
 * Uma rodada do vigia.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.notificar=true] - false roda a varredura sem avisar ninguém
 *   (útil para conferir o efeito de uma mudança de limiar antes de valer).
 */
export async function runWatch(opts = {}) {
    const notificar = opts.notificar !== false;
    const settings = await getSettings();
    const { EnvioSiengeWatchItem } = db;
    const t0 = Date.now();

    const idsituacao = String(settings.idsituacao_vigiada ?? 17);

    // Candidatas: na etapa vigiada e sem envio segundo a última sincronização.
    const candidatas = await db.sequelize.query(`
        SELECT r.idreserva, r.empreendimento, r.unidade, r.titular->>'nome' AS titular_nome,
               (r.erp_sienge->>'data_cad')::timestamp AS data_cad_erp,
               EXISTS (
                   SELECT 1 FROM boleto_history h
                   WHERE h.idreserva::int = r.idreserva AND h.payment_status = 'paid' AND h.ignorado = false
               ) OR EXISTS (
                   SELECT 1 FROM userede_link_history u
                   WHERE u.idreserva::int = r.idreserva AND u.payment_status = 'paid' AND u.ignorado = false
               ) AS ato_pago
        FROM reservas r
        WHERE r.situacao->>'idsituacao' = :idsituacao
          AND COALESCE(r.erp_sienge->>'enviado', 'N') <> 'S'
        ORDER BY r.data_reserva`, {
        replacements: { idsituacao },
        type: db.Sequelize.QueryTypes.SELECT,
    });

    const agora = new Date();
    const resumo = { verificadas: 0, na_fila: 0, atrasadas: 0, criticas: 0, resolvidas: 0, ilegiveis: 0, avisados: 0 };
    const paraAvisar = [];

    for (const r of candidatas) {
        resumo.verificadas++;
        const vivo = await conferirNoCv(r.idreserva);
        if (vivo === null) resumo.ilegiveis++;

        let item = await EnvioSiengeWatchItem.findOne({ where: { idreserva: r.idreserva } });

        // Já foi: fecha o acompanhamento e guarda quanto esperou - é esse número
        // que permite recalibrar os limiares com dado nosso, não com chute.
        if (vivo?.enviado) {
            if (item && !item.resolvido_em) {
                const horas = Math.round((agora - new Date(item.pendente_desde)) / HORA_MS);
                await item.update({
                    resolvido_em: agora, espera_horas: horas,
                    contrato_erp: vivo.codigo, ultima_verificacao: agora, severidade: 'na_fila',
                });
                resumo.resolvidas++;
            }
            continue;
        }

        if (!item) {
            item = await EnvioSiengeWatchItem.create({
                idreserva: r.idreserva,
                empreendimento: r.empreendimento,
                unidade: r.unidade,
                titular_nome: r.titular_nome,
                pendente_desde: agora,
                data_cad_erp: r.data_cad_erp || null,
                ultima_verificacao: agora,
                ato_pago: !!r.ato_pago,
                severidade: 'na_fila',
            });
        }

        // Reapareceu depois de resolvida (raro, mas o CV já voltou atrás): recomeça o relógio.
        if (item.resolvido_em) {
            await item.update({ resolvido_em: null, espera_horas: null, contrato_erp: null, pendente_desde: agora, avisado_em: null, avisado_severidade: null });
        }

        const horas = (agora - new Date(item.pendente_desde)) / HORA_MS;
        const severidade = severidadeDe({ horas, atoPago: !!r.ato_pago, settings });

        // A confirmação no ERP custa uma chamada por reserva: só para quem vai virar
        // alarme. Se o Sienge disser que o contrato existe, o alarme morre aqui.
        let confirmado = item.confirmado_sem_contrato;
        if (settings.confirmar_no_sienge && severidade !== 'na_fila') {
            const noErp = await conferirNoSienge(r.idreserva);
            if (noErp) {
                confirmado = !noErp.existe;
                if (noErp.existe) {
                    await item.update({
                        resolvido_em: agora,
                        espera_horas: Math.round(horas),
                        contrato_erp: noErp.contrato,
                        confirmado_sem_contrato: false,
                        ultima_verificacao: agora,
                    });
                    resumo.resolvidas++;
                    continue;
                }
            }
        }

        await item.update({
            severidade,
            ato_pago: !!r.ato_pago,
            confirmado_sem_contrato: confirmado,
            ultima_verificacao: agora,
            empreendimento: r.empreendimento,
            unidade: r.unidade,
            titular_nome: r.titular_nome,
        });

        if (severidade === 'critica') resumo.criticas++;
        else if (severidade === 'atrasada') resumo.atrasadas++;
        else resumo.na_fila++;

        // Avisa uma vez por severidade: quem já foi avisado como crítica não vira
        // aviso diário. Piorou de atrasada para crítica, avisa de novo.
        if (severidade !== 'na_fila' && item.avisado_severidade !== severidade) {
            paraAvisar.push({ item, severidade, horas: Math.round(horas), r });
        }
    }

    if (notificar && paraAvisar.length) {
        const users = Array.isArray(settings.notify_user_ids) ? settings.notify_user_ids.map(Number).filter(Boolean) : [];
        if (users.length) {
            const criticas = paraAvisar.filter(p => p.severidade === 'critica');
            const atrasadas = paraAvisar.filter(p => p.severidade === 'atrasada');
            const diasDoCv = (d) => (d ? Math.round((Date.now() - new Date(d)) / (24 * HORA_MS)) : null);
            const linhas = paraAvisar.slice(0, 10).map(p => {
                const noCv = diasDoCv(p.item.data_cad_erp);
                return `• Reserva ${p.r.idreserva} - ${p.r.empreendimento || '?'} ${p.r.unidade || ''}`
                    + ` (${Math.round(p.horas / 24)} dias acompanhada${noCv != null ? `, registro do CV de ${noCv} dias atrás` : ''}`
                    + `${p.r.ato_pago ? ', ATO JÁ PAGO' : ''})`;
            });
            const corpo = [
                `${paraAvisar.length} venda(s) em "Envio Sienge" sem contrato no ERP.`,
                criticas.length ? `${criticas.length} crítica(s)${criticas.some(p => p.r.ato_pago) ? ' - há ato já pago sem contrato' : ''}.` : null,
                atrasadas.length ? `${atrasadas.length} atrasada(s) (acima de ${settings.dias_atraso} dias).` : null,
                '',
                ...linhas,
                paraAvisar.length > 10 ? `... e mais ${paraAvisar.length - 10}.` : null,
                '',
                'A fila do CV leva alguns dias; o que está aqui já passou desse prazo.',
                'Para destravar: abra a reserva no CV, corrija o que o painel apontar e devolva a etapa para Envio Sienge.',
            ].filter(Boolean).join('\n');

            await NotificationService.notify({
                type: NotificationType.SIENGE_ENVIO_PENDENTE,
                recipients: { users },
                title: criticas.length
                    ? `${criticas.length} venda(s) sem contrato no ERP - atenção`
                    : `${paraAvisar.length} venda(s) atrasadas para o ERP`,
                body: corpo,
                data: { criticas: criticas.length, atrasadas: atrasadas.length, reservas: paraAvisar.map(p => p.r.idreserva) },
                importance: criticas.length ? 8 : 5,
            }).catch(err => console.warn('[ENVIO_SIENGE_WATCH] notify falhou:', err?.message));
            resumo.avisados = paraAvisar.length;
        }

        for (const p of paraAvisar) {
            await p.item.update({ avisado_em: agora, avisado_severidade: p.severidade });
        }
    }

    resumo.took_s = ((Date.now() - t0) / 1000).toFixed(1);
    await settings.update({ last_run_at: agora, last_run_resumo: resumo });
    console.log(`[ENVIO_SIENGE_WATCH] ${JSON.stringify(resumo)}`);
    return resumo;
}

/** O que está aberto agora, para a tela e para conferência rápida. */
export async function listarPendencias({ severidade = null } = {}) {
    const where = { resolvido_em: null };
    if (severidade) where.severidade = severidade;
    return db.EnvioSiengeWatchItem.findAll({
        where,
        order: [['pendente_desde', 'ASC']],
    });
}

/**
 * Espera real observada, para recalibrar os limiares com dado nosso.
 * Os defaults saíram da distribuição do CV; com o tempo, esta é a fonte melhor.
 */
export async function estatisticas() {
    const [row] = await db.sequelize.query(`
        SELECT count(*) AS resolvidas,
               round(avg(espera_horas)) AS media_horas,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY espera_horas)) AS p50_horas,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY espera_horas)) AS p90_horas,
               max(espera_horas) AS max_horas
        FROM envio_sienge_watch_items
        WHERE resolvido_em IS NOT NULL AND espera_horas IS NOT NULL`,
        { type: db.Sequelize.QueryTypes.SELECT });
    const abertas = await db.EnvioSiengeWatchItem.count({ where: { resolvido_em: null } });
    return { ...row, abertas };
}

export default { runWatch, getSettings, listarPendencias, estatisticas };
