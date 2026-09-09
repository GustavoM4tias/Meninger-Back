// services/marketing/CvLeadDispatchService.js
//
// Despacha um inbound_lead para o CV CRM via POST /api/v1/comercial/leads.
//
// Contrato (ver doc CV — "Cadastra Leads"):
//  - identidade: email e/ou telefone (a deduplicação é feita pelo CV)
//  - origem (2 letras, imutável) = canal · midia (slug) = campanha/formulário
//  - idintegracao = nosso UUID (carimbo de origem / reconciliação)
//  - a resposta do POST traz `id` = idlead do CV → reconciliação imediata
//  - re-entrada (mesma pessoa de novo): permitir_alteracao + conversao
//  - idsituacao só é enviado no retorno por segundo interesse (ver
//    applySecondInterestReturn); no fluxo normal o CV usa "Início" sozinho
//
// Estados: routed/failed/rejected/dispatching → dispatching → resultado
//  - delivered: CV respondeu sucesso + id
//  - rejected:  CV recusou (HTTP 200 sucesso:false, ou HTTP 4xx) — ação manual
//  - failed:    erro transitório (rede/5xx) — re-tentado pelo scheduler com
//               backoff; esgotadas as tentativas → next_retry_at = null (dead-letter)

import { Op } from 'sequelize';
import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { recordLeadEvent } from './leadEventLog.js';
import MarketingConfigService from './MarketingConfigService.js';
import { decidirReconversao, idsDeInteresse, normalizarMesmoEmpreendimento } from '../../lib/leadReturnRule.js';
import { classifySituacao, situacaoInicio, FAIXA } from './cvLeadWorkflow.js';
import { resolveFila } from './CvLeadQueueService.js';
import { readLiveLead, distribuirPeloOffice } from './CvLeadReturnService.js';

const { InboundLead } = db;

const RETRY_BASE_MS = 2 * 60 * 1000;        // 2 min
const RETRY_CAP_MS  = 2 * 60 * 60 * 1000;   // 2 h
const DISPATCHABLE  = ['routed', 'failed', 'rejected', 'dispatching'];

// Acessos à config (DB com fallback pro .env) — cache de 30s dentro do service.
async function getCfg() {
    try { return await MarketingConfigService.getConfig(); }
    catch { return null; }
}
async function isDryRun() {
    const cfg = await getCfg();
    if (cfg) return !!cfg.dry_run;
    return process.env.MARKETING_CAPTURE_DRY_RUN === 'true';
}
async function getMaxAttempts() {
    const cfg = await getCfg();
    return cfg?.retry_max_attempts || Number(process.env.MARKETING_DISPATCH_MAX_ATTEMPTS) || 6;
}
// Retorno automático por segundo interesse. Nasce ligado porque é a regra de
// negócio pedida, mas é chave de tela: mexe em dono de lead, e operação precisa
// poder desligar sem deploy.
async function isAutoReturnOn() {
    const cfg = await getCfg();
    if (cfg && cfg.lead_return_auto != null) return !!cfg.lead_return_auto;
    return process.env.MARKETING_LEAD_RETURN_AUTO !== 'false';
}

// O que fazer quando a nova conversão é no MESMO empreendimento que a pessoa já
// tem de interesse. Ver MarketingConfigService.MESMO_EMPREENDIMENTO.
async function getPoliticaMesmoEmpreendimento() {
    const cfg = await getCfg();
    if (cfg?.lead_return_mesmo_empreendimento) return normalizarMesmoEmpreendimento(cfg.lead_return_mesmo_empreendimento);
    return normalizarMesmoEmpreendimento(process.env.MARKETING_LEAD_RETURN_MESMO_EMPREENDIMENTO);
}

async function getCvLeadsEndpoint() {
    const cfg = await getCfg();
    return cfg?.cv_leads_endpoint || process.env.CV_LEADS_ENDPOINT || '/v1/comercial/leads';
}

// Backoff exponencial: 2, 4, 8, 16... min (limitado a 2h).
function backoffMs(attempts) {
    return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);
}

