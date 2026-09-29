// services/sienge/paymentFlow/runner.js
//
// Executor da esteira: lê a RECEITA do tipo e encadeia os módulos, passando
// pelo portão de regras antes de cada um.
//
//   auto       Fornecedor -> Contrato (acha: aditivo | não acha: criação) -> [autorização] -> Medição -> Título
//   existente  Fornecedor -> Contrato existente (portão) -> Medição -> Título
//   criar      Fornecedor -> Contrato criação -> [autorização] -> Medição -> Título
//
// Medição -> Título continua pelos pollers (scheduler), como sempre: a medição
// precisa ser autorizada no Sienge antes do título. Com "medição antes do
// documento", o poller para em `awaiting_document` até a nota chegar.

import db from '../../../models/sequelize/index.js';
import { checkLaunchInput, checkCreditor } from './gate.js';
import { Model, loadLaunch, patch, recipeOfLaunch, gateMessage } from './shared.js';
import { stepFindCreditor } from './modules/fornecedor.js';
import { stepFindContract } from './modules/contratoBusca.js';
import { stepCreateContract } from './modules/contratoCriacao.js';
import { stepCreateAdditive } from './modules/contratoAditivo.js';
import { stepUseExistingContract } from './modules/contratoExistente.js';
import { stepCreateMeasurement } from './modules/medicao.js';
import { stepCreateTitulo } from './modules/titulo.js';

// Estágios onde o Playwright pode ter travado (ou o portão recusou) — permite reprocessar
const STUCK_STAGES = [
    'creating_contract', 'creating_additive', 'creating_measurement', 'creating_titulo',
    'contract_manual_block', 'aborted', 'gate_blocked', 'contract_rejected',
];

async function aborted(launchId) {
    const l = await Model().findByPk(launchId, { attributes: ['pipelineStage'] });
    return l?.pipelineStage === 'aborted';
}

async function blockByGate(launch, motivos) {
    await patch(launch, {
        pipelineStage: 'gate_blocked',
        status: 'erro',
        siengeContractError: gateMessage(motivos),
    });
    console.warn(`⛔ [Pipeline] #${launch.id}: portão recusou - ${motivos.join(' | ')}`);
    return { stage: 'gate_blocked', blocked: true, motivos };
}

export async function runFullPipeline(launchId, userId = null) {
    const current = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
    const currentStage = current?.pipelineStage;

    // ── Retomada direta: não voltar atrás quando a etapa de medição ou título falhou ──
    if (currentStage === 'measurement_error') {
        console.log(`⏩ [Pipeline] #${launchId}: retomando da medição (stage: measurement_error)`);
        await current.update({ siengeMeasurementError: null });
        const result = await stepCreateMeasurement(launchId, userId);
        return { stage: result.success ? 'measurement_created' : 'measurement_error', ...result };
    }
    if (currentStage === 'titulo_error') {
        console.log(`⏩ [Pipeline] #${launchId}: retomando do título (stage: titulo_error)`);
        const result = await stepCreateTitulo(launchId, userId);
        return { stage: result.success ? 'titulo_created' : 'titulo_error', ...result };
    }
    if (currentStage === 'awaiting_document') {
        return { stage: 'awaiting_document', awaitingDocument: true };
    }

    // Captura se estava bloqueado manualmente ANTES de resetar o stage
    const bypassAutoCheck = currentStage === 'contract_manual_block';
    if (current && STUCK_STAGES.includes(currentStage)) {
        console.warn(`⚠️  [Pipeline] #${launchId}: stage "${currentStage}" travado — resetando para idle antes de reprocessar.`);
        await current.update({ pipelineStage: 'idle', siengeContractError: null });
    }

    const launch = await loadLaunch(launchId);
    const { receita, regras } = await recipeOfLaunch(launch);

    // ── Portão 1: dados do lançamento (só para tipos com receita configurada) ──
    if (receita.configurada) {
        const input = checkLaunchInput(launch, receita, regras);
        if (!input.ok) return blockByGate(launch, input.motivos);
    }

    // ── Módulo Fornecedor ─────────────────────────────────────────────────────
    const creditorResult = await stepFindCreditor(launchId);
    if (await aborted(launchId)) return { stage: 'aborted' };

    if (!creditorResult.found) {
        const l = await Model().findByPk(launchId, { attributes: ['ridEmailSent'] });
        return { stage: 'creditor_not_found', awaitingRegistration: !!l?.ridEmailSent, ...creditorResult };
    }

    if (receita.configurada) {
        const cred = checkCreditor(creditorResult.creditor, regras, launch);
        if (!cred.ok) return blockByGate(await loadLaunch(launchId), cred.motivos);
    }

    if (receita.contrato === 'existente') return runExisting(launchId, userId, { receita, regras });
    if (receita.contrato === 'criar') return runCreate(launchId, userId);
    return runAuto(launchId, userId, { bypassAutoCheck });
}

