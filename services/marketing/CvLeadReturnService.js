// services/marketing/CvLeadReturnService.js
//
// Devolve à fila um lead que JÁ EXISTE no CV e voltou a converter, agora com
// outro empreendimento de interesse.
//
// Só existe uma porta de escrita em lead no CV: o mesmo
// `POST /v1/comercial/leads` que o dispatch usa. As rotas dedicadas
// (/v1/cvbot/lead/{id}/alterar_situacao, alterar_corretor, alterar_fila,
// distribuir) respondem 405 — não existem. O que faz o lead voltar são campos
// do corpo desse POST (doc CV, seções 2.2 e 2.5):
//
//   idsituacao                     leva o lead para a situação de Início
//   remover_imobiliaria/corretor   solta o dono atual
//   lead_utilizar_fila             deixa a fila de distribuição pegar o lead
//   idempreendimento               ADICIONA o interesse novo
//
// Três limites que este serviço não contorna:
//
//   1. Não TROCA o interesse, adiciona. `idempreendimento` é aditivo (doc 2.3)
//      e a rota alterar_empreendimento devolve 400 quando já está associado.
//      O interesse antigo continua no lead; remover, só pelo painel Gestor.
//   2. Sem `idfila` NÃO adianta contar com o CV para achar a fila. Medido em
//      26/08/2026 no lead 12361: com lead_utilizar_fila e depois com
//      forcar_distribuicao_lead, o protocolo do CV registrou "Lead não
//      encontrou uma fila compatível e foi represado" — a distribuição rodou e
//      não teve para quem dar (o lead tem 8 interesses em 4 cidades, nenhuma
//      regra de fila casa). E `idfila` sozinho também não basta: medido em
//      28/08/2026 no lead 10685, em edição de lead existente o CV registra a
//      fila mas só roda o motor com forcar_distribuicao_lead junto. É o par
//      idfila + forçar que garante atendimento. As filas saem de listFilas().
//   3. Não desfaz. Situação e dono novos não voltam por API — o estado anterior
//      fica em `antes`, na resposta e no evento, para refazer à mão no painel.
//
// A trava é a faixa (services/marketing/cvLeadWorkflow.js): lead em etapa
// BLINDADA (Lead Qualificado em diante) não volta para fila nenhuma, porque
// devolver é tirar de quem está fechando.

import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';
import { recordLeadEvent } from './leadEventLog.js';
import MarketingConfigService from './MarketingConfigService.js';
import { classifySituacao, situacaoInicio, FAIXA } from './cvLeadWorkflow.js';

const { InboundLead, Lead } = db;

async function getCvLeadsEndpoint() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        if (cfg?.cv_leads_endpoint) return cfg.cv_leads_endpoint;
    } catch { /* cai no env */ }
    return process.env.CV_LEADS_ENDPOINT || '/v1/comercial/leads';
}

async function isDryRunGlobal() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        if (cfg) return !!cfg.dry_run;
    } catch { /* cai no env */ }
    return process.env.MARKETING_CAPTURE_DRY_RUN === 'true';
}

function nomeDe(json) {
    if (!json) return null;
    if (typeof json === 'string') return json;
    return json.nome || json.name || null;
}

function interessesDe(lead) {
    const arr = Array.isArray(lead?.empreendimento) ? lead.empreendimento : [];
    // O espelho guarda [{ id, nome }] — nao `idempreendimento`.
    return arr.map(e => ({
        id: e?.id != null ? Number(e.id) : (e?.idempreendimento != null ? Number(e.idempreendimento) : null),
        nome: e?.nome || null,
    }));
}

/** Retrato do lead antes de mexer — é o que permite refazer à mão se der errado. */
function retrato(lead, situacao) {
    return {
        idlead: Number(lead.idlead),
        nome: lead.nome,
        email: lead.email,
        telefone: lead.telefone,
        situacao: {
            id: lead.situacao_id,
            nome: lead.situacao_nome,
            ordem: situacao?.ordem ?? null,
            faixa: situacao?.faixa ?? null,
        },
        imobiliaria: nomeDe(lead.imobiliaria),
        corretor: nomeDe(lead.corretor),
        interesses: interessesDe(lead),
        data_vencimento: lead.data_vencimento,
        ultima_data_conversao: lead.ultima_data_conversao,
    };
}

function montarInteracao({ idempreendimento, empreendimentoNome, conversao, motivo }) {
    const linhas = ['Retorno de lead registrado pelo Office'];
    linhas.push(`Novo interesse: ${empreendimentoNome || 'empreendimento ' + idempreendimento}`);
    if (conversao) linhas.push(`Conversão: ${conversao}`);
    if (motivo) linhas.push(`Motivo: ${motivo}`);
    linhas.push('');
    linhas.push('A pessoa voltou a converter em campanha e foi devolvida à fila de distribuição.');
    return {
        // `tipo` é obrigatório junto com `descricao` (doc CV 2.10). 'A' = Anotação.
        tipo: process.env.CV_INTERACAO_TIPO || 'A',
        descricao: linhas.join('\n'),
    };
}