// ── Conversão ───────────────────────────────────────────────────────────────
// Nome da conversão que aparece no CV. Sem o campo `conversao` no POST o CV
// carimba "Painel Gestor" (como se fosse cadastro manual). Usamos o nome do
// formulário onde a pessoa converteu (mais específico); fallback mídia/canal.
async function resolveConversaoName(lead) {
    try {
        if (lead.meta_form_id && db.MetaLeadForm) {
            const f = await db.MetaLeadForm.findByPk(String(lead.meta_form_id), { attributes: ['name'] });
            if (f?.name) return f.name;
        }
        if (lead.source_form_id && db.LeadForm) {
            const f = await db.LeadForm.findByPk(lead.source_form_id, { attributes: ['name'] });
            if (f?.name) return f.name;
        }
    } catch { /* cai no fallback */ }
    return lead.midia_slug || lead.channel || null;
}

// ── Re-entrada ──────────────────────────────────────────────────────────────
// Mesma pessoa (email/telefone) que já foi entregue antes NÃO é duplicata —
// é uma nova conversão. Não confundir com spam.
async function detectReentry(lead) {
    const or = [];
    if (lead.email)    or.push({ email: lead.email });
    if (lead.telefone) or.push({ telefone: lead.telefone });
    if (!or.length) return false;
    const prior = await InboundLead.findOne({
        where: {
            id: { [Op.ne]: lead.id },
            status: 'delivered',
            [Op.or]: or,
        },
        attributes: ['id'],
    });
    return !!prior;
}

// ── Monta o JSON do CV ──────────────────────────────────────────────────────

/**
 * Constrói a interação que carrega os campos custom do lead pro CV.
 *
 * O CV CRM aceita `interacoes` no POST de criação — array de objetos com pelo
 * menos `descricao` (texto livre). É onde colocamos respostas a perguntas
 * que não têm coluna direta no CV (renda? quando pretende comprar? interesse?).
 *
 * Formato:
 *   "📋 Cadastro automático via Office (Meta Lead Ads)
 *    Campanha: 120239301852500414
 *    Formulário: 1105807337686348
 *
 *    Respostas:
 *    - Renda familiar: R$ 5.000
 *    - Tem interesse em qual unidade: 2 dorms
 *    - Quando pretende comprar: Em até 6 meses"
 */
function buildInteracaoExtras(lead) {
    const extras = lead.extra_fields && typeof lead.extra_fields === 'object'
        ? Object.entries(lead.extra_fields).filter(([_, v]) => v != null && v !== '')
        : [];

    // Sem campos extras e sem contexto → não envia interação.
    const hasContext = lead.meta_campaign_id || lead.meta_form_id || lead.channel === 'meta_lead_ads';
    if (!extras.length && !hasContext) return null;

    const lines = [];
    lines.push(`📋 Cadastro automático via Office`);

    if (lead.channel === 'meta_lead_ads') lines.push('Origem: Meta Lead Ads');
    if (lead.meta_campaign_id) lines.push(`Campanha: ${lead.meta_campaign_id}`);
    if (lead.meta_form_id)     lines.push(`Formulário: ${lead.meta_form_id}`);
    if (lead.meta_ad_id)       lines.push(`Anúncio: ${lead.meta_ad_id}`);
    if (lead.midia_slug)       lines.push(`Mídia: ${lead.midia_slug}`);

    if (extras.length) {
        lines.push('');
        lines.push('Respostas do formulário:');
        for (const [k, v] of extras) {
            const val = Array.isArray(v) ? v.join(', ') : String(v);
            lines.push(`- ${k}: ${val}`);
        }
    }

    return {
        descricao: lines.join('\n'),
        // Tipo opcional — o CV usa "Observação" como default quando não vem idtipo.
        ...(process.env.CV_INTERACAO_IDTIPO ? { idtipo: Number(process.env.CV_INTERACAO_IDTIPO) } : {}),
    };
}

// ── Quem já é lead no CV ────────────────────────────────────────────────────
// Lê a pessoa para saber em que etapa ela está, o que já é interesse dela e
// quem atende hoje. Só serve ao retorno por segundo interesse — o resto do
// comportamento do CV (reativação, troca de atendente) fica como sempre foi.
async function resolveRetorno(lead, payload) {
    let mirror;
    try {
        mirror = await findCvMirrorLead(lead);
    } catch (err) {
        console.warn(`[marketing-capture] não deu para ler o espelho do lead ${lead.id}: ${err.message}`);
        return null;
    }
    if (!mirror) return null;   // pessoa nova no CV: não há interesse anterior

    const estado = await lerEstadoNoCv(mirror);

    // Nome primeiro: o id do espelho mente para Descartado (ver cvLeadWorkflow).
    const situacao = await classifySituacao({ id: estado.situacao_id, nome: estado.situacao_nome });

    // Etapa de qualificação em diante não se mexe.
    if (situacao.faixa === FAIXA.BLINDADO) {
        return { ...situacao, fonte: estado.fonte, acao: 'etapa_qualificada' };
    }

    return {
        ...situacao,
        fonte: estado.fonte,
        ...(await applySecondInterestReturn(lead, payload, estado, situacao)),
    };
}

