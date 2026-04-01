// controllers/paymentFlowController.js
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../../models/sequelize/index.js';
import {
    runFullPipeline,
    stepFindCreditor,
    stepFindContract,
    stepCreateContract,
    stepValidateItems,
    pollContractStatus,
    pollMeasurementStatus,
    pollTituloStatus,
    stepCreateTitulo,
    stepRegisterBoleto,
    stepUpdateBoleto,
    continueExistingContractPipeline,
    abortPipeline,
} from '../../services/sienge/PaymentFlowPipelineService.js';
import { sendEmail } from '../../email/email.service.js';
import { generateRidDocx } from '../../services/sienge/RidDocumentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RID_TEMPLATE_PATH = path.resolve(__dirname, '../../assets/RID_Modelo.docx');

const Model = () => db.PaymentLaunch;
const TypeModel = () => db.LaunchTypeConfig;

function actor(req) {
    // createdBy é NOT NULL — usa 0 como sentinela se authenticate não rodou
    return { id: req.user?.id || 0, name: req.user?.name || req.user?.username || 'Sistema' };
}

/** Retorna os defaults do tipo de lançamento direto do BD. */
async function typeDefaults(launchType) {
    if (!launchType) return {};
    try {
        const t = await TypeModel().findOne({
            where: { name: launchType, active: true },
            attributes: ['documento', 'budgetItem', 'budgetItemCode', 'financialAccountNumber'],
        });
        if (!t) return {};
        return {
            documento:             t.documento,
            budgetItem:            t.budgetItem,
            budgetItemCode:        t.budgetItemCode ? String(t.budgetItemCode) : null,
            financialAccountNumber: t.financialAccountNumber,
        };
    } catch { return {}; }
}

/** Retorna o lançamento se o usuário tem acesso (dono ou admin). Lança 403/404. */
async function ownedLaunch(req, id) {
    const isAdmin = req.user?.role === 'admin';
    const launch = await Model().findByPk(id ?? req.params.id);
    if (!launch) return { launch: null, status: 404, error: 'Lançamento não encontrado.' };
    if (!isAdmin && launch.createdBy !== req.user?.id) {
        return { launch: null, status: 403, error: 'Acesso não permitido.' };
    }
    return { launch };
}

// ── CREATE ────────────────────────────────────────────────────────────────────
export async function createLaunch(req, res, next) {
    try {
        const u = actor(req);
        const b = req.body;
        const td = b.launchType ? await typeDefaults(b.launchType) : {};
        const today = new Date().toISOString().slice(0, 10);
        const endOfYear = `${today.slice(0, 4)}-12-31`;

        // ── Verificação de duplicidade: mesmo nfNumber + providerCnpj (exceto cancelados) ──
        if (b.nfNumber && b.providerCnpj && !b.cancelExisting) {
            const existing = await Model().findOne({
                where: {
                    nfNumber: b.nfNumber,
                    providerCnpj: b.providerCnpj,
                    status: { [db.Sequelize.Op.ne]: 'cancelado' },
                },
                attributes: ['id', 'status', 'launchType', 'createdByName', 'createdAt', 'providerName', 'nfNumber'],
            });
            if (existing) {
                return res.status(409).json({
                    duplicate: true,
                    error: `Já existe um lançamento ativo com NF "${b.nfNumber}" para este fornecedor.`,
                    existing: existing.toJSON(),
                });
            }
        }

        // ── Cancelar lançamento anterior (se usuário confirmou) ───────────────
        if (b.cancelExisting) {
            const toCancel = await Model().findByPk(b.cancelExisting);
            if (toCancel && toCancel.status !== 'cancelado') {
                await toCancel.update({ status: 'cancelado', updatedBy: u.id, updatedByName: u.name });
            }
        }

        const launch = await Model().create({
            companyName: b.companyName || null,
            companyId: b.companyId || null,
            enterpriseName: b.enterpriseName || null,
            enterpriseId: b.enterpriseId || null,
            providerName: b.providerName || null,
            providerCnpj: b.providerCnpj || null,
            startDate: b.startDate || today,
            endDate: b.endDate || endOfYear,
            documentDate: b.documentDate || null,
            launchType: b.launchType,
            budgetItem: b.budgetItem || td.budgetItem || null,
            budgetItemCode: b.budgetItemCode || td.budgetItemCode || null,
            financialAccountNumber: b.financialAccountNumber || td.financialAccountNumber || null,
            allocationPercentage: b.allocationPercentage ?? 100,
            unitPrice: b.unitPrice || null,
            // Datas do contrato
            contractStartDate: b.contractStartDate || null,
            contractEndDate: b.contractEndDate || null,
            // NF
            nfUrl: b.nfUrl || null,
            nfPath: b.nfPath || null,
            nfFilename: b.nfFilename || null,
            nfNumber: b.nfNumber || null,
            nfType: b.nfType || null,
            nfIssueDate: b.nfIssueDate || null,
            // Boleto
            boletoUrl: b.boletoUrl || null,
            boletoPath: b.boletoPath || null,
            boletoFilename: b.boletoFilename || null,
            boletoBarcode: b.boletoBarcode || null,
            boletoIssueDate: b.boletoIssueDate || null,
            boletoDueDate: b.boletoDueDate || null,
            boletoAmount: b.boletoAmount || null,
            // Extras e IA
            extraAttachments: Array.isArray(b.extraAttachments) ? b.extraAttachments : [],
            aiExtractedData: b.aiExtractedData || null,
            aiModel: b.aiModel || null,
            aiTokensUsed: b.aiTokensUsed || null,
            // Meta
            status: 'fornecedor',
            notes: b.notes || null,
            createdBy: u.id,
            createdByName: u.name,
        });

        return res.status(201).json(launch);
    } catch (err) { next(err); }
}

