// services/reservaCancel/ReservaCancelService.js
//
// Automação de cancelamento de reservas CV × Sienge.
//
// Fluxo: webhook do CV avisa que uma reserva foi cancelada → conferimos a
// reserva AO VIVO no CV (nunca confiamos só no webhook) → localizamos o
// contrato de venda no Sienge pelo externalId (= idreserva) → se e somente se
// TODAS as validações passarem, excluímos o contrato, confirmamos a exclusão
// com releitura, disponibilizamos a unidade no CV e registramos mensagem na
// reserva. Qualquer validação reprovada = status 'blocked': NADA é alterado
// e o caso vira pendência na tela do Office.
//
// Validações (todas obrigatórias no caminho de exclusão):
//   1. Reserva efetivamente cancelada/distratada no CV (data_cancelamento/data_distrato).
//   2. Exatamente 1 contrato ativo no Sienge com externalId = idreserva.
//   3. Contrato na situação 'Autorizado' (aguardando emissão) e SEM data de emissão.
//   4. Unidade do contrato = unidade da reserva (id interno; nome como fallback).
//   5. Empreendimento OU empresa do contrato conferem com a reserva (por
//      código, várias fontes - ver conferirEmpreendimento). Quando a unidade
//      já foi confirmada pelo código interno, divergência aqui é aviso, não
//      bloqueio: o id da unidade é único no Sienge e sozinho já amarra o
//      contrato à reserva.
//   6. Cliente do contrato = titular da reserva (CPF/CNPJ via /customers; nome como fallback).
//   7. Nenhuma parcela paga (amountPaid total = 0).
//   8. Gate do Ato (Boleto Caixa): só segue sem ato/série, ato baixado por
//      vencimento sem pagamento, ou geração com erro. Boleto emitido pendente,
//      pago ou em processamento = bloqueia.
//   9. Nenhum OUTRO contrato ativo na mesma unidade no Sienge.
//
// Sem contrato no Sienge: a unidade só é disponibilizada no CV se NENHUMA das
// referências cruzadas apontar contrato ativo (busca por reserva/externalId,
// por unidade, pelo número de integração CVMENIN{unidade}{reserva} e pelos
// contratos dos clientes Sienge com o documento do titular).
//
// Freio de rajada (definido pelo negócio em 2026-08-21, após a rotina de
// sincronização do CV cancelar 98 reservas do Residencial dos Anjos em 21s):
// cancelamento em massa retém TODOS os casos da rajada como 'held', sem tocar
// em Sienge nem em CV. Regulado em settings (burst_*) — ver avaliarRajada().
//
// Workflow CV (definido pelo negócio em 2026-07-23):
//   sucesso        → reserva PERMANECE/volta para "Cancelada" (settings.situacao_cancelada_id, ID 4)
//   blocked/error  → reserva é movida para "Pendência" (settings.situacao_pendencia_id, ID 30);
//                    ao regularizar, mover Pendência → Cancelada re-dispara o webhook e o
//                    fluxo roda de novo. Assim "Cancelada" só contém o que foi de fato
//                    cancelado dos dois lados.

import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import apiSienge from '../../lib/apiSienge.js';
import EventLogger from './ReservaCancelEventLogger.js';
import { baixarBoletoPorCancelamento } from '../boleto/BoletoPaymentCheckService.js';

const SITUACAO_DELETAVEL = 'Autorizado'; // "Aguardando emissão" no Sienge
const OFFICE_TELA = 'Comercial > Cancelamentos CV × Sienge';

// Guarda de concorrência in-process (1 processamento por reserva por vez).
const inFlight = new Set();

// ── Helpers genéricos ─────────────────────────────────────────────────────────

function digits(v) {
    return String(v ?? '').replace(/\D/g, '');
}