/** Nome de corretor/imobiliária: o CV devolve ora objeto, ora string solta. */
function nomeDe(json) {
    if (!json) return null;
    if (typeof json === 'string') return json.trim() || null;
    return json.nome || json.name || null;
}

/**
 * Estado atual da pessoa no CV: etapa, interesses e dono.
 *
 * POR QUE NÃO BASTA O ESPELHO (incidente de 09/09/2026): a tabela `leads`
 * sincroniza a cada 30 min (scheduler/leadCvScheduler.js) e meia hora é tempo de
 * sobra para a mesma pessoa converter duas vezes. Espelho atrasado faz o
 * interesse que ela JÁ tem parecer novo — e era isso que devolvia à fila cliente
 * que já estava em atendimento no MESMO empreendimento, tirando o lead de quem
 * estava falando com ele. Então a decisão lê o lead AO VIVO e só cai no espelho
 * quando o CV não responde (a decisão registra em `fonte` quem decidiu).
 *
 * Duas escolhas de direção segura:
 *   interesses — UNIÃO do ao vivo com o espelho. Interesse não é removido por
 *                este fluxo (só pelo painel Gestor), então somar as duas listas
 *                nunca inventa interesse e protege contra formato de item que a
 *                leitura ao vivo devolva diferente do esperado.
 *   dono       — o ao vivo MANDA quando respondeu, inclusive para dizer "não tem
 *                dono". O eco do POST mente sobre dono (ver CvLeadReturnService),
 *                mas a leitura ao vivo é a verdade; o espelho só entra quando o
 *                CV não respondeu.
 */
async function lerEstadoNoCv(mirror) {
    const doEspelho = {
        idlead: Number(mirror.idlead),
        situacao_id: mirror.situacao_id ?? null,
        situacao_nome: mirror.situacao_nome || null,
        interesses: idsDeInteresse(mirror.empreendimento),
        corretor: nomeDe(mirror.corretor),
        imobiliaria: nomeDe(mirror.imobiliaria),
        fonte: 'espelho',
    };

    const vivo = await readLiveLead(mirror.idlead);
    if (!vivo) return doEspelho;

    return {
        idlead: Number(mirror.idlead),
        situacao_id: vivo.situacao?.id != null ? Number(vivo.situacao.id) : doEspelho.situacao_id,
        situacao_nome: vivo.situacao?.nome || doEspelho.situacao_nome,
        interesses: [...new Set([...idsDeInteresse(vivo.empreendimento), ...doEspelho.interesses])],
        corretor: nomeDe(vivo.corretor),
        imobiliaria: nomeDe(vivo.imobiliaria),
        fonte: 'cv_ao_vivo',
    };
}