/**
 * Monta (e opcionalmente envia) a devolução de um lead à fila.
 *
 * @param {object}  p
 * @param {number}  p.idlead              idlead no CV
 * @param {number}  p.idempreendimento    empreendimento de interesse novo
 * @param {string}  [p.conversao]         nome da conversão (campanha/formulário)
 * @param {string}  [p.midia]             slug da mídia
 * @param {string}  [p.origem]            código de 2 letras (FB, IG, ...)
 * @param {string}  [p.motivo]            texto livre que vai para a interação
 * @param {number}  [p.idfila]            fila de destino (listFilas()); sem ela o
 *                                        CV avalia as regras dele e pode represar
 * @param {boolean} [p.dryRun=true]       true = só monta o payload, não envia
 * @param {boolean} [p.forcarDistribuicao=false]  manda forcar_distribuicao_lead
 * @param {boolean} [p.force=false]       ignora a trava de faixa blindada
 * @param {string}  [p.actor='system']
 */
export async function returnLeadToQueue({
    idlead,
    idempreendimento,
    conversao = null,
    midia = null,
    origem = null,
    motivo = null,
    idfila = null,
    dryRun = true,
    forcarDistribuicao = false,
    force = false,
    actor = 'system',
}) {
    if (!idlead) throw new Error('idlead é obrigatório.');
    if (!idempreendimento) throw new Error('idempreendimento é obrigatório.');

    const lead = await Lead.findByPk(Number(idlead));
    if (!lead) {
        return {
            ok: false,
            motivo_bloqueio: 'lead_nao_encontrado',
            mensagem: `Lead ${idlead} não existe no espelho do CV.`,
        };
    }
    if (!lead.email && !lead.telefone) {
        return {
            ok: false,
            motivo_bloqueio: 'sem_chave',
            mensagem: 'O lead não tem email nem telefone, e o CV exige um dos dois.',
        };
    }

    const situacao = await classifySituacao({ id: lead.situacao_id, nome: lead.situacao_nome });
    const antes = retrato(lead, situacao);

    // ── Trava: quem está qualificado não volta para a fila ──────────────────
    if (situacao.faixa === FAIXA.BLINDADO && !force) {
        return {
            ok: false,
            motivo_bloqueio: 'faixa_blindada',
            mensagem: situacao.conhecida
                ? `Lead está em "${situacao.nome}" (ordem ${situacao.ordem}): etapa blindada, devolver à fila tiraria de quem está atendendo.`
                : `Situação ${lead.situacao_id} não foi encontrada no workflow do CV, tratada como blindada por segurança.`,
            faixa: situacao.faixa,
            antes,
        };
    }

    const jaTemInteresse = antes.interesses.some(e => e.id === Number(idempreendimento));
    const inicio = await situacaoInicio();

    const payload = {
        permitir_alteracao: true,          // obrigatório para editar (doc 1.4)
        idlead: Number(idlead),
        ...(lead.email ? { email: lead.email } : {}),
        ...(lead.telefone ? { telefone: String(lead.telefone).replace(/\D/g, '') } : {}),
        idempreendimento: [Number(idempreendimento)],   // aditivo
        idsituacao: inicio.id,                          // volta para "Início"
        remover_imobiliaria: true,                      // remove imobiliária E corretor
        remover_corretor: true,
        lead_utilizar_fila: true,                       // a fila do CV redistribui
        // Sem fila explicita o CV avalia as REGRAS dele e pode nao achar nenhuma
        // compativel: medido em 26/08/2026 no lead 12361, que tem 8 interesses
        // espalhados por 4 cidades. O protocolo do CV registrou "Lead nao
        // encontrou uma fila compativel e foi represado" — ou seja, a
        // distribuicao rodou e nao teve para quem dar. Informar a fila pula a
        // verificacao de regras (doc do campo) e e a unica forma de garantir
        // que alguem receba.
        ...(idfila ? { idfila_distribuicao_leads: Number(idfila) } : {}),
        // Fila explicita SEM o forcar nao entrega: medido em 28/08/2026 no lead
        // 10685 — em edicao de lead existente o CV registra a fila mas nao roda
        // a distribuicao sozinho, e o lead ficou sem dono ate o envio manual
        // pelo painel. Com idfila, o forcar vai junto sempre.
        ...((forcarDistribuicao || idfila) ? { forcar_distribuicao_lead: true } : {}),
        ...(conversao ? { conversao } : {}),
        ...(midia ? { midia } : {}),
        ...(origem ? { origem } : {}),
        interacoes: [montarInteracao({ idempreendimento, empreendimentoNome: null, conversao, motivo })],
    };

    const plano = {
        de_situacao: `${lead.situacao_nome} (${lead.situacao_id})`,
        para_situacao: `${inicio.nome} (${inicio.id})`,
        solta_dono: { imobiliaria: antes.imobiliaria, corretor: antes.corretor },
        interesse_novo: Number(idempreendimento),
        interesse_ja_existia: jaTemInteresse,
        interesses_que_permanecem: antes.interesses,
        fila: idfila
            ? `fila ${idfila} (explícita + distribuição forçada, pula as regras do CV)`
            : 'escolhida pelo CV pelas regras dele — pode não achar nenhuma e represar o lead',
    };

    if (dryRun) {
        return { ok: true, dryRun: true, faixa: situacao.faixa, antes, plano, payload };
    }

    // Modo sombra global vale aqui também: se a captação não está enviando ao
    // CV, esta ação não pode ser a exceção que escreve.
    if (await isDryRunGlobal()) {
        return {
            ok: false,
            motivo_bloqueio: 'modo_sombra',
            mensagem: 'Modo sombra (dry_run) ligado na configuração de marketing, nada é enviado ao CV.',
            antes, plano, payload,
        };
    }

    const endpoint = await getCvLeadsEndpoint();
    let body;
    try {
        const res = await apiCv.post(endpoint, payload);
        body = res?.data || {};
    } catch (err) {
        const resp = err?.response;
        const detalhe = resp?.data || err.message;
        console.error(`[lead-return] lead ${idlead} falhou: ${JSON.stringify(detalhe).slice(0, 300)}`);
        await registrarEvento({ idlead, actor, ok: false, antes, plano, payload, resposta: detalhe });
        return {
            ok: false,
            motivo_bloqueio: 'erro_cv',
            mensagem: `CV respondeu HTTP ${resp?.status || '-'}.`,
            antes, plano, payload, resposta: detalhe,
        };
    }

    if (body.sucesso !== true) {
        await registrarEvento({ idlead, actor, ok: false, antes, plano, payload, resposta: body });
        return {
            ok: false,
            motivo_bloqueio: 'cv_recusou',
            mensagem: body.mensagem || 'CV recusou sem mensagem.',
            antes, plano, payload, resposta: body,
        };
    }

    // NÃO CONFIAR NA RESPOSTA para saber quem ficou com o lead. Medido em
    // 26/08/2026 no lead 12361: o POST removeu imobiliária e corretor de fato
    // (a leitura ao vivo devolveu os dois nulos), mas o corpo da resposta ainda
    // trazia `idimobiliaria: 10`, `idcorretor: 641` e "Lead já cadastrado" — o
    // eco do dono ANTERIOR. Ler o eco faria o serviço relatar "distribuído"
    // para um lead que está solto na fila.
    //
    // A leitura ao vivo existe, só não onde se procura: `GET /v1/comercial/leads`
    // com `idlead` na query devolve o lead único (o GET direto em
    // /v1/comercial/leads/{id} é 405).
    const vivo = await readLiveLead(idlead);
    const depois = vivo
        ? {
            idsituacao: vivo.situacao?.id != null ? Number(vivo.situacao.id) : null,
            situacao_nome: vivo.situacao?.nome || null,
            idimobiliaria: vivo.imobiliaria?.id || null,
            imobiliaria: vivo.imobiliaria?.nome || null,
            idcorretor: vivo.corretor?.id || null,
            corretor: vivo.corretor?.nome || null,
            data_vencimento: vivo.data_vencimento || null,
            interesses: Array.isArray(vivo.empreendimento) ? vivo.empreendimento.length : null,
            lido_ao_vivo: true,
        }
        : {
            // Sem leitura ao vivo sobra o eco, que não serve para dizer o dono.
            idsituacao: body.idsituacao != null ? Number(body.idsituacao) : null,
            mensagem: body.mensagem || null,
            lido_ao_vivo: false,
        };

    // Só é "distribuído" com dono lido ao vivo. Sem dono, o lead está solto
    // esperando a fila girar — que é um desfecho legítimo, mas não o mesmo.
    depois.distribuido = !!(depois.lido_ao_vivo && (depois.idcorretor || depois.idimobiliaria));

    console.log(`[lead-return] lead ${idlead} devolvido — situação ${depois.idsituacao}, dono ${depois.corretor || depois.imobiliaria || 'ainda na fila'}.`);
    await registrarEvento({ idlead, actor, ok: true, antes, plano, payload, resposta: body, depois });

    return { ok: true, faixa: situacao.faixa, antes, plano, payload, depois, resposta: body };
}

