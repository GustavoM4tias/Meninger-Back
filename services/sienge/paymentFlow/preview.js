// services/sienge/paymentFlow/preview.js
//
// Prévia de um lançamento ANTES de ele existir: roda o portão inteiro, com
// consultas SÓ DE LEITURA ao Sienge (credor, contratos, saldo), e diz o que a
// esteira vai fazer. Não grava nada, não abre Playwright.
//
// Usada pela Eme (cartão de confirmação) e pela rota de prévia da tela. A
// confirmação cria o lançamento pelo MESMO caminho da tela e roda a prévia de
// novo - o que a prévia recusa, a confirmação também recusa.

import db from '../../../models/sequelize/index.js';
import { SiengeCreditorService } from '../SiengeCreditorService.js';
import { SiengeContractService, DEFAULT_BUILDING_UNIT } from '../SiengeContractService.js';
import { getScope, isErpAllowed } from '../../permissions/accessScopeService.js';
import { recipeOf, stepsOf } from './recipe.js';
import { checkLaunchInput, checkCreditor, pickExistingContract, mergeResults } from './gate.js';
import { pickMeasurementItem } from './measurementItem.js';
import { resolveEnterpriseIds } from './shared.js';
import { resolverItemOrcamento, procurarDuplicado, numeroPorData } from './modules/tituloDireto.js';

const onlyDigits = s => String(s || '').replace(/\D/g, '');

/**
 * @param {object} draft - campos do lançamento (mesmo formato do POST /payment-flow)
 * @param {object} user  - usuário do servidor (id, role) - escopo de empreendimento
 * @returns {Promise<{ ok, motivos, avisos, passos, tipo, credor, contrato, item, draft }>}
 */
