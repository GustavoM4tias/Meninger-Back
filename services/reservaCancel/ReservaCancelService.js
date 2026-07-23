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
//   5. Empreendimento do contrato = empreendimento da reserva.
//   6. Cliente do contrato = titular da reserva (CPF/CNPJ via /customers; nome como fallback).
//   7. Nenhuma parcela paga (amountPaid total = 0).
//   8. Gate do Ato (Boleto Caixa): só segue sem ato/série, ato baixado por
//      vencimento sem pagamento, ou geração com erro. Boleto emitido pendente,
//      pago ou em processamento = bloqueia.
//   9. Nenhum OUTRO contrato ativo na mesma unidade no Sienge.
//
// Sem contrato no Sienge: a unidade só é disponibilizada no CV se o Sienge
// confirmar a unidade como Disponível (GET /v1/units) e não houver contrato
// ativo na unidade.

import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import apiSienge from '../../lib/apiSienge.js';
import EventLogger from './ReservaCancelEventLogger.js';

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
 * Consulta a disponibilidade da unidade no Sienge (GET /v1/units/{id}).
 * `commercialStock` = 'D' significa Disponível no estoque comercial.
 * Requer o recurso "Unidades" liberado pro usuário da API no painel do Sienge.
 */
async function getUnitStock(unitId) {
    try {
        const { data } = await apiSienge.get(`/v1/units/${unitId}`);
        const stock = data?.commercialStock ?? null;
        return { ok: true, stock, available: String(stock).toUpperCase() === 'D', name: data?.name || null };
    } catch (err) {
        const status = err?.response?.status || null;
        if (status === 403) {
            return {
                ok: false, status,
                error: 'Sem permissão no recurso "Unidades" da API Sienge - libere o recurso pro usuário da API no painel do Sienge.',
            };
        }
        if (status === 404) return { ok: false, status, error: `Unidade ${unitId} não encontrada no Sienge.` };
        return { ok: false, status, error: describeApiError(err) };
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
 *            ou boleto baixado por vencimento sem pagamento (payment_status cancelled)
 *   barra  → boleto em processamento, emitido pendente, pago, ou estado incerto
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
        case 'pending':
            return { ok: false, detalhe: `Boleto do ato emitido e pendente (boleto #${boleto.id}, venc. ${formatDateBr(boleto.vencimento)}). Aguarde pagamento ou baixa por vencimento.` };
        default:
            return { ok: false, detalhe: `Estado do ato incerto (boleto #${boleto.id}, payment_status=${boleto.payment_status}) - bloqueado por segurança.` };
    }
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

function mensagemSucessoSemContrato(history, stockInfo) {
    return [
        '✅ Automação de cancelamento CV × Sienge concluída.',
        '',
        ...linhasBase(history),
        '',
        'Nenhum contrato de venda ativo no Sienge para esta reserva.',
        `Sienge confirmou a unidade como Disponível no estoque comercial${stockInfo ? ` (${stockInfo})` : ''}.`,
        '',
        'Ação executada:',
        '• Unidade DISPONIBILIZADA no CV.',
        '',
        `Registro completo: ${OFFICE_TELA} (caso #${history.id}).`,
    ].join('\n');
}

function mensagemBloqueio(history, motivo) {
    return [
        '⚠️ Automação de cancelamento CV × Sienge NÃO executou ações para esta reserva.',
        '',
        ...linhasBase(history),
        '',
        `Motivo: ${motivo}`,
        '',
        'Nenhum dado foi alterado no Sienge nem no CV.',
        `Trate manualmente ou reprocesse pela tela ${OFFICE_TELA} (caso #${history.id}).`,
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

    // Bloqueio = pendência manual: nada foi alterado; avisa na reserva CV.
    const finishBlocked = async (motivo) => {
        console.warn(`${tag} BLOQUEADO: ${motivo}`);
        await ev('blocked', motivo, 'warning');
        const msg = await sendCvMessage(idreserva, mensagemBloqueio(history, motivo));
        if (msg.ok) await ev('cv_message_sent', 'Mensagem de pendência registrada na reserva CV.');
        else warnings.push({ etapa: 'cv_mensagem', erro: msg.error });
        return finish('blocked', motivo, { cv_mensagem_enviada: !!msg.ok });
    };

    try {
        // ── 0. Kill-switch ────────────────────────────────────────────────────
        if (!settings.active && !manual) {
            console.log(`${tag} Automação desativada - registrando como skipped.`);
            return await finish('skipped', 'Automação desativada nas configurações. Reprocesse pela tela quando ativar.');
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
            if (ativosUnidade.length > 0) {
                const lista = ativosUnidade.map(c => `nº ${c.number} (ID ${c.id}, ${c.situation}, reserva CV ${c.externalId || '?'})`).join('; ');
                return await finishBlocked(`Existe contrato ativo de OUTRA reserva na unidade no Sienge: ${lista}. Unidade não será liberada.`);
            }
            const stock = await getUnitStock(unitIdSienge);
            await ev('unit_stock', stock.ok
                ? `Estoque comercial da unidade no Sienge: "${stock.stock}"${stock.available ? ' (Disponível)' : ''}.`
                : `Falha ao consultar unidade no Sienge: ${stock.error}`, stock.ok && stock.available ? 'info' : 'warning');
            if (!stock.ok) {
                return await finishBlocked(`Não foi possível garantir a disponibilidade da unidade no Sienge: ${stock.error}`);
            }
            if (!stock.available) {
                return await finishBlocked(`Unidade consta no Sienge com estoque comercial "${stock.stock}" (diferente de Disponível) mesmo sem contrato ativo. Conferir manualmente.`);
            }
            await addCheck('Unidade disponível no Sienge', true, `sem contrato ativo na unidade e estoque comercial "D" (Disponível).`);

            const liberada = await disponibilizarUnidadeCv(history, unidade, ev, warnings);
            if (!liberada) {
                return finish('error', 'Falha ao disponibilizar a unidade no CV (ver warnings). Reprocesse pela tela.', { cv_unidade_disponibilizada: false });
            }
            const msg = await sendCvMessage(idreserva, mensagemSucessoSemContrato(history, `unidade ${unitIdSienge}`));
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
        let unidadeDetalhe = '';
        if (unidadesContrato.length !== 1) {
            unidadeDetalhe = `contrato com ${unidadesContrato.length} unidades vinculadas (esperado: 1).`;
        } else if (unitIdSienge && Number(unidadesContrato[0].id) === unitIdSienge) {
            unidadeOk = true;
            unidadeDetalhe = `unidade ${unidadesContrato[0].id} ("${unidadesContrato[0].name}") = código interno da reserva.`;
        } else if (!unitIdSienge && normalizeName(unidadesContrato[0].name) === normalizeName(unidade?.unidade)) {
            unidadeOk = true;
            unidadeDetalhe = `nome da unidade confere ("${unidadesContrato[0].name}") - reserva sem código interno, comparação por nome.`;
            warnings.push({ etapa: 'validacao_unidade', erro: 'Comparação por nome (idunidade_int ausente na reserva).' });
        } else {
            unidadeDetalhe = `unidade do contrato (${unidadesContrato[0]?.id} "${unidadesContrato[0]?.name}") ≠ unidade da reserva (${unitIdSienge ?? '?'} "${unidade?.unidade}").`;
        }
        allOk = (await addCheck('Unidade do contrato = unidade da reserva', unidadeOk, unidadeDetalhe)) && allOk;

        // 3.3 Empreendimento
        const empIntCv = digits(unidade?.idempreendimento_int);
        if (empIntCv) {
            const empOk = digits(contrato.enterpriseId) === empIntCv;
            allOk = (await addCheck('Empreendimento do contrato = empreendimento da reserva', empOk,
                empOk
                    ? `empreendimento ${contrato.enterpriseId} (${contrato.enterpriseName || '-'}).`
                    : `contrato no empreendimento ${contrato.enterpriseId} × reserva no ${empIntCv}.`)) && allOk;
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
            return await finish('error', `Sienge recusou a exclusão do contrato nº ${contrato.number}: ${detail}. Nada foi alterado no CV.`);
        }
        await ev('contract_deleted', `DELETE /sales-contracts/${contrato.id} executado (contrato nº ${contrato.number}).`, 'success');

        // 4b. Confirma por releitura - só toca no CV com a exclusão comprovada.
        const conferencia = (await fetchSalesContracts({ externalId: String(idreserva) })).filter(isContratoAtivo);
        if (conferencia.some(c => Number(c.id) === Number(contrato.id))) {
            await ev('error', 'Releitura ainda encontra o contrato ativo - exclusão NÃO confirmada.', 'error');
            return await finish('error', `Sienge aceitou o DELETE mas o contrato nº ${contrato.number} ainda aparece ativo na releitura. Nada foi alterado no CV. Verifique no Sienge e reprocesse.`);
        }
        await ev('delete_confirmed', 'Releitura confirmou: contrato não existe mais no Sienge.', 'success');
        await history.update({ sienge_contrato_excluido: true });

        // 4c. Estoque da unidade pós-exclusão (informativo - não bloqueia).
        if (unitIdSienge) {
            const stock = await getUnitStock(unitIdSienge);
            if (stock.ok && !stock.available) {
                warnings.push({ etapa: 'sienge_unidade', erro: `Após a exclusão, unidade ainda consta com estoque "${stock.stock}" no Sienge.` });
            }
            await ev('unit_stock', stock.ok
                ? `Estoque comercial da unidade após exclusão: "${stock.stock}".`
                : `Consulta de unidade indisponível após exclusão: ${stock.error}`, 'info');
        }

        // ── 5. Disponibiliza a unidade no CV ──────────────────────────────────
        const liberada = await disponibilizarUnidadeCv(history, unidade, ev, warnings);
        if (!liberada) {
            return await finish('error',
                'Contrato excluído no Sienge, mas FALHOU a disponibilização da unidade no CV (ver warnings). Reprocesse pela tela - a nova tentativa reconfere o Sienge e libera a unidade.',
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
        return finish('error', detail).catch(() => history);
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