/**
 * Lê um lead do CV ao vivo. Não existe GET de lead individual
 * (/v1/comercial/leads/{id} responde 405), mas a LISTAGEM aceita `idlead` na
 * query e devolve só ele. É a única forma de conferir o que o POST fez de fato.
 * Nunca lança: sem leitura, o chamador se vira com o eco da resposta.
 */
export async function readLiveLead(idlead) {
    try {
        const r = await apiCv.get('/v1/comercial/leads', { params: { idlead: Number(idlead) } });
        const bruto = r.data?.dados || r.data?.leads || r.data?.data || r.data;
        const arr = Array.isArray(bruto) ? bruto : [bruto];
        return arr.find(l => String(l?.idlead ?? l?.id) === String(idlead)) || null;
    } catch (err) {
        console.warn(`[lead-return] leitura ao vivo do lead ${idlead} falhou: ${err.message}`);
        return null;
    }
}

/** Grava na trilha do inbound_lead correspondente, quando existir um. */
async function registrarEvento({ idlead, actor, ok, antes, plano, payload, resposta, depois = null }) {
    try {
        const inbound = await InboundLead.findOne({
            where: { cv_idlead: String(idlead) },
            order: [['created_at', 'DESC']],
            attributes: ['id'],
        });
        if (!inbound) return;
        await recordLeadEvent({
            leadId: inbound.id,
            type: ok ? 'lead_returned' : 'lead_return_failed',
            actor,
            message: ok
                ? `Lead ${idlead} devolvido à fila com o interesse ${plano.interesse_novo}.`
                : `Falha ao devolver o lead ${idlead} à fila.`,
            detail: { antes, plano, payload, resposta, depois },
        });
    } catch (err) {
        console.error(`[lead-return] falha ao registrar evento do lead ${idlead}: ${err.message}`);
    }
}