export async function previewLaunch(draft, user) {
    const motivos = [];
    const avisos = [];
    const out = { ok: false, motivos, avisos, passos: [], tipo: null, credor: null, contrato: null, item: null, draft };

    // ── Tipo e receita ────────────────────────────────────────────────────────
    const type = draft.launchType
        ? await db.LaunchTypeConfig.findOne({ where: { name: draft.launchType, active: true } })
        : null;
    if (!type) {
        motivos.push(draft.launchType
            ? `Tipo de lançamento "${draft.launchType}" não existe ou está inativo.`
            : 'Tipo de lançamento não informado.');
        return out;
    }
    const { receita, regras } = recipeOf(type);
    out.tipo = { name: type.name, documento: type.documento, receita, regras };
    out.passos = stepsOf(receita);

    // Defaults do tipo, como o POST da tela faz.
    const d = {
        ...draft,
        budgetItem: draft.budgetItem || type.budgetItem,
        budgetItemCode: draft.budgetItemCode || type.budgetItemCode || null,
        financialAccountNumber: draft.financialAccountNumber || type.financialAccountNumber,
    };
    out.draft = d;

    // ── Portão 1: dados do lançamento ─────────────────────────────────────────
    // Na prévia vale para todo tipo (inclusive os sem receita): é um aviso
    // antes de criar, e o que falta aqui vira erro lá na frente.
    const input = checkLaunchInput(d, { ...receita, configurada: true }, regras);
    if (receita.configurada) motivos.push(...input.motivos);
    else avisos.push(...input.motivos);
    avisos.push(...input.avisos);

    // ── Escopo: o empreendimento tem que estar liberado para quem lança ──────
    const { erpId, companyId } = await resolveEnterpriseIds(d).catch(() => ({ erpId: null, companyId: null }));
    if (d.enterpriseId || d.enterpriseName) {
        if (!erpId) motivos.push(`Empreendimento "${d.enterpriseName || d.enterpriseId}" não encontrado no cadastro.`);
        else {
            const scope = await getScope(user);
            if (!isErpAllowed(scope, erpId)) motivos.push('Você não tem acesso a este empreendimento.');
            d.enterpriseId = d.enterpriseId || erpId;
            d.companyId = d.companyId || companyId;
        }
    }

    // ── NF já lançada (mesma regra do POST) ──────────────────────────────────
    if (regras.bloquearNfDuplicada && d.nfNumber && d.providerCnpj) {
        const dup = await db.PaymentLaunch.findOne({
            where: {
                nfNumber: d.nfNumber,
                providerCnpj: d.providerCnpj,
                status: { [db.Sequelize.Op.ne]: 'cancelado' },
            },
            attributes: ['id', 'status'],
        });
        if (dup) motivos.push(`Já existe o lançamento #${dup.id} (${dup.status}) com a NF ${d.nfNumber} deste fornecedor.`);
    }

    // ── Sienge (leitura): credor ──────────────────────────────────────────────
    const doc = onlyDigits(d.providerCnpj);
    if (doc.length === 11 || doc.length === 14) {
        let creditor = null;
        try { creditor = await SiengeCreditorService.findByDocument(doc); }
        catch (err) { avisos.push(`Não consegui consultar o credor no Sienge agora (${err.message}).`); }
        if (creditor) {
            out.credor = { id: creditor.id, name: creditor.name, cnpj: creditor.cnpj, cpf: creditor.cpf };
            const c = checkCreditor(creditor, regras, d);
            if (receita.configurada) motivos.push(...c.motivos); else avisos.push(...c.motivos);

            // ── Contrato ──────────────────────────────────────────────────────
            if (receita.contrato === 'nenhum' && erpId) {
                // Título direto: sem contrato. Confere item de orçamento e duplicidade.
                try {
                    const it = await resolverItemOrcamento({ buildingId: erpId, nome: d.budgetItem, codigo: d.budgetItemCode });
                    if (!it) motivos.push(`Não achei o item de orçamento "${d.budgetItem}" na obra ${erpId}. Informe o código do item.`);
                    else out.item = { descricao: it.nome || d.budgetItem, codigo: it.codigo };
                    const emissao = String(d.nfIssueDate || new Date().toISOString()).slice(0, 10);
                    const documento = receita.titulo.documento || String(d.nfType || '').toUpperCase();
                    const dup = await procurarDuplicado({
                        creditorId: creditor.id, companyId, documento,
                        numero: d.nfNumber || numeroPorData(emissao), valor: d.unitPrice, emissao,
                    });
                    if (dup) motivos.push(`Possível duplicidade: ${dup.motivo}.`);
                    out.contrato = { label: null, acao: 'sem contrato (título direto)' };
                } catch (err) {
                    avisos.push(`Não consegui conferir o título no Sienge agora (${err.message}).`);
                }
            } else if (receita.contrato === 'existente' && erpId) {
                try {
                    const all = await SiengeContractService.findAllBySupplierId(creditor.id, companyId);
                    const pick = pickExistingContract(all, { receita, regras, buildingId: erpId });
                    if (!pick.contract) {
                        motivos.push(...pick.motivos, ...pick.descartados.map(x => `${x.contrato}: ${x.motivo}`));
                    } else {
                        const c2 = pick.contract;
                        out.contrato = {
                            label: `${c2.documentId}/${c2.contractNumber}`,
                            objeto: c2.object, inicio: c2.startDate, termino: c2.endDate,
                            descartados: pick.descartados,
                        };
                        const { items } = await SiengeContractService.validateItems(
                            c2.documentId, c2.contractNumber, erpId, DEFAULT_BUILDING_UNIT, d.unitPrice,
                        );
                        const it = pickMeasurementItem(items, {
                            budgetItem: d.budgetItem, budgetItemCode: d.budgetItemCode, value: d.unitPrice, strict: true,
                        });
                        if (!it.item) motivos.push(it.motivo);
                        else out.item = { descricao: it.item.description, saldo: it.balance };
                    }
                } catch (err) {
                    avisos.push(`Não consegui consultar os contratos no Sienge agora (${err.message}).`);
                }
            } else if (receita.contrato !== 'existente' && receita.contrato !== 'nenhum' && erpId) {
                try {
                    const c3 = await SiengeContractService.findBySupplierId(creditor.id, companyId, erpId);
                    if (!c3 || receita.contrato === 'criar') {
                        out.contrato = { label: c3 ? `${c3.documentId}/${c3.contractNumber}` : null, acao: 'criar novo' };
                    } else {
                        // Contrato existente: o item do tipo já tem saldo? Então a
                        // esteira para e pergunta antes de qualquer aditivo.
                        const { items } = await SiengeContractService.validateItems(
                            c3.documentId, c3.contractNumber, erpId, DEFAULT_BUILDING_UNIT, d.unitPrice,
                        );
                        const it = pickMeasurementItem(items, {
                            budgetItem: d.budgetItem, budgetItemCode: d.budgetItemCode, value: d.unitPrice,
                            strict: !!(d.budgetItem || d.budgetItemCode),
                        });
                        const cobre = it.item && it.balance + 0.005 >= Number(d.unitPrice || 0);
                        out.contrato = {
                            label: `${c3.documentId}/${c3.contractNumber}`,
                            acao: cobre ? 'medir no saldo (pede sua confirmação)' : 'aditivo',
                        };
                        if (cobre) {
                            out.item = { descricao: it.item.description, saldo: it.balance };
                            avisos.push(`O contrato ${out.contrato.label} já tem saldo (R$ ${it.balance.toFixed(2)}) no item "${it.item.description}": a esteira vai parar e perguntar se mede no saldo em vez de fazer aditivo.`);
                        }
                    }
                } catch (err) {
                    avisos.push(`Não consegui consultar os contratos no Sienge agora (${err.message}).`);
                }
            }
        } else if (!avisos.some(a => a.includes('credor'))) {
            avisos.push('Fornecedor não cadastrado no Sienge: a esteira para em "Credor não cadastrado" e oferece a RID.');
        }
    }

    const merged = mergeResults({ motivos, avisos });
    out.ok = merged.ok;
    return out;
}