// ── LIST ──────────────────────────────────────────────────────────────────────
export async function listLaunches(req, res, next) {
    try {
        const { Op } = db.Sequelize;
        const { status, excludeStatus, launchType, companyId, enterpriseId, search, createdBy, page = 1, limit = 20, dateFrom, dateTo } = req.query;
        const isAdmin = req.user?.role === 'admin';
        const userId = req.user?.id;

        const where = {};

        // ── Controle de acesso por usuário e cidade ───────────────────────────
        if (!isAdmin) {
            // Busca a cidade do usuário
            const user = await db.User.findByPk(userId, { attributes: ['city'] });
            const userCity = user?.city;

            // Empreendimentos na mesma cidade
            let cityEnterpriseIds = [];
            if (userCity) {
                const cityEnts = await db.EnterpriseCity.findAll({
                    where: db.Sequelize.where(
                        db.Sequelize.fn('COALESCE',
                            db.Sequelize.col('city_override'),
                            db.Sequelize.col('default_city')
                        ),
                        { [Op.iLike]: `%${userCity}%` }
                    ),
                    attributes: ['erp_id'],
                    raw: true,
                });
                cityEnterpriseIds = cityEnts.map(e => e.erp_id).filter(Boolean).map(String);
            }

            where[Op.or] = [
                { createdBy: userId },
                ...(cityEnterpriseIds.length ? [{ enterpriseId: { [Op.in]: cityEnterpriseIds } }] : []),
            ];
        } else if (createdBy) {
            where.createdBy = Number(createdBy);
        }

        // ── Filtro de período ─────────────────────────────────────────────────
        // Admin: sem restrição de data por padrão — aplica só se enviado explicitamente
        // Não-admin: padrão = mês corrente se não informado
        if (!isAdmin || dateFrom || dateTo) {
            const today = new Date();
            const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1);
            const defaultTo   = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
            where.createdAt = {
                [Op.gte]: dateFrom ? new Date(dateFrom) : defaultFrom,
                [Op.lte]: dateTo   ? new Date(dateTo + 'T23:59:59.999Z') : defaultTo,
            };
        }

        // ── Filtros adicionais ────────────────────────────────────────────────
        if (status) {
            where.status = status;
        } else if (excludeStatus) {
            const excluded = excludeStatus.split(',').map(s => s.trim()).filter(Boolean);
            where.status = excluded.length === 1
                ? { [Op.ne]: excluded[0] }
                : { [Op.notIn]: excluded };
        }
        if (launchType) where.launchType = launchType;
        if (companyId) where.companyId = Number(companyId);
        if (enterpriseId) where.enterpriseId = Number(enterpriseId);
        if (search) {
            const searchConds = [
                { providerName: { [Op.iLike]: `%${search}%` } },
                { companyName: { [Op.iLike]: `%${search}%` } },
                { enterpriseName: { [Op.iLike]: `%${search}%` } },
                { nfNumber: { [Op.iLike]: `%${search}%` } },
                { siengeCreditorName: { [Op.iLike]: `%${search}%` } },
                ...(isAdmin ? [{ createdByName: { [Op.iLike]: `%${search}%` } }] : []),
            ];
            // Não-admin: combina filtro de acesso (cidade/usuário) com busca via Op.and
            // para não sobrescrever o controle de acesso já definido em where[Op.or]
            if (!isAdmin && where[Op.or]) {
                where[Op.and] = [
                    { [Op.or]: where[Op.or] },
                    { [Op.or]: searchConds },
                ];
                delete where[Op.or];
            } else {
                where[Op.or] = searchConds;
            }
        }

        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await Model().findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: Number(limit),
            offset,
            attributes: { exclude: ['aiExtractedData', 'extraAttachments', 'siengeContractRaw', 'siengeItemsRaw'] },
        });
        return res.json({
            total: count,
            page: Number(page),
            limit: Number(limit),
            pages: Math.ceil(count / Number(limit)),
            data: rows,
            isAdmin,
        });
    } catch (err) { next(err); }
}