// ── Retorno por segundo interesse ───────────────────────────────────────────
// Pessoa que JÁ é lead no CV converte de novo, agora num empreendimento que ela
// ainda não tinha: o corretor que a atende hoje foi escalado para outro produto,
// às vezes em outra praça. Fora das etapas de qualificação, o lead volta para o
// começo e é redistribuído pela fila do empreendimento novo.
//
// Vai tudo no MESMO POST do despacho: o `idempreendimento` já adiciona o
// interesse, então soltar o dono e voltar a etapa junto evita uma segunda
// chamada e o intervalo em que o lead ficaria meio movido.
//
// MESMO EMPREENDIMENTO NÃO É SEGUNDO INTERESSE (regra de 09/09/2026): quem já
// está em atendimento e volta a converter no mesmo produto só tem o interesse
// marcado e segue com quem atende. A política é de tela
// (lead_return_mesmo_empreendimento):
//   manter_com_dono (padrão) — tem corretor/imobiliária? mantém. Sem dono vai
//                              para a fila, porque lead solto precisa de dono.
//   manter_sempre            — nunca devolve no mesmo empreendimento.
//   devolver                 — devolve sempre (comportamento anterior à regra).
//
// Duas recusas, cada uma por um motivo medido:
//   - sem fila resolvida não mexe. O CV represa em silêncio quando não acha
//     fila compatível, e aí o lead fica sem etapa E sem dono. O vínculo
//     empreendimento -> fila é por id e declarado na tela (CvLeadQueueService).
//   - mais de um empreendimento na mesma conversão não tem fila única de
//     destino, então não há para onde devolver.
async function applySecondInterestReturn(lead, payload, estado, situacao) {
    if (!(await isAutoReturnOn())) return { acao: 'auto_desligado' };

    const novos = Array.isArray(lead.bound_empreendimentos) ? lead.bound_empreendimentos.map(Number) : [];
    if (novos.length !== 1) return { acao: novos.length ? 'multiplos_empreendimentos' : 'sem_empreendimento' };
    const alvo = novos[0];

    const dono = { corretor: estado.corretor, imobiliaria: estado.imobiliaria };
    const temDono = !!(estado.corretor || estado.imobiliaria);

    const decisao = decidirReconversao({
        interesses: estado.interesses,
        alvo,
        temDono,
        politica: await getPoliticaMesmoEmpreendimento(),
    });

    if (decisao.manter) {
        marcarInteresseSemDevolver(payload, { alvo, estado, situacao });
        console.log(`[marketing-capture] lead ${lead.id}: reconversão no mesmo empreendimento (${alvo}) em "${situacao.nome || estado.situacao_nome}" — mantido com ${estado.corretor || estado.imobiliaria || 'quem já tinha o lead'}.`);
        return {
            acao: 'atendimento_mantido',
            empreendimento: alvo,
            politica: decisao.politica,
            motivo: decisao.motivo,
            fonte: estado.fonte,
            dono,
            sem_dono: !temDono,
        };
    }

    // Sobrou devolver: interesse realmente novo, a operação escolheu 'devolver',
    // ou é o mesmo empreendimento mas SEM dono - e aí a fila é o que dá dono.
    const motivo = decisao.motivo;

    const fila = await resolveFila(alvo);
    if (!fila) {
        console.warn(`[marketing-capture] lead ${lead.id}: empreendimento ${alvo} precisa de fila (${motivo}) e não tem vínculo — retorno não aplicado.`);
        return { acao: 'sem_fila', empreendimento: alvo, motivo };
    }

    let inicio;
    try {
        inicio = await situacaoInicio();
    } catch (err) {
        console.warn(`[marketing-capture] lead ${lead.id}: sem situação de Início no CV (${err.message}) — retorno não aplicado.`);
        return { acao: 'sem_situacao_inicio' };
    }

    payload.idsituacao = inicio.id;
    payload.remover_imobiliaria = true;
    payload.remover_corretor = true;
    payload.lead_utilizar_fila = true;
    payload.idfila_distribuicao_leads = fila.idfila;
    // NENHUMA combinação destes campos faz o CV associar corretor (medido em
    // 28/08/2026, leads 35091/34987: mesmo com o forcar o lead vai para
    // "Aguardando Atendimento Corretor" e fica sem dono). Eles continuam indo
    // porque registram a fila no painel do CV; quem garante o dono é o
    // conferirDistribuicao, que aciona o rodízio do Office quando a releitura
    // mostra o lead solto.
    payload.forcar_distribuicao_lead = true;

    console.log(`[marketing-capture] lead ${lead.id}: ${motivo} (${alvo}) em etapa "${situacao.nome}" — devolvendo para ${fila.nome}.`);
    return {
        acao: 'retornado',
        motivo,
        empreendimento: alvo,
        fonte: estado.fonte,
        fila: { id: fila.idfila, nome: fila.nome, origem: fila.origem },
        de_situacao: situacao.nome,
        para_situacao: inicio.nome,
        dono_anterior: dono,
    };
}

/**
 * Reconversão que NÃO devolve: o POST segue só com o `idempreendimento` (que é
 * aditivo e marca o interesse) e sem nenhum campo de devolução — nada de
 * idsituacao, remover_corretor/imobiliaria ou fila. A interação registra no CV
 * que houve conversão nova, para o corretor ver o movimento sem perder o lead.
 */