/**
 * Retrato de um lead do CV com a faixa calculada: o que a tela (e a pessoa)
 * precisam ver antes de decidir. Não escreve nada.
 */
export async function inspectLead(idlead) {
    const lead = await Lead.findByPk(Number(idlead));
    if (!lead) return null;

    const situacao = await classifySituacao({ id: lead.situacao_id, nome: lead.situacao_nome });
    const inbounds = await InboundLead.findAll({
        where: { cv_idlead: String(idlead) },
        order: [['created_at', 'DESC']],
        limit: 10,
        attributes: ['id', 'created_at', 'midia_slug', 'meta_campaign_id', 'bound_empreendimentos', 'is_reentry', 'cv_response', 'status'],
    });

    return {
        lead: retrato(lead, situacao),
        situacao,
        faixa: situacao.faixa,
        pode_voltar: situacao.faixa !== FAIXA.BLINDADO,
        conversoes_do_office: inbounds.map(i => ({
            id: i.id,
            em: i.created_at,
            status: i.status,
            midia: i.midia_slug,
            campanha: i.meta_campaign_id,
            empreendimentos: i.bound_empreendimentos,
            reentrada: i.is_reentry,
            desfecho_no_cv: desfechoDaResposta(i.cv_response),
        })),
    };
}

/**
 * As filas de distribuicao de leads cadastradas no CV.
 * E de onde sai o `idfila_distribuicao_leads`; o CV nao expoe qual fila atende
 * qual empreendimento, entao o vinculo e decisao nossa.
 */
export async function listFilas() {
    const r = await apiCv.get('/v1/comercial/filas-distribuicao-leads', { params: { limite: 50 } });
    const filas = r.data?.filas || [];
    return filas.map(f => ({
        id: Number(f.idfila_distribuicao_leads),
        nome: f.nome,
        corretores: (f.corretores_e_imobiliarias || []).length,
        imobiliarias: [...new Set((f.corretores_e_imobiliarias || []).map(c => c.nome_imobiliaria).filter(Boolean))],
        vazia: !(f.corretores_e_imobiliarias || []).length && !(f.gestores || []).length,
    }));
}

/** Traduz a mensagem do CV nos três desfechos reais de um POST de lead. */
export function desfechoDaResposta(cvResponse) {
    const msg = String(cvResponse?.mensagem || '');
    if (/reativado/i.test(msg)) return 'reativado';
    if (/j[áa] cadastrado/i.test(msg)) return 'ja_existia';
    if (/cadastrado com sucesso/i.test(msg)) return 'criado';
    return msg ? 'outro' : null;
}

export default { returnLeadToQueue, inspectLead, readLiveLead, listFilas, desfechoDaResposta };