// ── GET ONE ───────────────────────────────────────────────────────────────────
export async function getLaunch(req, res, next) {
    try {
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });
        return res.json(launch);
    } catch (err) { next(err); }
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
export async function updateLaunch(req, res, next) {
    try {
        const u = actor(req);
        const launch = await Model().findByPk(req.params.id);
        if (!launch) return res.status(404).json({ error: 'Lançamento não encontrado.' });
        if (['cancelado', 'titulo_pago'].includes(launch.status)) {
            return res.status(409).json({ error: `Lançamento "${launch.status}" não pode ser editado.` });
        }
        const b = req.body;
        const td = b.launchType && b.launchType !== launch.launchType ? await typeDefaults(b.launchType) : {};
        const patch = {};
        const scalars = [
            'companyName', 'companyId', 'enterpriseName', 'enterpriseId',
            'providerName', 'providerCnpj',
            'contractStartDate', 'contractEndDate',
            'launchType', 'unitPrice', 'notes',
            'nfUrl', 'nfPath', 'nfFilename', 'nfNumber', 'nfType', 'nfIssueDate',
            'boletoUrl', 'boletoPath', 'boletoFilename', 'boletoBarcode', 'boletoIssueDate', 'boletoDueDate', 'boletoAmount',
            'budgetItemCode',
        ];
        scalars.forEach(k => { if (b[k] !== undefined) patch[k] = b[k]; });
        if (b.budgetItem !== undefined) patch.budgetItem = b.budgetItem;
        else if (td.budgetItem) patch.budgetItem = td.budgetItem;

        if (b.budgetItemCode !== undefined) patch.budgetItemCode = b.budgetItemCode;
        else if (td.budgetItemCode) patch.budgetItemCode = td.budgetItemCode;

        if (b.financialAccountNumber !== undefined) patch.financialAccountNumber = b.financialAccountNumber;
        else if (td.financialAccountNumber) patch.financialAccountNumber = td.financialAccountNumber;
        if (Array.isArray(b.extraAttachments)) {
            const existing = Array.isArray(launch.extraAttachments) ? launch.extraAttachments : [];
            patch.extraAttachments = [...existing, ...b.extraAttachments];
        }
        if (b.removeExtraPath) {
            const existing = Array.isArray(launch.extraAttachments) ? launch.extraAttachments : [];
            patch.extraAttachments = existing.filter(a => a.path !== b.removeExtraPath);
        }
        patch.updatedBy = u.id; patch.updatedByName = u.name;
        await launch.update(patch);
        return res.json(launch);
    } catch (err) { next(err); }
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
export async function getSummary(req, res, next) {
    try {
        const { Op } = db.Sequelize;
        const isAdmin = req.user?.role === 'admin';
        const userId = req.user?.id;
        const { dateFrom, dateTo } = req.query;

        const where = {};

        if (!isAdmin) {
            const user = await db.User.findByPk(userId, { attributes: ['city'] });
            const userCity = user?.city;
            let cityEnterpriseIds = [];
            if (userCity) {
                const cityEnts = await db.EnterpriseCity.findAll({
                    where: db.Sequelize.where(
                        db.Sequelize.fn('COALESCE',
                            db.Sequelize.col('city_override'),
                            db.Sequelize.col('default_city')
                        ),
                        { [Op.iLike]: `%${userCity}%` }
                    ),
                    attributes: ['erp_id'],
                    raw: true,
                });
                cityEnterpriseIds = cityEnts.map(e => e.erp_id).filter(Boolean).map(String);
            }
            where[Op.or] = [
                { createdBy: userId },
                ...(cityEnterpriseIds.length ? [{ enterpriseId: { [Op.in]: cityEnterpriseIds } }] : []),
            ];
        }

        // Admin: sem restrição de data por padrão — aplica só se enviado explicitamente
        // Não-admin: padrão = mês corrente se não informado
        if (!isAdmin || dateFrom || dateTo) {
            const today = new Date();
            const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1);
            const defaultTo   = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
            where.createdAt = {
                [Op.gte]: dateFrom ? new Date(dateFrom) : defaultFrom,
                [Op.lte]: dateTo   ? new Date(dateTo + 'T23:59:59.999Z') : defaultTo,
            };
        }

        const rows = await Model().findAll({
            where,
            attributes: [
                'status',
                [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count'],
                [db.Sequelize.fn('SUM', db.Sequelize.col('unit_price')), 'totalAmount'],
            ],
            group: ['status'],
            raw: true,
        });
        const summary = {};
        rows.forEach(({ status, count, totalAmount }) => {
            summary[status] = { count: Number(count), totalAmount: parseFloat(totalAmount) || 0 };
        });
        return res.json(summary);
    } catch (err) { next(err); }
}

// ── PIPELINE ──────────────────────────────────────────────────────────────────
export async function runPipeline(req, res, next) {
    try {
        const launchId = Number(req.params.id);
        const userId = req.user?.id || null;

        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });

        // Responde imediatamente (202 Accepted) — pipeline roda em background
        res.status(202).json({ message: 'Pipeline iniciado em background.', launchId });

        // Fire-and-forget: não bloqueia o HTTP request
        runFullPipeline(launchId, userId).catch(err => {
            console.error(`[Pipeline] Erro inesperado no lançamento ${launchId}:`, err.message);
        });
    } catch (err) { next(err); }
}
export async function abortPipelineController(req, res, next) {
    try {
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });
        const result = await abortPipeline(Number(req.params.id));
        return res.json(result);
    } catch (err) { next(err); }
}