function marcarInteresseSemDevolver(payload, { alvo, estado, situacao }) {
    const donoTexto = estado.corretor || estado.imobiliaria || null;
    const linhas = [
        'Nova conversao no MESMO empreendimento de interesse - atendimento mantido pelo Office.',
        `Empreendimento: ${alvo}`,
        `Etapa atual: ${situacao.nome || estado.situacao_nome || 'nao identificada'}`,
        donoTexto ? `Segue em atendimento com: ${donoTexto}` : 'Lead sem corretor associado no momento da conversao.',
        'O lead NAO foi devolvido a fila: a regra do Office mantem quem ja atende quando a conversao e no mesmo empreendimento.',
    ];
    const texto = linhas.join('\n');

    const atuais = Array.isArray(payload.interacoes) ? [...payload.interacoes] : [];
    if (atuais.length) {
        atuais[0] = { ...atuais[0], descricao: `${atuais[0].descricao}\n\n${texto}` };
        payload.interacoes = atuais;
        return;
    }
    // Interação SOLTA (lead sem campos extras nem contexto de campanha) vai no
    // formato que já é aceito em produção pelo CvLeadReturnService: `tipo` junto
    // com `descricao` (doc CV 2.10, 'A' = Anotação). Interação recusada derruba
    // o POST inteiro, e aí o lead ficaria `rejected` por causa de uma anotação.
    payload.interacoes = [{
        tipo: process.env.CV_INTERACAO_TIPO || 'A',
        descricao: texto,
    }];
}

/**
 * Acha a pessoa no espelho de leads do CV por email ou telefone.
 * Normaliza dos dois lados: o espelho guarda telefone como "+5514996724204" e
 * email às vezes em CAIXA ALTA.
 */
async function findCvMirrorLead(lead) {
    const email = lead.email ? String(lead.email).trim().toLowerCase() : null;
    const digits = lead.telefone ? String(lead.telefone).replace(/\D/g, '') : null;
    if (!email && !digits) return null;

    const [row] = await db.sequelize.query(
        `SELECT idlead, situacao_id, situacao_nome, empreendimento, corretor, imobiliaria
           FROM leads
          WHERE (CAST(:email AS text) IS NOT NULL AND lower(email) = :email)
             OR (CAST(:digits AS text) IS NOT NULL AND regexp_replace(coalesce(telefone, ''), '\\D', '', 'g') = :digits)
          ORDER BY updated_at DESC
          LIMIT 1`,
        { replacements: { email, digits }, type: db.sequelize.QueryTypes.SELECT },
    );
    return row || null;
}

function buildCvPayload(lead) {
    const p = {
        permitir_alteracao: true,   // cria-ou-atualiza: o CV deduplica por email/telefone
        idintegracao: lead.id,      // nosso UUID → reconciliação
    };

    if (lead.email) p.email = lead.email;
    if (lead.telefone) {
        p.telefone = lead.telefone;
        if (lead.telefone_ddi) p.telefone_ddi = lead.telefone_ddi;
    }
    if (lead.nome)       p.nome   = lead.nome;
    if (lead.midia_slug) p.midia  = lead.midia_slug;
    if (lead.cv_origem)  p.origem = lead.cv_origem;

    if (Array.isArray(lead.bound_empreendimentos) && lead.bound_empreendimentos.length) {
        p.idempreendimento = lead.bound_empreendimentos;
    }
    if (Array.isArray(lead.tags) && lead.tags.length) {
        p.tags = lead.tags;
    }
    if (lead.documento) {
        p.documento = lead.documento;
        if (lead.documento_tipo) p.documento_tipo = lead.documento_tipo;
    }
    if (lead.sexo)           p.sexo           = lead.sexo;
    if (lead.renda_familiar) p.renda_familiar = lead.renda_familiar;
    if (lead.cep)            p.cep            = lead.cep;
    if (lead.endereco)       p.endereco       = lead.endereco;
    if (lead.numero)         p.numero         = lead.numero;
    if (lead.complemento)    p.complemento    = lead.complemento;
    if (lead.bairro)         p.bairro         = lead.bairro;
    // estado/cidade exigem idestado/idcidade do CV — mapeamento de IDs em fase posterior.

    if (lead.channel === 'meta_lead_ads') {
        p.integracao = 'FB';
        if (lead.meta_form_id) p.idformulario = lead.meta_form_id;
    }

    // Sempre enviar — sem `conversao` o CV registra o default "Painel Gestor".
    if (lead.conversao_name) {
        p.conversao = lead.conversao_name;
    }

    // ── Interações: leva pro CV o que não tem coluna direta ─────────────────
    // Campos custom do form (extra_fields) + contexto (campanha/anúncio) viram
    // uma interação inicial no lead, visível pra equipe comercial no CV.
    const interacao = buildInteracaoExtras(lead);
    if (interacao) {
        p.interacoes = [interacao];
    }

    return p;
}