// ── Receita "existente": contrato aprovado com saldo -> medição direta ─────────
async function runExisting(launchId, userId, { receita, regras }) {
    const contract = await stepUseExistingContract(launchId, { receita, regras });
    if (!contract.ok) return { stage: 'contract_rejected', blocked: true, motivos: contract.motivos };
    if (await aborted(launchId)) return { stage: 'aborted' };

    const result = await stepCreateMeasurement(launchId, userId);
    return { stage: result.success ? 'awaiting_measurement_authorization' : 'measurement_error', ...result };
}

// ── Receita "criar": sempre contrato novo ─────────────────────────────────────
async function runCreate(launchId, userId) {
    const createResult = await stepCreateContract(launchId, userId);
    if (!createResult.success) return { stage: 'contract_error', ...createResult };
    const launch = await loadLaunch(launchId);
    await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'contrato' });
    return { stage: 'awaiting_authorization', ...createResult };
}

// ── Receita "auto": o comportamento de sempre ─────────────────────────────────
//   Tem contrato → Aditivo → awaiting_authorization → [scheduler] → Medição
//   Sem contrato → Cria    → awaiting_authorization → [scheduler] → Medição
async function runAuto(launchId, userId, { bypassAutoCheck }) {
    const contractResult = await stepFindContract(launchId);
    if (await aborted(launchId)) return { stage: 'aborted' };

    if (!contractResult.found) return runCreate(launchId, userId);

    // Contrato existente: valida se foi criado pela automação antes de criar aditivo
    const launch = await loadLaunch(launchId);

    // 1️⃣ O próprio lançamento teve o contrato criado pela automação (flag imutável)?
    // 2️⃣ Fallback: outro lançamento no banco criou o mesmo contrato anteriormente.
    const { Op } = db.Sequelize;
    const AUTOMATION_STAGES = [
        'contract_created', 'awaiting_authorization', 'additive_created', 'additive_error',
        'measurement_created', 'awaiting_measurement_authorization', 'creating_titulo',
        'titulo_created', 'titulo_error', 'awaiting_titulo_authorization', 'titulo_pago', 'ready',
    ];

    const selfCreated = launch.siengeContractCreatedByAutomation === true;
    const peerCreated = selfCreated ? null : await Model().findOne({
        where: {
            id: { [Op.ne]: launch.id },
            siengeDocumentId: launch.siengeDocumentId,
            siengeContractNumber: launch.siengeContractNumber,
            [Op.or]: [
                { siengeContractCreatedByAutomation: true },
                { siengeContractStatus: 'created' },
                { pipelineStage: { [Op.in]: AUTOMATION_STAGES } },
            ],
        },
    });

    const automationEvidence = selfCreated || peerCreated;

    if (!automationEvidence && !bypassAutoCheck) {
        // Contrato pré-existente (criado manualmente) — não cria aditivo automaticamente
        const msg = `Contrato ${launch.siengeDocumentId}/${launch.siengeContractNumber} encontrado no Sienge mas não foi criado pela automação. Requer verificação manual antes de prosseguir.`;
        await patch(launch, { pipelineStage: 'contract_manual_block', status: 'erro', siengeContractError: msg });
        console.warn(`⚠️  [Pipeline] #${launchId}: ${msg}`);
        return { stage: 'contract_manual_block', blocked: true, error: msg };
    }

    if (!automationEvidence && bypassAutoCheck) {
        // Usuário confirmou que o contrato pré-existente é válido — marca como criado pela automação
        console.log(`✅ [Pipeline] #${launchId}: bypass do bloqueio manual — marcando contrato como criado pela automação.`);
        await patch(launch, { siengeContractCreatedByAutomation: true, siengeContractError: null });
    }

    const additiveResult = await stepCreateAdditive(launchId, userId);
    if (!additiveResult.success) return { stage: 'additive_error', ...additiveResult };

    await patch(launch, { pipelineStage: 'awaiting_authorization', status: 'aditivo' });
    return { stage: 'awaiting_authorization', ...additiveResult };
}

export async function continueExistingContractPipeline(launchId, userId = null) {
    const launch = await loadLaunch(launchId);

    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Contrato não encontrado para prosseguir.');
    }

    // Marca como criado pela automação para futuras re-execuções não bloquearem
    await patch(launch, { siengeContractCreatedByAutomation: true, siengeContractError: null });

    const additiveResult = await stepCreateAdditive(launchId, userId);
    if (!additiveResult.success) {
        return { stage: 'additive_error', ...additiveResult };
    }

    const refreshed = await loadLaunch(launchId);
    await patch(refreshed, {
        pipelineStage: 'awaiting_authorization',
        status: 'aditivo',
        siengeContractError: null,
    });

    return { stage: 'awaiting_authorization', ...additiveResult };
}

export async function abortPipeline(launchId) {
    const launch = await loadLaunch(launchId);
    if (['titulo_pago', 'cancelado'].includes(launch.status)) {
        return { aborted: false, reason: 'already_finished' };
    }
    await launch.update({
        pipelineStage: 'aborted',
        status: 'erro',
        siengeContractError: 'Processo interrompido pelo usuário.',
    });
    console.log(`🛑 [Pipeline] #${launchId}: pipeline abortado pelo usuário.`);
    return { aborted: true };
}
