// services/sienge/paymentFlow/modules/contratoExistente.js
//
// Módulo CONTRATO - existente (receita `contrato: 'existente'`): o contrato já
// existe no Sienge, aprovado e com saldo (ex.: CTPJ do salário de gestor, com
// 12 verbas no ano). Nada é criado aqui: acha o contrato que a receita aceita,
// confere o saldo do item do tipo e libera a Medição direto, sem aditivo.
//
// Quem decide o contrato é o portão (gate.pickExistingContract): documento da
// receita, aprovado + autorizado, vigente e com a obra do lançamento. Por isso
// este modo não passa pelo "bloqueio de contrato manual" do modo auto - o
// contrato ser manual é justamente o esperado aqui.

import { SiengeContractService, DEFAULT_BUILDING_UNIT } from '../../SiengeContractService.js';
import { pickExistingContract } from '../gate.js';
import { pickMeasurementItem } from '../measurementItem.js';
import { loadLaunch, patch, resolveEnterpriseIds, gateMessage } from '../shared.js';

/**
 * @returns {{ ok: boolean, contract?: object, descartados?: object[], motivos?: string[] }}
 */
export async function stepUseExistingContract(launchId, { receita, regras }) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeCreditorId) throw new Error('Execute stepFindCreditor primeiro.');

    await patch(launch, { pipelineStage: 'searching_contract', status: 'contrato', siengeContractError: null });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    let all;
    try {
        all = await SiengeContractService.findAllBySupplierId(launch.siengeCreditorId, companyId);
    } catch (err) {
        await patch(launch, {
            pipelineStage: 'contract_not_found',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: `Erro ao buscar contratos: ${err.message}`,
        });
        throw err;
    }

    const { contract, motivos, descartados } = pickExistingContract(all, {
        receita, regras, buildingId: erpId || launch.enterpriseId,
    });

    if (!contract) {
        const detalhe = descartados.map(d => `${d.contrato}: ${d.motivo}`);
        await patch(launch, {
            pipelineStage: 'contract_rejected',
            siengeContractStatus: 'not_found',
            status: 'erro',
            siengeContractError: gateMessage([...motivos, ...detalhe]),
        });
        return { ok: false, motivos: [...motivos, ...detalhe], descartados };
    }

    await patch(launch, {
        pipelineStage: 'contract_found',
        siengeContractStatus: 'found',
        siengeDocumentId: contract.documentId,
        siengeContractNumber: contract.contractNumber,
        siengeContractApproval: contract.statusApproval,
        siengeContractAuthorized: contract.isAuthorized,
        siengeContractAuthLevel: contract.currentAuthorizationLevel || null,
        contractStartDate: contract.startDate || null,
        contractEndDate: contract.endDate || null,
        siengeContractRaw: contract,
    });

    // Saldo do item do tipo (não o maior saldo do contrato).
    const { items, error } = await SiengeContractService.validateItems(
        contract.documentId,
        contract.contractNumber,
        erpId || launch.enterpriseId,
        DEFAULT_BUILDING_UNIT,
        launch.unitPrice,
    );
    const pick = pickMeasurementItem(items, {
        budgetItem: launch.budgetItem,
        budgetItemCode: launch.budgetItemCode,
        value: launch.unitPrice,
        strict: true,
    });

    if (!pick.item) {
        const motivo = error ? `Não foi possível ler os itens do contrato: ${error}` : pick.motivo;
        await patch(launch, {
            pipelineStage: 'items_insufficient',
            status: 'erro',
            siengeItemsRaw: items,
            siengeItemBalanceOk: false,
            siengeItemBalanceAvailable: pick.balance || 0,
            siengeContractError: gateMessage([motivo]),
        });
        return { ok: false, motivos: [motivo], descartados };
    }

    await patch(launch, {
        pipelineStage: 'items_ok',
        siengeItemsRaw: items,
        siengeItemBalanceOk: true,
        siengeItemBalanceAvailable: pick.balance,
    });
    return { ok: true, contract, descartados };
}