// ── Despacho ────────────────────────────────────────────────────────────────
/**
 * Envia um inbound_lead ao CV CRM. Idempotente quanto a status: só processa
 * leads despacháveis (routed/failed/rejected/dispatching).
 * @param {string|object} leadOrId  UUID ou a instância InboundLead
 */
/**
 * Monta o que seria enviado ao CV para este lead, sem enviar.
 * É o mesmo caminho que o dispatch usa, exposto para a tela poder mostrar
 * "o que vai acontecer" antes de acontecer — e para dar como testar a regra de
 * retorno sem escrever no CRM.
 *
 * @returns {Promise<{payload:object, decisao:?object}>}
 */
export async function buildDispatchPlan(lead) {
    const payload = buildCvPayload(lead);
    const decisao = await resolveRetorno(lead, payload);
    return { payload, decisao };
}

export async function dispatchLead(leadOrId, { actor = 'system' } = {}) {
    const lead = typeof leadOrId === 'string'
        ? await InboundLead.findByPk(leadOrId)
        : leadOrId;

    if (!lead) throw new Error(`inbound_lead não encontrado: ${leadOrId}`);

    if (!DISPATCHABLE.includes(lead.status)) {
        return { skipped: true, reason: `status "${lead.status}" não é despachável` };
    }

    // Re-entrada: detecta antes de montar o payload.
    if (!lead.is_reentry && await detectReentry(lead)) {
        lead.is_reentry = true;
        await recordLeadEvent({
            leadId: lead.id, type: 'reentry_detected', actor,
            message: 'Lead já existe na base — tratado como nova conversão (não é spam).',
        });
    }

    // Nome da conversão (form > mídia > canal) — vale pra lead novo e re-entrada.
    if (!lead.conversao_name) {
        lead.conversao_name = await resolveConversaoName(lead);
    }

    const { payload, decisao } = await buildDispatchPlan(lead);
    const fromStatus = lead.status;

    lead.status             = 'dispatching';
    lead.dispatch_attempts  = (lead.dispatch_attempts || 0) + 1;
    lead.last_dispatch_at   = new Date();
    lead.cv_request_payload = payload;
    await lead.save();

    const dryRun = await isDryRun();
    await recordLeadEvent({
        leadId: lead.id, type: 'dispatch_attempt', actor,
        statusFrom: fromStatus, statusTo: 'dispatching',
        message: `Tentativa ${lead.dispatch_attempts} de envio ao CV.`,
        detail: {
            dry_run: dryRun,
            ...(decisao ? { situacao_no_cv: decisao.nome, faixa: decisao.faixa, acao: decisao.acao, fonte: decisao.fonte } : {}),
            ...(decisao?.acao === 'retornado' ? { retorno: decisao } : {}),
            ...(decisao?.acao === 'atendimento_mantido' ? { atendimento_mantido: decisao } : {}),
        },
    });

    // Modo sombra: pipeline completo, sem POST. O lead volta a 'routed'.
    if (dryRun) {
        lead.status = 'routed';
        lead.last_error = null;
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'dry_run', actor,
            statusFrom: 'dispatching', statusTo: 'routed',
            message: 'Modo sombra ativo — POST ao CV não realizado.',
            detail: { payload },
        });
        console.log(`🌓 [marketing-capture] dry-run — lead ${lead.id} não enviado ao CV.`);
        return { dryRun: true };
    }

    try {
        const endpoint = await getCvLeadsEndpoint();
        const res  = await apiCv.post(endpoint, payload);
        const body = res?.data || {};

        if (body.sucesso === true && body.id != null) {
            const r = await markDelivered(lead, body, actor);
            if (decisao?.acao === 'retornado') await conferirDistribuicao(lead, decisao, actor);
            else if (decisao?.acao === 'atendimento_mantido') await registrarAtendimentoMantido(lead, decisao, actor);
            return r;
        }
        // HTTP 200 mas sucesso:false → recusa lógica do CV.
        return await markRejected(lead, body, `CV recusou: ${body.mensagem || 'sem mensagem'}`, actor);
    } catch (err) {
        const resp = err?.response;
        if (resp && resp.status >= 400 && resp.status < 500) {
            // 4xx — requisição inválida; re-tentar não resolve.
            return await markRejected(lead, resp.data, `CV retornou HTTP ${resp.status}.`, actor);
        }
        // 5xx / rede / timeout — falha transitória.
        return await markFailed(lead, err, actor);
    }
}