export async function findCreditor(req, res, next) {
    try { return res.json(await stepFindCreditor(Number(req.params.id))); }
    catch (err) { next(err); }
}
export async function findContract(req, res, next) {
    try { return res.json(await stepFindContract(Number(req.params.id))); }
    catch (err) { next(err); }
}
export async function createContract(req, res, next) {
    try { return res.json(await stepCreateContract(Number(req.params.id))); }
    catch (err) { next(err); }
}
export async function validateItems(req, res, next) {
    try { return res.json(await stepValidateItems(Number(req.params.id))); }
    catch (err) { next(err); }
}
export async function pollContract(req, res, next) {
    try {
        const result = await pollContractStatus(Number(req.params.id));
        if (!result) return res.status(404).json({ error: 'Contrato não encontrado no Sienge.' });
        return res.json(result);
    } catch (err) { next(err); }
}
export async function createTituloController(req, res, next) {
    try {
        const u = actor(req);
        return res.json(await stepCreateTitulo(Number(req.params.id), u.id));
    } catch (err) { next(err); }
}
export async function registerBoletoController(req, res, next) {
    try {
        // Permite sobrescrever siengeTituloNumber via body (para títulos criados manualmente)
        const id = Number(req.params.id);
        const { tituloNumber } = req.body || {};
        if (tituloNumber) {
            const launch = await db.PaymentLaunch.findByPk(id, { attributes: ['id'] });
            if (launch) await launch.update({ siengeTituloNumber: Number(tituloNumber) });
        }
        return res.json(await stepRegisterBoleto(id));
    } catch (err) { next(err); }
}