function normalizeName(v) {
    return String(v ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function formatDateBr(isoLike) {
    if (!isoLike) return '-';
    const s = String(isoLike);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function describeApiError(err) {
    const data = err?.response?.data;
    if (data) {
        if (typeof data === 'string') return data.slice(0, 500);
        if (data.clientMessage)     return String(data.clientMessage);
        if (data.developerMessage)  return String(data.developerMessage);
        if (data.mensagem)          return String(data.mensagem);
        if (data.erro)              return String(data.erro);
        if (data.message)           return String(data.message);
        try { return JSON.stringify(data).slice(0, 500); } catch { /* noop */ }
    }
    return err?.message || 'erro desconhecido';
}

// Alguns endpoints do CV respondem HTTP 200 com erro lógico no corpo.
function isCvResponseOk(data) {
    if (data == null) return true;
    if (typeof data !== 'object') return true;
    if (data.error || data.erro) return false;
    if ('sucesso' in data) return !!data.sucesso;
    return true;
}

// O campo de mensagem do CV trunca no primeiro emoji de 4 bytes - removemos
// (mantendo ✅ ❌ ⚠️ ℹ️, que são BMP). Mesma regra do módulo Boleto.
function sanitizeCvMessage(mensagem) {
    const src = String(mensagem ?? '');
    let out = '';
    let skipNextSpace = false;
    for (const ch of src) {
        const cp = ch.codePointAt(0);
        if (cp >= 0x10000 || cp === 0xFE0F || cp === 0x200D) { skipNextSpace = true; continue; }
        if (skipNextSpace && ch === ' ') { skipNextSpace = false; continue; }
        skipNextSpace = false;
        out += ch;
    }
    return out.replace(/[ \t]+$/gm, '').trim();
}

async function sendCvMessage(idreserva, mensagem) {
    const tag = `[RESERVA-CANCEL][CV-MSG][reserva ${idreserva}]`;
    mensagem = sanitizeCvMessage(mensagem);
    try {
        const resp = await apiCv.post('/v2/comercial/reservas/mensagens', { idreserva, mensagem });
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || 'erro lógico do CV';
            console.warn(`${tag} ✗ HTTP ${resp.status} com erro lógico: ${detail}`);
            return { ok: false, error: String(detail), httpStatus: resp.status };
        }
        console.log(`${tag} ✓ OK (HTTP ${resp.status})`);
        return { ok: true };
    } catch (err) {
        const detail = describeApiError(err);
        console.error(`${tag} ✗ Falha: ${detail}`);
        return { ok: false, error: detail, httpStatus: err?.response?.status || null };
    }
}

async function getSettings() {
    let s = await db.ReservaCancelSettings.findByPk(1);
    if (!s) s = await db.ReservaCancelSettings.create({ id: 1 });
    return s;
}

// ── Consultas Sienge ──────────────────────────────────────────────────────────

/**
 * Busca TODOS os contratos de venda que casam com os params (pagina de 200 em
 * 200, teto defensivo de 1000). Retorna array de contratos crus da API.
 */
async function fetchSalesContracts(params) {
    const all = [];
    let offset = 0;
    while (true) {
        const { data } = await apiSienge.get('/v1/sales-contracts', {
            params: { ...params, limit: 200, offset },
        });
        const results = data?.results || [];
        all.push(...results);
        const count = Number(data?.resultSetMetadata?.count) || results.length;
        offset += 200;
        if (all.length >= count || results.length === 0 || offset >= 1000) break;
    }
    return all;
}

function isContratoAtivo(c) {
    return normalizeName(c?.situation) !== 'CANCELADO';
}

function contratoResumo(c) {
    return {
        id: c.id,
        numero: c.number,
        situacao: c.situation,
        externalId: c.externalId ?? null,
        valor: c.value ?? null,
        emissao: c.issueDate ?? null,
    };
}

/**
 * Localiza clientes no Sienge pelo documento (CPF/CNPJ) do titular da reserva.
 * Filtra o retorno pra garantir match exato de dígitos.
 */
async function buscarClientesPorDocumento(doc) {
    const param = doc.length > 11 ? { cnpj: doc } : { cpf: doc };
    const { data } = await apiSienge.get('/v1/customers', { params: { ...param, limit: 200 } });
    return (data?.results || []).filter(c => digits(c.cpf || c.cnpj) === doc);
}

/**
 * Altera a situação da reserva no CV (workflow). Usada pra mover a reserva
 * pra "Pendência" quando algo barra o cancelamento, e pra devolver/manter em
 * "Cancelada" quando o fluxo conclui com sucesso.
 */
async function alterarSituacaoCv(idreserva, idsituacao, comentario) {
    const tag = `[RESERVA-CANCEL][CV-SITUACAO][reserva ${idreserva}]`;
    try {
        const resp = await apiCv.post('/v1/comercial/reservas/alterar-situacao', {
            idreserva_cv: Number(idreserva),
            idsituacao_destino: Number(idsituacao),
            comentario: comentario || 'Alteração automática - Cancelamentos CV × Sienge',
        });
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || 'erro lógico do CV';
            console.warn(`${tag} ✗ HTTP ${resp.status} com erro lógico: ${detail}`);
            return { ok: false, error: String(detail), httpStatus: resp.status };
        }
        console.log(`${tag} ✓ Situação ${idsituacao} aplicada (HTTP ${resp.status}).`);
        return { ok: true };
    } catch (err) {
        const detail = describeApiError(err);
        console.error(`${tag} ✗ Falha: ${detail}`);
        return { ok: false, error: detail, httpStatus: err?.response?.status || null };
    }
}

/**
 * Compara o cliente principal do contrato com o titular da reserva.
 * Preferência: CPF/CNPJ via GET /v1/customers/{id}; fallback: nome normalizado.
 */
async function validarCliente(contrato, titular) {
    const clientes = [].concat(contrato?.salesContractCustomers || []);
    if (!clientes.length) return { ok: false, detalhe: 'Contrato sem cliente vinculado.' };
    const principal = clientes.find(c => c.main) || clientes[0];

    const docReserva = digits(titular?.documento);
    if (docReserva && principal?.id) {
        try {
            const { data } = await apiSienge.get(`/v1/customers/${principal.id}`);
            const docSienge = digits(data?.cpf || data?.cnpj || data?.internationalId);
            if (docSienge) {
                const ok = docSienge === docReserva;
                return {
                    ok,
                    detalhe: ok
                        ? `Documento confere (${docSienge}).`
                        : `Documento divergente: contrato=${docSienge} × reserva=${docReserva}.`,
                };
            }
        } catch (err) {
            // Sem acesso ao /customers - cai pro fallback por nome.
            console.warn(`[RESERVA-CANCEL] GET /customers/${principal.id} falhou (${err?.response?.status || err.message}) - usando comparação por nome.`);
        }
    }

    const nomeContrato = normalizeName(principal?.name);
    const nomeReserva = normalizeName(titular?.nome);
    if (!nomeContrato || !nomeReserva) return { ok: false, detalhe: 'Nome do cliente indisponível pra comparação.' };
    const ok = nomeContrato === nomeReserva;
    return {
        ok,
        detalhe: ok
            ? `Nome confere (${nomeContrato}) - comparação por nome (documento indisponível).`
            : `Nome divergente: contrato="${principal?.name}" × reserva="${titular?.nome}".`,
    };
}

/**
 * Gate do Ato (módulo Boleto Caixa). Regra definida pelo negócio:
 *   segue  → sem registro de boleto, sem série (skipped), geração com erro,
 *            boleto baixado por vencimento sem pagamento (payment_status
 *            cancelled), ou boleto pendente (segue vivo até vencer — a baixa
 *            fica com o scheduler diário; ver baixar_boleto_no_cancelamento)
 *   barra  → boleto em processamento, pago, ou estado incerto
 */
async function validarAto(idreserva) {
    const boleto = await db.BoletoHistory.findOne({
        where: { idreserva, ignorado: false },
        order: [['id', 'DESC']],
    });
    if (!boleto) return { ok: true, detalhe: 'Reserva sem ato registrado no módulo Boleto Caixa.' };

    if (boleto.status === 'skipped') return { ok: true, detalhe: 'Ato pulado (reserva sem série de Ato).' };
    if (boleto.status === 'error')   return { ok: true, detalhe: `Geração do ato terminou em erro não resolvido (boleto #${boleto.id}).` };
    if (boleto.status === 'processing') {
        return { ok: false, detalhe: `Ato em processamento no módulo Boleto Caixa (boleto #${boleto.id}).` };
    }
    // status === 'success' → decide pelo ciclo de vida do boleto no banco
    switch (boleto.payment_status) {
        case 'cancelled':
            return { ok: true, detalhe: `Ato vencido sem pagamento - boleto #${boleto.id} baixado por devolução.` };
        case 'paid':
            return { ok: false, detalhe: `Ato PAGO (boleto #${boleto.id}, liquidado em ${boleto.paid_at ? new Date(boleto.paid_at).toLocaleDateString('pt-BR') : '-'}).` };
        case 'pending': {
            // Boleto pendente NÃO é baixado pelo cancelamento desde 21/08/2026.
            //
            // A baixa na hora vira baixa em massa quando o CV dispara uma
            // rajada: em 20/08 foram 99 cancelamentos num minuto no RESIDENCIAL
            // DOS ANJOS, e o que segurou o estrago foi 81 dos boletos já
            // estarem pagos, não uma trava nossa. Agora o boleto segue vivo até
            // vencer e o scheduler diário o baixa pelo caminho de sempre.
            //
            // O preço, aceito pelo negócio: entre o cancelamento e o vencimento
            // o cliente ainda consegue pagar o ato de uma reserva cancelada. O
            // aviso abaixo deixa isso visível na tela em vez de silencioso.
            // Pra voltar ao comportamento antigo, é a chave
            // `baixar_boleto_no_cancelamento` nas configurações do módulo.
            const cfg = await db.ReservaCancelSettings.findByPk(1);
            if (!cfg?.baixar_boleto_no_cancelamento) {
                return {
                    ok: true,
                    aviso: `Boleto #${boleto.id} segue pendente (venc. ${formatDateBr(boleto.vencimento)}). A baixa não é feita pelo cancelamento: fica com a rotina diária, depois do vencimento. Até lá o ato ainda pode ser pago.`,
                    detalhe: `Ato pendente (boleto #${boleto.id}, venc. ${formatDateBr(boleto.vencimento)}) - baixa deixada para a rotina diária, após o vencimento.`,
                };
            }

            const baixa = await baixarBoletoPorCancelamento(idreserva);
            if (baixa.ok) {
                return { ok: true, detalhe: `Boleto #${boleto.id} estava pendente — baixa automática solicitada pelo cancelamento: ${baixa.detalhe}` };
            }
            if (baixa.outcome === 'pago') {
                return { ok: false, detalhe: `Ato PAGO (descoberto ao solicitar a baixa do boleto #${boleto.id}): ${baixa.detalhe}` };
            }
            return { ok: false, detalhe: `Boleto do ato pendente (boleto #${boleto.id}, venc. ${formatDateBr(boleto.vencimento)}) e a baixa automática falhou: ${baixa.detalhe} Reprocesse o cancelamento pela tela.` };
        }
        default:
            return { ok: false, detalhe: `Estado do ato incerto (boleto #${boleto.id}, payment_status=${boleto.payment_status}) - bloqueado por segurança.` };
    }
}

/**
 * Confere se o contrato do Sienge pertence ao mesmo empreendimento/empresa da
 * reserva. Sempre por CÓDIGO, nunca por nome.
 *
 * Por que não basta comparar `idempreendimento_int` com o `enterpriseId` do
 * contrato: no CV esse campo muitas vezes traz o código da EMPRESA (99 em
 * TERRAS DE SÃO PAULO V, 78 em PARQUE DOS IPÊS, 89 em JARDIM MÔNACO, 107 em
 * SANTA STELLA), que não é centro de custo nenhum. Quem carrega o CC da fase é
 * a ETAPA (`idetapa_int`; 99905 = FASE 3), porque no Sienge cada fase é um
 * empreendimento próprio. É a mesma regra já usada nos relatórios
 * (services/cv/workflowGroupQueriesService.js).
 *
 * Por isso a conferência tenta várias fontes, da mais forte pra mais fraca:
 *   1. etapa da reserva (idetapa_int)          → CC da fase
 *   2. etapa no cadastro do CV (mesma info)    → CC da fase
 *   3. vínculo manual CV × Sienge              → exceção configurada na tela
 *   4. código interno do empreendimento        → só serve quando é CC de verdade
 *   5. empresa × empresa                       → confirma o grupo quando o CC não veio
 *
 * @returns {{ok:boolean, forte:boolean, detalhe:string}}
 */
async function conferirEmpreendimento(contrato, unidade) {
    const ccContrato = digits(contrato?.enterpriseId);
    const empresaContrato = digits(contrato?.companyId);

    const ccs = [];       // candidatos a empreendimento (centro de custo) Sienge
    const empresas = [];  // candidatos a empresa Sienge
    const push = (lista, codigo, fonte) => {
        const d = digits(codigo);
        if (d && !lista.some(c => c.codigo === d && c.fonte === fonte)) lista.push({ codigo: d, fonte });
    };

    const idetapaCv = Number(digits(unidade?.idetapa_cv)) || null;
    const idempCv = Number(digits(unidade?.idempreendimento_cv)) || null;
    const idempIntCv = digits(unidade?.idempreendimento_int);

    // 1. Etapa que veio junto da reserva.
    push(ccs, unidade?.idetapa_int, 'etapa da reserva (idetapa_int)');

    // 2. Etapa no cadastro do CV (quando a reserva não trouxe o código).
    try {
        if (idetapaCv && db.CvEnterpriseStage) {
            const etapa = await db.CvEnterpriseStage.findByPk(idetapaCv);
            push(ccs, etapa?.idetapa_int, 'etapa no cadastro do CV');
        }
    } catch (err) {
        console.warn(`[RESERVA-CANCEL] Cadastro de etapas indisponível: ${err.message}`);
    }

    // 3. Vínculo manual CV × Sienge (exceções configuradas na tela).
    try {
        if (db.EnterpriseErpLink) {
            const { Op } = db.Sequelize;
            const ors = [];
            if (idetapaCv) ors.push({ cv_stage_id: idetapaCv });
            const empIds = [idempCv, Number(idempIntCv) || null].filter(Boolean);
            if (empIds.length) ors.push({ cv_stage_id: null, cv_enterprise_id: { [Op.in]: empIds } });
            if (ors.length) {
                const links = await db.EnterpriseErpLink.findAll({ where: { active: true, [Op.or]: ors } });
                links.forEach(l => push(ccs, l.erp_enterprise_id, 'vínculo manual CV × Sienge'));
            }
        }
    } catch (err) {
        console.warn(`[RESERVA-CANCEL] Vínculos manuais indisponíveis: ${err.message}`);
    }

    // 4/5. Código interno do empreendimento: serve como CC quando é CC de
    // verdade e como empresa quando o CV preencheu com o código da empresa.
    push(ccs, idempIntCv, 'código interno do empreendimento no CV');
    push(empresas, idempIntCv, 'código interno do empreendimento no CV (preenchido com o código da empresa)');
    push(empresas, unidade?.idempresa_int, 'empresa da unidade no CV');

    try {
        if (idempCv && db.CvEnterprise) {
            const emp = await db.CvEnterprise.findByPk(idempCv);
            push(ccs, emp?.idempreendimento_int, 'código interno do empreendimento no cadastro do CV');
            push(empresas, emp?.idempreendimento_int, 'código interno do empreendimento no cadastro do CV');
            // Só o código da empresa NO SIENGE (idempresa_int). O `idempresa` do
            // CV é id interno do CRM, outro namespace - compará-lo com o
            // companyId do Sienge daria falso positivo.
            push(empresas, emp?.raw?.idempresa_int, 'empresa do cadastro do CV');
        }
    } catch (err) {
        console.warn(`[RESERVA-CANCEL] Cadastro de empreendimentos indisponível: ${err.message}`);
    }

    const ccHit = ccContrato ? ccs.find(c => c.codigo === ccContrato) : null;
    const empresaHit = empresaContrato ? empresas.find(c => c.codigo === empresaContrato) : null;
    const nomeContrato = contrato?.enterpriseName || contrato?.enterprise?.name || null;
    const listar = lista => (lista.length ? lista.map(c => `${c.codigo} (${c.fonte})`).join(', ') : 'nenhum código disponível');

    if (ccHit) {
        return {
            ok: true,
            forte: true,
            detalhe: `empreendimento ${ccContrato}${nomeContrato ? ` (${nomeContrato})` : ''} confere com ${ccHit.fonte}`
                + `${empresaHit ? `; empresa ${empresaContrato} também confere` : ''}.`,
        };
    }
    if (empresaHit) {
        return {
            ok: true,
            forte: true,
            detalhe: `empresa ${empresaContrato} confere com ${empresaHit.fonte}. O centro de custo da fase não veio na reserva`
                + ` (contrato no empreendimento ${ccContrato || '?'}${nomeContrato ? ` - ${nomeContrato}` : ''}; códigos da reserva: ${listar(ccs)}),`
                + ' então a conferência foi por empresa.',
        };
    }
    return {
        ok: false,
        forte: false,
        detalhe: `contrato no empreendimento ${ccContrato || '?'}${nomeContrato ? ` (${nomeContrato})` : ''} / empresa ${empresaContrato || '?'}`
            + ` não bate com nenhum código da reserva - empreendimento: ${listar(ccs)} | empresa: ${listar(empresas)}.`,
    };
}

// ── Mensagens CV ──────────────────────────────────────────────────────────────

function linhasBase(history) {
    return [
        `Reserva ${history.idreserva} - ${history.titular_nome || 'titular não identificado'}`,
        `Unidade: ${history.unidade_nome || '-'} | Empreendimento: ${history.empreendimento || '-'}`,
        `Cancelamento no CV em: ${formatDateBr(history.data_cancelamento)}`,
    ];
}

function mensagemSucessoComDelete(history, contrato, checks) {
    return [
        '✅ Automação de cancelamento CV × Sienge concluída.',
        '',
        ...linhasBase(history),
        '',
        `Contrato Sienge nº ${contrato.number} (ID ${contrato.id}, situação "${contrato.situation}") localizado pela reserva.`,
        'Validações aprovadas:',
        ...checks.map(c => `• ${c.check}: ${c.detalhe}`),
        '',
        'Ações executadas:',
        '• Contrato EXCLUÍDO do Sienge (exclusão confirmada por releitura).',
        '• Unidade DISPONIBILIZADA no CV.',
        '',
        `Registro completo: ${OFFICE_TELA} (caso #${history.id}).`,
    ].join('\n');
}

function mensagemSucessoSemContrato(history, checks) {
    return [
        '✅ Automação de cancelamento CV × Sienge concluída.',
        '',
        ...linhasBase(history),
        '',
        'Nenhum contrato de venda ativo no Sienge para esta reserva.',
        'Conferências que garantiram a unidade livre no Sienge:',
        ...checks.map(c => `• ${c.check}: ${c.detalhe}`),
        '',
        'Ação executada:',
        '• Unidade DISPONIBILIZADA no CV.',
        '',
        `Registro completo: ${OFFICE_TELA} (caso #${history.id}).`,
    ].join('\n');
}

function mensagemBloqueio(history, motivo) {
    return [
        '⚠️ Automação de cancelamento CV × Sienge NÃO executou o cancelamento desta reserva.',
        '',
        ...linhasBase(history),
        '',
        `Motivo: ${motivo}`,
        '',
        'Nenhum dado foi alterado no Sienge.',
        'Para efetuar este cancelamento de maneira correta, envie um e-mail ao administrativo interno solicitando a regularização do contrato no Sienge.',
        'A reserva foi movida para a etapa PENDÊNCIA no CV e só deve retornar para Cancelada após a regularização.',
        '',
        `Acompanhamento: ${OFFICE_TELA} (caso #${history.id}).`,
    ].join('\n');
}

function mensagemErro(history, motivo) {
    return [
        '❌ Automação de cancelamento CV × Sienge encontrou um erro nesta reserva.',
        '',
        ...linhasBase(history),
        '',
        `Erro: ${motivo}`,
        '',
        'A reserva foi movida para a etapa PENDÊNCIA no CV até a regularização.',
        `Reprocesse pela tela ${OFFICE_TELA} (caso #${history.id}) ou retorne a reserva para Cancelada para tentar novamente.`,
    ].join('\n');
}

// ── Processamento principal ───────────────────────────────────────────────────

/**
 * @param {object}  params
 * @param {number}  params.idreserva
 * @param {boolean} [params.manual=false]   - disparo manual por admin (reprocessar).
 * @param {number}  [params.triggeredBy]    - user.id do admin no disparo manual.
 * @param {object}  [params.webhookPayload] - corpo bruto do webhook (auditoria).
 */
// ── Freio de rajada (superlotação) ────────────────────────────────────────────
//
// Cancelamento em massa no CV (uma rotina de sincronização disparando dezenas de
// webhooks em segundos) quase nunca é operação legítima - e o estrago é
// irreversível: contrato excluído no Sienge não volta. Com o freio ligado,
// NENHUM caso da rajada é executado; todos ficam 'held' pra conferência humana.
//
// A espera (`burst_settle_seconds`) é o que garante o "nenhum": sem ela, os
// primeiros webhooks passariam antes do contador estourar o teto. Cada caso
// espera a janela assentar, enxerga a rajada inteira e só então decide.

const BURST_FALLBACK = { janela: 300, teto: 10, espera: 15 };
const ESPERA_MAX_S = 600; // teto de segurança: o dedupe de 'processing' vale 15 min.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const posInt = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Identifica o caso pela tabela LOCAL de reservas (sync do CV), sem gastar
 * chamada de API. Um caso retido para antes da leitura ao vivo do CV, e sem
 * `idempreendimento_cv` ele sumiria da tela para todo mundo que não é admin
 * (reservaCancelScope recorta por esse id) - virava exatamente o caso invisível
 * que o freio existe pra evitar. Best-effort: falhar aqui não muda a decisão.
 */
async function identificarPeloBancoLocal(history, idreserva) {
    try {
        const r = await db.Reserva.findByPk(idreserva, {
            attributes: ['idreserva', 'empreendimento', 'unidade', 'unidade_json', 'titular'],
        });
        if (!r) return;
        const u = r.unidade_json || {};
        await history.update({
            titular_nome: r.titular?.nome || null,
            titular_documento: digits(r.titular?.documento) || null,
            empreendimento: r.empreendimento || u.empreendimento || null,
            idempreendimento_cv: Number(u.idempreendimento_cv) || null,
            unidade_nome: r.unidade || u.unidade || null,
            idunidade_cv: Number(u.idunidade_cv) || null,
            idunidade_int: u.idunidade_int != null ? String(u.idunidade_int) : null,
        });
    } catch (err) {
        console.warn(`[RESERVA-CANCEL][reserva ${idreserva}] Falha ao identificar pelo banco local: ${err.message}`);
    }
}

async function contarAutomaticosNaJanela(excludeId, janelaSegundos) {
    const { Op } = db.Sequelize;
    return db.ReservaCancelHistory.count({
        where: {
            id: { [Op.ne]: excludeId },
            manual: false,
            created_at: { [Op.gte]: new Date(Date.now() - janelaSegundos * 1000) },
        },
    });
}

async function avaliarRajada({ history, settings, ev, tag }) {
    if (!settings.burst_guard_active) return { reter: false };

    const janela = posInt(settings.burst_window_seconds, BURST_FALLBACK.janela);
    const teto = posInt(settings.burst_max_cancels, BURST_FALLBACK.teto);
    const espera = Math.min(
        posInt(settings.burst_settle_seconds, BURST_FALLBACK.espera),
        ESPERA_MAX_S,
    );

    const motivoDe = (n) =>
        `Freio de rajada: ${n} cancelamentos automáticos em ${janela}s, acima do teto de ${teto}. ` +
        `Nada foi alterado no Sienge nem no CV. Verifique o que originou a rajada e reprocesse pela tela ` +
        `os cancelamentos que forem legítimos.`;

    const reter = async (n) => {
        const motivo = motivoDe(n);
        console.warn(`${tag} RETIDO pelo freio de rajada (${n} na janela de ${janela}s, teto ${teto}).`);
        await identificarPeloBancoLocal(history, history.idreserva);
        await ev('burst_held', motivo, 'warning', { na_janela: n, teto, janela_segundos: janela });
        return { reter: true, motivo };
    };

    // Rajada já reconhecida: retém na hora, sem gastar a espera.
    const antes = await contarAutomaticosNaJanela(history.id, janela) + 1;
    if (antes > teto) return reter(antes);

    if (espera <= 0) return { reter: false };

    // Ainda sob o teto - espera a janela assentar antes de decidir.
    await ev('burst_wait',
        `Aguardando ${espera}s antes de agir, para conferir se este cancelamento faz parte de uma rajada.`,
        'info', { na_janela: antes, teto, janela_segundos: janela });
    await sleep(espera * 1000);

    const depois = await contarAutomaticosNaJanela(history.id, janela) + 1;
    if (depois > teto) return reter(depois);

    await ev('burst_ok', `Janela tranquila: ${depois} cancelamento(s) em ${janela}s (teto ${teto}). Seguindo.`);
    return { reter: false };
}

export async function processReservaCancel({ idreserva, manual = false, triggeredBy = null, webhookPayload = null }) {
    idreserva = Number(idreserva);
    const tag = `[RESERVA-CANCEL][reserva ${idreserva}]`;

    if (inFlight.has(idreserva)) {
        console.warn(`${tag} Processamento já em andamento neste processo - ignorando disparo duplicado.`);
        return null;
    }
    inFlight.add(idreserva);
    try {
        return await runProcess({ idreserva, manual, triggeredBy, webhookPayload, tag });
    } finally {
        inFlight.delete(idreserva);
    }
}

async function runProcess({ idreserva, manual, triggeredBy, webhookPayload, tag }) {
    const settings = await getSettings();

    const history = await db.ReservaCancelHistory.create({
        idreserva,
        status: 'processing',
        manual,
        triggered_by: triggeredBy,
        webhook_payload: webhookPayload || null,
    });
    const ev = (type, message, severity = 'info', data = null) =>
        EventLogger.log({ historyId: history.id, idreserva, type, message, severity, data });

    await ev('received', manual ? `Disparo manual (user ${triggeredBy || '?'}).` : 'Webhook de cancelamento recebido do CV.');

    const warnings = [];
    const checks = [];
    const addCheck = async (check, ok, detalhe) => {
        checks.push({ check, ok, detalhe });
        await ev(ok ? 'check_passed' : 'check_failed', `${check}: ${detalhe}`, ok ? 'info' : 'warning');
        return ok;
    };

    const finish = async (status, motivo = null, extra = {}) => {
        await history.update({
            status,
            motivo,
            checks: checks.length ? checks : null,
            warnings: warnings.length ? warnings : null,
            ...extra,
        });
        return history;
    };

    // Preenchido após a reserva ser carregada e confirmada como cancelada -
    // habilita os finalizadores a mexer no workflow do CV (Pendência/Cancelada).
    let reservaCtx = null; // { situacaoId }

    /**
     * Move a reserva pra outra etapa do workflow CV (se já não estiver nela).
     * Falha vira warning - a decisão de status do caso é do chamador.
     */
    const aplicarSituacaoCv = async (idsituacao, rotulo) => {
        if (!idsituacao) {
            warnings.push({ etapa: 'cv_situacao', erro: `ID da situação "${rotulo}" não configurado nas Configurações.` });
            return false;
        }
        if (reservaCtx?.situacaoId === Number(idsituacao)) {
            await ev('cv_situacao', `Reserva já está na etapa ${rotulo} (ID ${idsituacao}) - nenhuma alteração de workflow necessária.`);
            return true;
        }
        const r = await alterarSituacaoCv(idreserva, idsituacao, `Automação Cancelamentos CV × Sienge - caso #${history.id}`);
        if (r.ok) {
            await ev('cv_situacao', `Reserva movida para a etapa ${rotulo} (ID ${idsituacao}) no CV.`, 'success');
            await history.update({ cv_situacao_alterada: true, situacao_aplicada_id: Number(idsituacao) });
            return true;
        }
        warnings.push({ etapa: 'cv_situacao', erro: r.error });
        await ev('error', `Falha ao mover a reserva para ${rotulo} (ID ${idsituacao}): ${r.error}`, 'error');
        return false;
    };

    // Bloqueio por REGRA: nada foi alterado no Sienge; mensagem orienta e-mail
    // ao administrativo interno e a reserva vai pra etapa Pendência no CV.
    const finishBlocked = async (motivo) => {
        console.warn(`${tag} BLOQUEADO: ${motivo}`);
        await ev('blocked', motivo, 'warning');
        const msg = await sendCvMessage(idreserva, mensagemBloqueio(history, motivo));
        if (msg.ok) await ev('cv_message_sent', 'Mensagem de pendência registrada na reserva CV.');
        else warnings.push({ etapa: 'cv_mensagem', erro: msg.error });
        if (reservaCtx) await aplicarSituacaoCv(settings.situacao_pendencia_id, 'Pendência');
        return finish('blocked', motivo, { cv_mensagem_enviada: !!msg.ok });
    };

    // Erro TÉCNICO: reserva também vai pra Pendência (se já sabemos que está
    // cancelada), com mensagem própria orientando o reprocesso.
    const finishError = async (motivo, extra = {}) => {
        console.error(`${tag} ERRO: ${motivo}`);
        let msgOk = false;
        if (reservaCtx) {
            const msg = await sendCvMessage(idreserva, mensagemErro(history, motivo));
            msgOk = !!msg.ok;
            if (msg.ok) await ev('cv_message_sent', 'Mensagem de erro registrada na reserva CV.');
            else warnings.push({ etapa: 'cv_mensagem', erro: msg.error });
            await aplicarSituacaoCv(settings.situacao_pendencia_id, 'Pendência');
        }
        return finish('error', motivo, { cv_mensagem_enviada: msgOk, ...extra });
    };

    try {
        // ── 0. Kill-switch ────────────────────────────────────────────────────
        if (!settings.active && !manual) {
            console.log(`${tag} Automação desativada - registrando como skipped.`);
            return await finish('skipped', 'Automação desativada nas configurações. Reprocesse pela tela quando ativar.');
        }

        // ── 0a. Freio de rajada ───────────────────────────────────────────────
        if (!manual) {
            const rajada = await avaliarRajada({ history, settings, ev, tag });
            if (rajada.reter) return await finish('held', rajada.motivo);
        }

        // ── 0b. Dedupe: outro processamento vivo ou sucesso anterior ──────────
        const { Op } = db.Sequelize;
        const outroProcessando = await db.ReservaCancelHistory.findOne({
            where: {
                idreserva,
                id: { [Op.ne]: history.id },
                status: 'processing',
                updated_at: { [Op.gte]: new Date(Date.now() - 15 * 60 * 1000) },
            },
        });
        if (outroProcessando) {
            return await finish('ignored', `Já existe processamento em andamento pra esta reserva (caso #${outroProcessando.id}).`);
        }
        if (!manual) {
            const sucessoAnterior = await db.ReservaCancelHistory.findOne({
                where: { idreserva, id: { [Op.ne]: history.id }, status: 'success' },
                order: [['id', 'DESC']],
            });
            if (sucessoAnterior) {
                return await finish('ignored', `Reserva já processada com sucesso (caso #${sucessoAnterior.id}) - webhook duplicado ignorado.`);
            }
        }

        // ── 1. Reserva AO VIVO no CV - nunca confiar só no webhook ────────────
        console.log(`${tag} Consultando reserva no CV...`);
        const reservaResp = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
        const reserva = reservaResp.data?.[String(idreserva)] || reservaResp.data?.[idreserva];
        if (!reserva) throw new Error(`Reserva ${idreserva} não encontrada no CV.`);

        const { titular, unidade, situacao } = reserva;
        const dataCancel = reserva.data_cancelamento || reserva.data_distrato || null;
        const motivoCancel = reserva.descricao_motivo_cancelamento || reserva.descricao_motivo_distrato || null;

        await history.update({
            titular_nome: titular?.nome || null,
            titular_documento: digits(titular?.documento) || null,
            empreendimento: unidade?.empreendimento || null,
            idempreendimento_cv: unidade?.idempreendimento_cv || null,
            unidade_nome: unidade?.unidade || unidade?.bloco || null,
            idunidade_cv: unidade?.idunidade_cv || null,
            idunidade_int: unidade?.idunidade_int != null ? String(unidade.idunidade_int) : null,
            data_cancelamento: dataCancel,
            motivo_cancelamento: motivoCancel,
        });
        await ev('reserva_loaded',
            `Reserva carregada: situação CV "${situacao?.situacao || '?'}", unidade ${unidade?.unidade || '?'} (${unidade?.empreendimento || '?'}).`,
            'info', { situacao, data_cancelamento: reserva.data_cancelamento, data_distrato: reserva.data_distrato });

        // ── 2. Evidência de cancelamento ──────────────────────────────────────
        if (!dataCancel) {
            const motivo = `Reserva NÃO está cancelada/distratada no CV (situação atual: "${situacao?.situacao || '?'}", sem data de cancelamento/distrato). Nenhuma ação executada.`;
            console.warn(`${tag} ${motivo}`);
            return await finish('skipped', motivo);
        }
        await addCheck('Cancelamento confirmado no CV',
            true, `data ${formatDateBr(dataCancel)}${motivoCancel ? ` - motivo: ${motivoCancel}` : ''} (situação CV: "${situacao?.situacao || '?'}").`);

        // A partir daqui os finalizadores podem mexer no workflow CV.
        reservaCtx = { situacaoId: Number(situacao?.idsituacao) || null };

        const unitIdSienge = digits(unidade?.idunidade_int) ? Number(digits(unidade.idunidade_int)) : null;

        // ── 3. Contratos no Sienge ────────────────────────────────────────────
        console.log(`${tag} Buscando contrato no Sienge (externalId=${idreserva})...`);
        const porReserva = await fetchSalesContracts({ externalId: String(idreserva) });
        const ativosReserva = porReserva.filter(isContratoAtivo);

        let ativosUnidade = null;
        if (unitIdSienge) {
            const porUnidade = await fetchSalesContracts({ unitId: unitIdSienge });
            ativosUnidade = porUnidade.filter(isContratoAtivo);
        }

        // ══ Ramo A: SEM contrato ativo pra reserva ════════════════════════════
        if (ativosReserva.length === 0) {
            await ev('contract_none', 'Nenhum contrato de venda ativo no Sienge para esta reserva.');

            if (!unitIdSienge) {
                return await finishBlocked('Sem contrato no Sienge pela reserva, mas a reserva não tem código interno de unidade (idunidade_int) - impossível garantir a disponibilidade no Sienge.');
            }
            // Referência 1: busca por externalId (= idreserva) já retornou vazio.
            await addCheck('Sem contrato ativo pela reserva (externalId)', true,
                `busca por externalId ${idreserva} sem contratos ativos.`);

            // Referência 2: unidade (id global da unidade no Sienge).
            if (ativosUnidade.length > 0) {
                const lista = ativosUnidade.map(c => `nº ${c.number} (ID ${c.id}, ${c.situation}, reserva CV ${c.externalId || '?'})`).join('; ');
                return await finishBlocked(`Existe contrato ativo de OUTRA reserva na unidade no Sienge: ${lista}. Unidade não será liberada.`);
            }
            await addCheck('Sem contrato ativo na unidade', true,
                `busca por unitId ${unitIdSienge} sem contratos ativos (empreendimento e empresa implícitos - o id da unidade é único no Sienge).`);

            // Referência 3: número de integração (CVMENIN{unidade}{reserva}).
            const numeroIntegracao = `CVMENIN${unitIdSienge}${idreserva}`;
            const porNumero = (await fetchSalesContracts({ number: numeroIntegracao })).filter(isContratoAtivo);
            if (porNumero.length > 0) {
                const lista = porNumero.map(c => `nº ${c.number} (ID ${c.id}, ${c.situation})`).join('; ');
                return await finishBlocked(`Contrato ativo localizado pelo número de integração ${numeroIntegracao}: ${lista}. Unidade não será liberada.`);
            }
            await addCheck('Sem contrato ativo pelo número de integração', true,
                `nenhum contrato ativo com número ${numeroIntegracao}.`);

            // Referência 4: documento do titular → clientes Sienge → contratos.
            const docTitular = digits(titular?.documento);
            if (docTitular) {
                try {
                    const clientesSienge = await buscarClientesPorDocumento(docTitular);
                    const suspeitos = [];
                    for (const cli of clientesSienge) {
                        const doCliente = (await fetchSalesContracts({ customerId: cli.id })).filter(isContratoAtivo);
                        suspeitos.push(...doCliente.filter(c =>
                            String(c.externalId || '') === String(idreserva)
                            || [].concat(c.salesContractUnits || []).some(u => Number(u.id) === unitIdSienge)));
                    }
                    if (suspeitos.length > 0) {
                        const lista = suspeitos.map(c => `nº ${c.number} (ID ${c.id}, ${c.situation})`).join('; ');
                        return await finishBlocked(`Contrato ativo do titular (documento ${docTitular}) vinculado a esta reserva/unidade: ${lista}. Unidade não será liberada.`);
                    }
                    await addCheck('Documento do titular sem contrato ativo nesta unidade', true,
                        `${clientesSienge.length} cliente(s) Sienge com o documento ${docTitular}; nenhum contrato ativo nesta unidade/reserva.`);
                } catch (err) {
                    // Referências 1-3 já garantem a unidade; falha aqui vira aviso.
                    const detail = describeApiError(err);
                    warnings.push({ etapa: 'validacao_documento', erro: detail });
                    await ev('check_failed', `Busca de contratos pelo documento do titular indisponível: ${detail}`, 'warning');
                }
            }

            // Gate do Ato (Boleto Caixa) - mesmo sem contrato no Sienge, não
            // libera a unidade com boleto de ato pendente/pago/em processamento
            // (ex.: ato emitido mas o envio do contrato ao Sienge falhou).
            const atoSemContrato = await validarAto(idreserva);
            // Boleto que segue vivo até vencer não barra o cancelamento, mas
            // precisa aparecer: vira aviso na tela, não só linha de log.
            if (atoSemContrato.aviso) warnings.push({ etapa: 'boleto_ato', erro: atoSemContrato.aviso });
            if (!(await addCheck('Ato sem boleto pendente/pago', atoSemContrato.ok, atoSemContrato.detalhe))) {
                return await finishBlocked(`Gate do ato barrou a liberação da unidade: ${atoSemContrato.detalhe}`);
            }

            // Sucesso: garante a etapa Cancelada, libera a unidade e registra.
            await aplicarSituacaoCv(settings.situacao_cancelada_id, 'Cancelada');
            const liberada = await disponibilizarUnidadeCv(history, unidade, ev, warnings);
            if (!liberada) {
                return await finishError('Falha ao disponibilizar a unidade no CV (ver avisos). Reprocesse pela tela.', { cv_unidade_disponibilizada: false });
            }
            const msg = await sendCvMessage(idreserva, mensagemSucessoSemContrato(history, checks));
            if (msg.ok) await ev('cv_message_sent', 'Mensagem de conclusão registrada na reserva CV.');
            else warnings.push({ etapa: 'cv_mensagem', erro: msg.error });

            console.log(`${tag} ✓ Concluído sem contrato - unidade liberada no CV.`);
            return await finish('success', null, { cv_unidade_disponibilizada: true, cv_mensagem_enviada: !!msg.ok });
        }

        // ══ Ramo B: ambiguidade ═══════════════════════════════════════════════
        if (ativosReserva.length > 1) {
            const lista = ativosReserva.map(c => `nº ${c.number} (ID ${c.id}, ${c.situation})`).join('; ');
            return await finishBlocked(`Mais de 1 contrato ativo no Sienge pra esta reserva: ${lista}. Nada foi excluído.`);
        }

        // ══ Ramo C: exatamente 1 contrato - validar tudo antes de excluir ═════
        const contrato = ativosReserva[0];
        await history.update({
            contrato_id: contrato.id,
            contrato_numero: contrato.number || null,
            contrato_situacao: contrato.situation || null,
            contrato_valor: contrato.value ?? null,
        });
        await ev('contract_found', `Contrato localizado: nº ${contrato.number} (ID ${contrato.id}, situação "${contrato.situation}").`, 'info', contratoResumo(contrato));

        let allOk = true;

        // 3.1 Situação deletável
        const situacaoOk = normalizeName(contrato.situation) === normalizeName(SITUACAO_DELETAVEL) && !contrato.issueDate;
        allOk = (await addCheck('Contrato aguardando emissão', situacaoOk,
            situacaoOk
                ? `situação "${contrato.situation}", sem data de emissão.`
                : `situação "${contrato.situation}"${contrato.issueDate ? `, EMITIDO em ${formatDateBr(contrato.issueDate)}` : ''} - só contratos "${SITUACAO_DELETAVEL}" sem emissão podem ser excluídos.`)) && allOk;

        // 3.2 Unidade do contrato = unidade da reserva
        const unidadesContrato = [].concat(contrato.salesContractUnits || []);
        let unidadeOk = false;
        let unidadePorId = false; // casou pelo id interno (único no Sienge) = identidade forte
        let unidadeDetalhe = '';
        if (unidadesContrato.length !== 1) {
            unidadeDetalhe = `contrato com ${unidadesContrato.length} unidades vinculadas (esperado: 1).`;
        } else if (unitIdSienge && Number(unidadesContrato[0].id) === unitIdSienge) {
            unidadeOk = true;
            unidadePorId = true;
            unidadeDetalhe = `unidade ${unidadesContrato[0].id} ("${unidadesContrato[0].name}") = código interno da reserva.`;
        } else if (!unitIdSienge && normalizeName(unidadesContrato[0].name) === normalizeName(unidade?.unidade)) {
            unidadeOk = true;
            unidadeDetalhe = `nome da unidade confere ("${unidadesContrato[0].name}") - reserva sem código interno, comparação por nome.`;
            warnings.push({ etapa: 'validacao_unidade', erro: 'Comparação por nome (idunidade_int ausente na reserva).' });
        } else {
            unidadeDetalhe = `unidade do contrato (${unidadesContrato[0]?.id} "${unidadesContrato[0]?.name}") ≠ unidade da reserva (${unitIdSienge ?? '?'} "${unidade?.unidade}").`;
        }
        allOk = (await addCheck('Unidade do contrato = unidade da reserva', unidadeOk, unidadeDetalhe)) && allOk;

        // 3.3 Empreendimento/empresa - por código, com várias fontes.
        const CHECK_EMP = 'Empreendimento/empresa do contrato conferem com a reserva';
        const vinculo = await conferirEmpreendimento(contrato, unidade);
        if (vinculo.ok) {
            await addCheck(CHECK_EMP, true, vinculo.detalhe);
        } else if (unidadePorId) {
            // O id da unidade é único no Sienge e o contrato aponta exatamente
            // pra unidade da reserva - isso já amarra contrato × reserva. Uma
            // divergência de código aqui é cadastro do CV (empreendimento sem
            // CC, etapa sem código), não contrato de outra venda. Vira aviso.
            await addCheck(CHECK_EMP, true,
                `conferido pela unidade ${unitIdSienge}, cujo id é único no Sienge - os códigos de empreendimento/empresa não confirmaram (${vinculo.detalhe}).`);
            warnings.push({ etapa: 'validacao_empreendimento', erro: vinculo.detalhe });
        } else {
            allOk = (await addCheck(CHECK_EMP, false,
                `${vinculo.detalhe} A unidade também não foi confirmada por código interno - bloqueado por segurança.`)) && allOk;
        }

        // 3.4 Cliente
        const cliente = await validarCliente(contrato, titular);
        allOk = (await addCheck('Cliente do contrato = titular da reserva', cliente.ok, cliente.detalhe)) && allOk;

        // 3.5 Nenhuma parcela paga
        const condicoes = [].concat(contrato.paymentConditions || []);
        const totalPago = condicoes.reduce((s, p) => s + (Number(p?.amountPaid) || 0), 0);
        allOk = (await addCheck('Nenhuma parcela paga no contrato', totalPago === 0,
            totalPago === 0
                ? 'amountPaid total = 0.'
                : `contrato já recebeu R$ ${totalPago.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`)) && allOk;

        // 3.6 Gate do Ato (Boleto Caixa)
        const ato = await validarAto(idreserva);
        if (ato.aviso) warnings.push({ etapa: 'boleto_ato', erro: ato.aviso });
        allOk = (await addCheck('Ato sem boleto pendente/pago', ato.ok, ato.detalhe)) && allOk;

        // 3.7 Nenhum OUTRO contrato ativo na unidade
        if (unitIdSienge && ativosUnidade) {
            const outros = ativosUnidade.filter(c => Number(c.id) !== Number(contrato.id));
            allOk = (await addCheck('Único contrato ativo na unidade', outros.length === 0,
                outros.length === 0
                    ? 'nenhum outro contrato ativo na unidade no Sienge.'
                    : `outros contratos ativos na unidade: ${outros.map(c => `nº ${c.number} (${c.situation})`).join('; ')}.`)) && allOk;
        }

        if (!allOk) {
            const falhas = checks.filter(c => !c.ok).map(c => `${c.check} - ${c.detalhe}`).join(' | ');
            return await finishBlocked(`Validação reprovada: ${falhas}`);
        }

        // ── 4. EXCLUSÃO no Sienge ─────────────────────────────────────────────
        console.log(`${tag} Todas as validações aprovadas. Excluindo contrato ${contrato.id} no Sienge...`);
        try {
            await apiSienge.delete(`/v1/sales-contracts/${contrato.id}`);
        } catch (err) {
            const detail = describeApiError(err);
            await ev('error', `DELETE do contrato ${contrato.id} falhou: ${detail}`, 'error', { httpStatus: err?.response?.status });
            return await finishError(`Sienge recusou a exclusão do contrato nº ${contrato.number}: ${detail}. Nada foi alterado no Sienge.`);
        }
        await ev('contract_deleted', `DELETE /sales-contracts/${contrato.id} executado (contrato nº ${contrato.number}).`, 'success');

        // 4b. Confirma por releitura - só toca no CV com a exclusão comprovada.
        const conferencia = (await fetchSalesContracts({ externalId: String(idreserva) })).filter(isContratoAtivo);
        if (conferencia.some(c => Number(c.id) === Number(contrato.id))) {
            await ev('error', 'Releitura ainda encontra o contrato ativo - exclusão NÃO confirmada.', 'error');
            return await finishError(`Sienge aceitou o DELETE mas o contrato nº ${contrato.number} ainda aparece ativo na releitura. Nada foi alterado no CV. Verifique no Sienge e reprocesse.`);
        }
        await ev('delete_confirmed', 'Releitura confirmou: contrato não existe mais no Sienge.', 'success');
        await history.update({ sienge_contrato_excluido: true });

        // 4c. Releitura por UNIDADE: garante que nenhum outro contrato ativo
        // segura a unidade no Sienge antes de liberá-la no CV.
        if (unitIdSienge) {
            const restantes = (await fetchSalesContracts({ unitId: unitIdSienge })).filter(isContratoAtivo);
            if (restantes.length > 0) {
                const lista = restantes.map(c => `nº ${c.number} (${c.situation})`).join('; ');
                return await finishError(`Contrato excluído, mas a unidade ainda tem contrato ativo no Sienge: ${lista}. Unidade NÃO liberada no CV.`);
            }
            await ev('delete_confirmed', 'Releitura por unidade confirmou: nenhum contrato ativo restante na unidade.', 'success');
        }

        // ── 5. Garante a etapa Cancelada e disponibiliza a unidade no CV ──────
        await aplicarSituacaoCv(settings.situacao_cancelada_id, 'Cancelada');
        const liberada = await disponibilizarUnidadeCv(history, unidade, ev, warnings);
        if (!liberada) {
            return await finishError(
                'Contrato excluído no Sienge, mas FALHOU a disponibilização da unidade no CV (ver avisos). Reprocesse pela tela - a nova tentativa reconfere o Sienge e libera a unidade.',
                { cv_unidade_disponibilizada: false });
        }

        // ── 6. Mensagem final na reserva ──────────────────────────────────────
        const msg = await sendCvMessage(idreserva, mensagemSucessoComDelete(history, contrato, checks));
        if (msg.ok) await ev('cv_message_sent', 'Mensagem de conclusão registrada na reserva CV.');
        else warnings.push({ etapa: 'cv_mensagem', erro: msg.error });

        console.log(`${tag} ✓ Concluído - contrato ${contrato.id} excluído e unidade liberada.`);
        return await finish('success', null, { cv_unidade_disponibilizada: true, cv_mensagem_enviada: !!msg.ok });

    } catch (err) {
        const detail = describeApiError(err);
        console.error(`${tag} ✗ Erro: ${detail}`);
        await ev('error', detail, 'error');
        // finishError também move a reserva pra Pendência (se a reserva já foi
        // confirmada como cancelada nesta execução).
        return finishError(detail).catch(() => history);
    }
}

/**
 * Disponibiliza a unidade no CV (POST unidades/bloquear com situacao Disponivel).
 * Retorna true/false; falha vira warning (decisão de status é do chamador).
 */
async function disponibilizarUnidadeCv(history, unidade, ev, warnings) {
    const idunidadeCv = unidade?.idunidade_cv;
    if (!idunidadeCv) {
        warnings.push({ etapa: 'cv_unidade', erro: 'Reserva sem idunidade_cv - impossível disponibilizar via API.' });
        await ev('error', 'Reserva sem idunidade_cv - unidade não pode ser disponibilizada via API.', 'error');
        return false;
    }
    const tag = `[RESERVA-CANCEL][CV-UNIDADE][reserva ${history.idreserva}]`;
    try {
        const resp = await apiCv.post('/v1/cadastros/empreendimentos/unidades/bloquear', {
            idunidade: String(idunidadeCv),
            situacao: 'Disponivel',
        });
        if (!isCvResponseOk(resp.data)) {
            const detail = resp.data?.error || resp.data?.erro || resp.data?.mensagem || 'erro lógico do CV';
            console.warn(`${tag} ✗ HTTP ${resp.status} com erro lógico: ${detail}`);
            warnings.push({ etapa: 'cv_unidade', erro: String(detail), httpStatus: resp.status });
            await ev('error', `Disponibilizar unidade falhou (erro lógico CV): ${detail}`, 'error');
            return false;
        }
        console.log(`${tag} ✓ Unidade ${idunidadeCv} disponibilizada (HTTP ${resp.status}).`);
        await ev('cv_unit_released', `Unidade ${history.unidade_nome || idunidadeCv} disponibilizada no CV.`, 'success');
        return true;
    } catch (err) {
        const detail = describeApiError(err);
        console.error(`${tag} ✗ Falha: ${detail}`);
        warnings.push({ etapa: 'cv_unidade', erro: detail, httpStatus: err?.response?.status || null });
        await ev('error', `Disponibilizar unidade falhou: ${detail}`, 'error');
        return false;
    }
}

export default { processReservaCancel };