// Reconversão no mesmo empreendimento que ficou com quem já atendia. Vira evento
// próprio porque a timeline do lead é onde a operação confere o "por que esse
// lead não foi redistribuído" - sem isso, o desfecho ficaria só no log.
async function registrarAtendimentoMantido(lead, decisao, actor) {
    const dono = decisao.dono?.corretor || decisao.dono?.imobiliaria || null;
    await recordLeadEvent({
        leadId: lead.id,
        type: 'atendimento_mantido',
        actor,
        message: dono
            ? `Reconversão no mesmo empreendimento (${decisao.empreendimento}): interesse marcado e atendimento mantido com ${dono}.`
            : `Reconversão no mesmo empreendimento (${decisao.empreendimento}): interesse marcado, lead mantido onde estava (sem corretor associado).`,
        detail: {
            empreendimento: decisao.empreendimento,
            politica: decisao.politica,
            fonte: decisao.fonte,
            dono: decisao.dono,
            situacao: decisao.nome || null,
        },
    });
}

// A API não conta se a fila está ativa nem quem está nela por grupo, então não
// dá para prever se a entrega vai ser distribuída. Depois de um retorno a gente
// confere lendo o lead ao vivo — e, como o CV NÃO distribui lead devolvido por
// API em nenhuma combinação de campos (medido 28/08/2026, leads 35091/34987:
// ele move para "Aguardando Atendimento Corretor" e ninguém é associado), lead
// sem dono aqui não é espera, é defeito: o rodízio do Office assume e associa o
// próximo corretor da fila. Só vira alerta se nem isso funcionar.
async function conferirDistribuicao(lead, retorno, actor) {
    try {
        const vivo = await readLiveLead(lead.cv_idlead);
        let corretor = vivo?.corretor?.nome || null;
        let imobiliaria = vivo?.imobiliaria?.nome || null;
        let modo = 'fila_cv';

        if (!corretor && !imobiliaria) {
            const rodizio = await distribuirPeloOffice({
                idlead: lead.cv_idlead,
                idfila: retorno.fila.id,
                email: lead.email,
                telefone: lead.telefone,
            });
            if (rodizio) {
                corretor = rodizio.corretor;
                imobiliaria = rodizio.imobiliaria;
                modo = 'rodizio_office';
            }
        }

        const distribuido = !!(corretor || imobiliaria);
        await recordLeadEvent({
            leadId: lead.id,
            type: distribuido ? 'retorno_distribuido' : 'retorno_represado',
            actor,
            message: distribuido
                ? (modo === 'rodizio_office'
                    ? `Devolvido para ${retorno.fila.nome}; o CV não distribuiu e o rodízio do Office associou ${corretor || imobiliaria}.`
                    : `Devolvido para ${retorno.fila.nome} e atribuído a ${corretor || imobiliaria}.`)
                : `Devolvido para ${retorno.fila.nome}, mas o CV não atribuiu ninguém — lead sem dono.`,
            detail: { fila: retorno.fila, corretor, imobiliaria, modo, situacao: vivo?.situacao || null },
        });

        if (!distribuido) {
            console.warn(`[marketing-capture] lead ${lead.id} (CV ${lead.cv_idlead}) devolvido para "${retorno.fila.nome}" e ficou SEM DONO.`);
            await alertarRepresado(lead, retorno);
        }
    } catch (err) {
        console.error(`[marketing-capture] falha ao conferir distribuição do lead ${lead.id}: ${err.message}`);
    }
}

async function alertarRepresado(lead, retorno) {
    try {
        const userIds = await MarketingConfigService.getAlertRecipients();
        if (!userIds.length) return;
        await NotificationService.notify({
            type: NotificationType.LEAD_DISPATCH_FAILED,
            recipients: { users: userIds },
            title: 'Lead voltou para a fila e ninguém pegou',
            body: `"${lead.nome || lead.email || lead.telefone}" foi devolvido para ${retorno.fila.nome} e o CV não atribuiu corretor. Confira se a fila está ativa.`,
            data: { inbound_lead_id: lead.id, cv_idlead: lead.cv_idlead, fila: retorno.fila },
            link: `/marketing/captacao?lead=${lead.id}`,
            importance: 7,
        });
    } catch (err) {
        console.error(`[marketing-capture] falha ao alertar retorno represado do lead ${lead.id}: ${err.message}`);
    }
}