export async function pollNowController(req, res, next) {
    try {
        const id = Number(req.params.id);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });

        const stage = launch.pipelineStage;
        const contractStages  = ['awaiting_authorization', 'contract_found', 'contract_created', 'additive_created'];
        const measureStages   = ['awaiting_measurement_authorization', 'measurement_created'];
        const tituloStages    = ['awaiting_titulo_authorization', 'titulo_created'];

        let result = null;
        if (contractStages.includes(stage))  result = await pollContractStatus(id);
        else if (measureStages.includes(stage)) result = await pollMeasurementStatus(id);
        else if (tituloStages.includes(stage))  result = await pollTituloStatus(id);

        return res.json({ polled: stage, result: result ? 'ok' : 'nenhum' });
    } catch (err) { next(err); }
}

export async function updateBoletoController(req, res, next) {
    try {
        const id = Number(req.params.id);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });

        const { boletoUrl, boletoPath, boletoFilename, boletoBarcode, boletoDueDate, boletoAmount } = req.body;
        if (!boletoBarcode) return res.status(422).json({ error: 'Código de barras é obrigatório.' });
        if (!boletoUrl)     return res.status(422).json({ error: 'URL do boleto é obrigatória.' });

        const result = await stepUpdateBoleto(id, { boletoUrl, boletoPath, boletoFilename, boletoBarcode, boletoDueDate, boletoAmount });
        return res.json(result);
    } catch (err) { next(err); }
}

// ── STATUS TRANSITIONS ────────────────────────────────────────────────────────

/** Avança manualmente para a próxima etapa (ex: contrato → aditivo, etc.) */
export async function advanceStage(req, res, next) {
    try {
        const u = actor(req);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });
        const FLOW = ['fornecedor', 'contrato', 'aditivo', 'medicao', 'titulo'];
        const idx = FLOW.indexOf(launch.status);
        if (idx < 0 || idx >= FLOW.length - 1) {
            return res.status(409).json({ error: 'Não é possível avançar a partir deste status.' });
        }
        const next_status = FLOW[idx + 1];
        await launch.update({ status: next_status, updatedBy: u.id, updatedByName: u.name });
        return res.json(launch);
    } catch (err) { next(err); }
}

export async function cancelLaunch(req, res, next) {
    try {
        const u = actor(req);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });
        if (['cancelado', 'titulo_pago'].includes(launch.status)) return res.status(409).json({ error: 'Não pode ser cancelado.' });
        await launch.update({ status: 'cancelado', updatedBy: u.id, updatedByName: u.name });
        return res.json(launch);
    } catch (err) { next(err); }
}

export async function markPaid(req, res, next) {
    try {
        const u = actor(req);
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem marcar como pago.' });
        const launch = await Model().findByPk(req.params.id);
        if (!launch) return res.status(404).json({ error: 'Não encontrado.' });
        if (launch.status !== 'titulo') return res.status(409).json({ error: 'Apenas títulos podem ser marcados como pagos.' });
        await launch.update({ status: 'titulo_pago', paidAt: new Date(), updatedBy: u.id, updatedByName: u.name });
        return res.json(launch);
    } catch (err) { next(err); }
}

// ── RID (Registro de Informações do Fornecedor) ───────────────────────────────

/**
 * POST /payment-flow/:id/rid/send-form
 * Recebe os dados do formulário RID como JSON, gera o DOCX preenchido
 * e envia por email para fornecedores@menin.com.br com CC para o solicitante.
 */
