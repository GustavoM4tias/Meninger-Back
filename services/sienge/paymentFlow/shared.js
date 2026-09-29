// services/sienge/paymentFlow/shared.js
//
// Peças usadas por mais de um módulo da esteira (Fornecedor, Contrato,
// Medição, Título). Saíram do antigo PaymentFlowPipelineService sem mudança
// de comportamento.

import axios from 'axios';
import db from '../../../models/sequelize/index.js';
import { SiengeContractService } from '../SiengeContractService.js';
import { EnterpriseResolverService } from '../EnterpriseResolverService.js';
import { decrypt } from '../../../utils/encryption.js';
import { recipeOf } from './recipe.js';

export const Model = () => db.PaymentLaunch;

/** Busca e descriptografa as credenciais Sienge do usuário */
export async function getUserSiengeCredentials(userId) {
    if (!userId) return {};
    try {
        const user = await db.User.findByPk(userId, {
            attributes: ['sienge_email', 'sienge_password'],
        });
        if (!user?.sienge_email || !user?.sienge_password) return {};
        const email = decrypt(user.sienge_email);
        const password = decrypt(user.sienge_password);
        if (!email || !password) return {};
        return { email, password };
    } catch {
        return {};
    }
}

export async function patch(launch, data) {
    await launch.update(data);
    return launch;
}

export async function loadLaunch(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch) throw new Error(`Lançamento ${launchId} não encontrado`);
    return launch;
}

/** Configuração do tipo (linha de launch_type_configs) - null se não achar. */
export async function typeConfigOf(launchType) {
    if (!launchType) return null;
    return db.LaunchTypeConfig.findOne({ where: { name: launchType } }).catch(() => null);
}

/** Receita + regras do tipo do lançamento, normalizadas (default = modo auto). */
export async function recipeOfLaunch(launch) {
    const cfg = await typeConfigOf(launch.launchType);
    return { typeConfig: cfg, ...recipeOf(cfg) };
}

/** Mensagem do portão gravada no lançamento, no mesmo campo que a tela já mostra. */
export function gateMessage(motivos) {
    return `Portão de regras: ${motivos.join(' | ')}`;
}

// ── helpers de data ───────────────────────────────────────────────────────────
export function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

export function endOfYear(year) {
    return `${year || new Date().getFullYear()}-12-31`;
}

// ── Resolve enterpriseId / companyId do lançamento ───────────────────────────
export async function resolveEnterpriseIds(launch) {
    // Se o lançamento já tem ambos, usa direto
    if (launch.enterpriseId && launch.companyId) {
        return { erpId: launch.enterpriseId, companyId: launch.companyId };
    }

    // Tenta buscar via enterprises pelo enterpriseId salvo
    if (launch.enterpriseId) {
        const ec = await EnterpriseResolverService.getByErpId(launch.enterpriseId);
        if (ec) return { erpId: ec.erpId, companyId: ec.companyId };
    }

    // Tenta resolver pelo nome do empreendimento
    if (launch.enterpriseName) {
        const { best } = await EnterpriseResolverService.resolveByName(launch.enterpriseName);
        if (best) return { erpId: best.erpId, companyId: best.companyId };
    }

    return { erpId: null, companyId: launch.companyId || null };
}

// ── Anexar arquivos do lançamento à medição criada ────────────────────────────
export async function attachMeasurementFiles(launch, buildingId, measurementNumber) {
    const files = [];

    if (launch.nfUrl) {
        files.push({
            url: launch.nfUrl,
            filename: launch.nfFilename || 'nota-fiscal.pdf',
            description: `Nota Fiscal${launch.nfNumber ? ` #${launch.nfNumber}` : ''}`,
            mimeType: 'application/pdf',
        });
    }

    if (launch.boletoUrl) {
        files.push({
            url: launch.boletoUrl,
            filename: launch.boletoFilename || 'boleto.pdf',
            description: 'Boleto',
            mimeType: 'application/pdf',
        });
    }

    const extras = Array.isArray(launch.extraAttachments) ? launch.extraAttachments : [];
    extras.forEach((att, i) => {
        if (att?.url) {
            files.push({
                url: att.url,
                filename: att.filename || `anexo-extra-${i + 1}.pdf`,
                description: att.description || `Anexo Extra ${i + 1}`,
                mimeType: att.mimeType || 'application/pdf',
            });
        }
    });

    const results = [];
    for (const file of files) {
        try {
            const { data: buffer } = await axios.get(file.url, {
                responseType: 'arraybuffer',
                timeout: 30000,
            });

            await SiengeContractService.attachMeasurementFile({
                documentId: launch.siengeDocumentId,
                contractNumber: launch.siengeContractNumber,
                buildingId: Number(buildingId),
                measurementNumber: Number(measurementNumber),
                description: file.description,
                fileBuffer: Buffer.from(buffer),
                filename: file.filename,
                mimeType: file.mimeType,
            });

            console.log(`📎 [Pipeline] Anexo "${file.description}" enviado com sucesso`);
            results.push({ file: file.description, ok: true });
        } catch (err) {
            console.warn(`⚠️  [Pipeline] Falha ao anexar "${file.description}": ${err.message}`);
            results.push({ file: file.description, ok: false, error: err.message });
        }
    }

    return results;
}