async function markDelivered(lead, body, actor) {
    lead.status         = 'delivered';
    lead.cv_idlead      = String(body.id);
    lead.cv_situacao_id = body.idsituacao != null ? Number(body.idsituacao) : null;
    lead.cv_response    = body;
    lead.last_error     = null;
    lead.error_code     = null;
    lead.next_retry_at  = null;
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'cv_delivered', actor,
        statusFrom: 'dispatching', statusTo: 'delivered',
        message: `Lead criado no CV — idlead ${body.id}.`,
        detail: { codigo: body.codigo, mensagem: body.mensagem, idsituacao: body.idsituacao },
    });
    console.log(`✅ [marketing-capture] lead ${lead.id} entregue ao CV (idlead ${body.id}).`);
    return { delivered: true, cvIdlead: lead.cv_idlead };
}

async function markRejected(lead, cvBody, message, actor) {
    lead.status        = 'rejected';
    lead.cv_response   = cvBody || null;
    lead.last_error    = message;
    lead.error_code    = cvBody?.codigo != null ? `cv_${cvBody.codigo}` : 'cv_rejected';
    lead.next_retry_at = null;
    await lead.save();
    await recordLeadEvent({
        leadId: lead.id, type: 'cv_rejected', actor,
        statusFrom: 'dispatching', statusTo: 'rejected',
        message,
        detail: { cv_response: cvBody },
    });
    console.warn(`⛔ [marketing-capture] lead ${lead.id} recusado pelo CV: ${message}`);
    return { rejected: true };
}

async function markFailed(lead, err, actor) {
    const maxAttempts = await getMaxAttempts();
    const deadLetter = lead.dispatch_attempts >= maxAttempts;
    lead.status        = 'failed';
    lead.last_error    = (err?.message || 'erro desconhecido').slice(0, 1000);
    lead.error_code    = err?.response?.status ? `http_${err.response.status}` : (err?.code || 'network_error');
    lead.cv_response   = err?.response?.data || null;
    lead.next_retry_at = deadLetter ? null : new Date(Date.now() + backoffMs(lead.dispatch_attempts));
    await lead.save();

    if (deadLetter) {
        await recordLeadEvent({
            leadId: lead.id, type: 'dead_letter', actor,
            statusFrom: 'dispatching', statusTo: 'failed',
            message: `Falha definitiva após ${lead.dispatch_attempts} tentativas — requer ação manual.`,
            detail: { last_error: lead.last_error, error_code: lead.error_code },
        });
        console.error(`💀 [marketing-capture] lead ${lead.id} em dead-letter após ${lead.dispatch_attempts} tentativas.`);
        await alertDeadLetter(lead);
    } else {
        await recordLeadEvent({
            leadId: lead.id, type: 'dispatch_failed', actor,
            statusFrom: 'dispatching', statusTo: 'failed',
            message: `Falha transitória (tentativa ${lead.dispatch_attempts}) — re-tentativa agendada.`,
            detail: { last_error: lead.last_error, next_retry_at: lead.next_retry_at },
        });
        console.warn(`⚠️  [marketing-capture] lead ${lead.id} falhou (tentativa ${lead.dispatch_attempts}); retry em ${lead.next_retry_at?.toISOString()}.`);
    }
    return { failed: true, deadLetter };
}

// ── Alerta de dead-letter ───────────────────────────────────────────────────
// Avisa os admins quando um lead não consegue ser entregue ao CRM.
async function alertDeadLetter(lead) {
    try {
        const userIds = await MarketingConfigService.getAlertRecipients();
        if (!userIds.length) return;

        await NotificationService.notify({
            type: NotificationType.LEAD_DISPATCH_FAILED,
            recipients: { users: userIds },
            title: 'Lead não entregue ao CRM',
            body: `O lead "${lead.nome || lead.email || lead.telefone || lead.id}" falhou ${lead.dispatch_attempts}x ao ser enviado ao CV e precisa de ação manual.`,
            data: { inbound_lead_id: lead.id, last_error: lead.last_error, error_code: lead.error_code },
            link: `/marketing/captacao?lead=${lead.id}`,
            importance: 8,
        });
    } catch (err) {
        console.error(`❌ [marketing-capture] falha ao alertar dead-letter do lead ${lead.id}: ${err.message}`);
    }
}

export default { dispatchLead, buildDispatchPlan };