export async function sendRidForm(req, res, next) {
    try {
        const u = actor(req);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });

        if (launch.siengeCreditorStatus !== 'not_found') {
            return res.status(409).json({ error: 'Fornecedor já está cadastrado no Sienge.' });
        }

        // Suporta multipart (com anexos) e JSON puro (sem anexos)
        let formData;
        if (req.body?.formData) {
            try { formData = JSON.parse(req.body.formData); }
            catch { return res.status(422).json({ error: 'Dados do formulário inválidos (JSON).' }); }
        } else {
            formData = req.body;
        }

        if (!formData || !formData.razaoSocial) {
            return res.status(422).json({ error: 'Dados do formulário são obrigatórios.' });
        }

        // Valida que pelo menos 1 empresa foi informada na seção 2.3
        const empresas = Array.isArray(formData.empresas) ? formData.empresas : [];
        const empresaValida = empresas.some(e => e?.razaoSocial?.trim());
        if (!empresaValida) {
            return res.status(422).json({ error: 'Informe ao menos uma empresa para a qual o fornecedor fornece (seção 2.3).' });
        }

        const userEmail = req.user?.email || null;

        // Garante que os dados pré-preenchidos do lançamento estejam no doc
        const docData = {
            ...formData,
            cnpj: formData.cnpj || launch.providerCnpj || '',
            razaoSocial: formData.razaoSocial || launch.providerName || '',
            requesterName: u.name,
            requesterEmail: userEmail,
        };

        // Gera o DOCX preenchido
        const docBuffer = await generateRidDocx(docData);

        const sentAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const emailData = {
            requesterName: u.name,
            providerName: launch.providerName || docData.razaoSocial || '—',
            providerCnpj: launch.providerCnpj || docData.cnpj || '—',
            launchType: launch.launchType || null,
            enterpriseName: launch.enterpriseName || null,
            sentAt,
        };

        const ccList = userEmail ? [userEmail] : [];

        // Monta lista de anexos: RID gerado + outros anexos enviados pelo usuário
        const attachments = [
            {
                filename: `RID_${(launch.providerName || launch.providerCnpj || 'Fornecedor').replace(/[^a-zA-Z0-9]/g, '_')}.docx`,
                content: docBuffer,
                contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
        ];
        const extraFiles = req.files?.anexos || [];
        for (const f of extraFiles) {
            attachments.push({
                filename: f.originalname,
                content: f.buffer,
                contentType: f.mimetype || 'application/octet-stream',
            });
        }

        await sendEmail(
            'supplier.rid.request',
            'fornecedores@menin.com.br',
            emailData,
            { cc: ccList, attachments }
        );

        await launch.update({
            ridEmailSent: true,
            ridEmailSentAt: new Date(),
            ridRequestedByEmail: userEmail,
            updatedBy: u.id,
            updatedByName: u.name,
        });

        return res.json({
            ok: true,
            message: 'Formulário RID gerado e email enviado com sucesso para fornecedores@menin.com.br',
            sentAt: launch.ridEmailSentAt,
        });
    } catch (err) { next(err); }
}

/** GET /payment-flow/rid-template — baixa o modelo Word da RID */
export async function downloadRidTemplate(req, res, next) {
    try {
        return res.download(RID_TEMPLATE_PATH, 'RID_Modelo.docx', (err) => {
            if (err) next(err);
        });
    } catch (err) { next(err); }
}

/**
 * POST /payment-flow/:id/rid/send-email
 * Recebe o arquivo RID preenchido (multipart) e envia por email para fornecedores@menin.com.br
 * com CC para o usuário solicitante.
 */
export async function sendRidEmail(req, res, next) {
    try {
        const u = actor(req);
        const { launch, status, error } = await ownedLaunch(req);
        if (!launch) return res.status(status).json({ error });

        if (launch.siengeCreditorStatus !== 'not_found') {
            return res.status(409).json({ error: 'Fornecedor já está cadastrado no Sienge.' });
        }

        // req.file vem do multer (campo 'rid')
        if (!req.file) return res.status(422).json({ error: 'Arquivo RID é obrigatório.' });

        const userEmail = req.user?.email || null;
        const sentAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        const data = {
            requesterName: u.name,
            providerName: launch.providerName || '—',
            providerCnpj: launch.providerCnpj || '—',
            launchType: launch.launchType || null,
            enterpriseName: launch.enterpriseName || null,
            sentAt,
        };

        const attachments = [{
            filename: req.file.originalname || 'RID_Preenchida.docx',
            content: req.file.buffer,
        }];

        const ccList = userEmail ? [userEmail] : [];

        await sendEmail(
            'supplier.rid.request',
            'fornecedores@menin.com.br',
            data,
            { cc: ccList, attachments }
        );

        await launch.update({
            ridEmailSent: true,
            ridEmailSentAt: new Date(),
            ridRequestedByEmail: userEmail,
            updatedBy: u.id,
            updatedByName: u.name,
        });

        return res.json({
            ok: true,
            message: 'Email enviado com sucesso para fornecedores@menin.com.br',
            sentAt: launch.ridEmailSentAt,
        });
    } catch (err) { next(err); }
}

export async function continueExistingContract(req, res) {
    try {
        const { id } = req.params;
        const userId = req.user?.id || null;

        const result = await continueExistingContractPipeline(id, userId);

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
}