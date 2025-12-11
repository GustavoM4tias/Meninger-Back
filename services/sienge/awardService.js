// src/services/sienge/awardService.js
import db from "../../models/sequelize/index.js";
import { parseNfseXml } from "../../playwright/modules/sienge/nfsParser.js";
import { parseNfsePdf } from "../../playwright/modules/sienge/nfsPdfParser.js";

const { Award, AwardLink, AwardLog } = db
const AWARD_STATUSES = new Set(["iniciado", "autorizacao", "andamento", "pago"])
const NF_FIELDS = [
    "nfNumber",
    "nfIssueDate",
    "providerName",
    "providerCnpj",
    "customerName",
    "serviceDescription",
    "totalAmount",
    "nfFilename",
    "nfMimeType",
    "nfXml",
]

const normalizeCostCenter = (value) => {
    if (value == null) return null
    const digits = String(value).replace(/\D/g, "")
    if (!digits) return null
    if (digits.length >= 5) return digits.slice(-5)
    return digits
}

const mapUserMeta = (user = {}) => {
    const name = user?.name || user?.username || user?.email || user?.login || 'Sistema'
    return {
        id: user?.id ?? null,
        name,
        role: user?.role || null,
    }
}

const withCreatedMeta = (data, userMeta) => ({
    ...data,
    createdBy: userMeta.id,
    createdByName: userMeta.name,
    updatedBy: userMeta.id,
    updatedByName: userMeta.name,
})

const withUpdatedMeta = (data, userMeta) => ({
    ...data,
    updatedBy: userMeta.id,
    updatedByName: userMeta.name,
})

async function appendAwardLog(awardId, action, user, metadata = null) {
    if (!awardId) return
    const meta = mapUserMeta(user)
    await AwardLog.create({
        awardId,
        action,
        userId: meta.id,
        userName: meta.name,
        metadata: metadata || null,
    })
}

function normalizeIssueDate(value) {
    if (value == null || value === "") return null
    const s = String(value).trim()
    if (!s) return null

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

    const brMatch = s.match(/^([0-3]\d)\/([01]\d)\/(\d{4})/)
    if (brMatch) {
        const [, dd, mm, yyyy] = brMatch
        return `${yyyy}-${mm}-${dd}`
    }

    return "__INVALID_DATE__"
}

function normalizeAmount(value) {
    if (value == null || value === "") return null
    const s = String(value)
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.-]/g, "")
    if (!s) return null
    const num = Number(s)
    if (!Number.isFinite(num)) return "__INVALID_AMOUNT__"
    return num
}

function normalizeDoc(value) {
    if (value == null || value === '') return null
    const digits = String(value).replace(/\D/g, '')
    if (!digits) return null
    return digits.slice(0, 14)
}

function normalizeStatusValue(value, { allowNull = false } = {}) {
    if (value == null || value === "") {
        if (allowNull) return null
        throw new Error(`Status é obrigatório. Valores permitidos: ${[...AWARD_STATUSES].join(", ")}`)
    }
    const normalized = String(value).trim().toLowerCase()
    if (!AWARD_STATUSES.has(normalized)) {
        throw new Error(`Status inválido. Valores permitidos: ${[...AWARD_STATUSES].join(", ")}`)
    }
    return normalized
}

async function buildAwardDataFromFile(file) {
    if (!file) throw new Error("Nenhum arquivo enviado.")

    const isPdf =
        file.mimetype === "application/pdf" ||
        file.originalname.toLowerCase().endsWith(".pdf")

    let parsed
    let rawContent

    if (isPdf) {
        parsed = await parseNfsePdf(file.buffer)
        rawContent = parsed.rawText
    } else {
        const xmlString = file.buffer.toString("utf-8")
        parsed = parseNfseXml(xmlString)
        rawContent = xmlString
    }

    const nfIssueDateIso = normalizeIssueDate(parsed.issueDate)
    const normalizedDate = nfIssueDateIso === "__INVALID_DATE__" ? null : nfIssueDateIso

    const normalizedAmount = normalizeAmount(parsed.totalAmount)
    const totalAmount = normalizedAmount === "__INVALID_AMOUNT__" ? null : normalizedAmount

    return {
        data: {
            nfNumber: parsed.invoiceNumber ?? null,
            nfIssueDate: normalizedDate,
            providerName: parsed.providerName ?? null,
            providerCnpj: normalizeDoc(parsed.providerCnpj),
            customerName: parsed.customerName ?? null,
            serviceDescription: parsed.serviceDescription ?? null,
            totalAmount,
            nfFilename: file.originalname,
            nfMimeType: file.mimetype,
            nfXml: rawContent,
        },
    }
}

export async function createAwardFromNfseFile(file, user = null) {
    const { data } = await buildAwardDataFromFile(file)
    const meta = mapUserMeta(user)

    const award = await Award.create(
        withCreatedMeta({
            ...data,
            status: "iniciado",
        }, meta)
    )

    await appendAwardLog(award.id, "created", user, { source: "nfse_upload" })
    return award
}

export async function attachNfseToAward(awardId, file, user = null) {
    if (!awardId) throw new Error("Informe o ID da premiação.")

    const award = await Award.findByPk(awardId)
    if (!award) {
        throw new Error("Premiação não encontrada.")
    }

    const results = await bulkAttachNfse({ awardIds: [awardId], file }, user)
    return results[0] || null
}

function pickNfDataFromAward(award) {
    if (!award) return {}
    const data = {}
    NF_FIELDS.forEach((field) => {
        data[field] = award[field] ?? null
    })
    return data
}

async function fetchAwardsWithLinks(ids = []) {
    if (!ids || ids.length === 0) return []
    return Award.findAll({
        where: { id: ids },
        include: [
            { model: AwardLink, as: 'links' },
            { model: AwardLog, as: 'logs', separate: true, order: [['created_at', 'ASC']] }
        ],
        order: [
            ['created_at', 'DESC'],
            [{ model: AwardLink, as: 'links' }, 'id', 'ASC'],
        ],
    })
}

export async function bulkAttachNfse({ awardIds = [], file = null, sourceAwardId = null }, user = null) {
    const ids = Array.from(
        new Set(
            (awardIds || [])
                .map((id) => Number(id))
                .filter((id) => Number.isInteger(id) && id > 0)
        )
    )
    if (ids.length === 0) {
        throw new Error("Informe ao menos um ID de premiação.")
    }

    let payload
    if (file) {
        const { data } = await buildAwardDataFromFile(file)
        payload = data
    } else if (sourceAwardId) {
        const sourceId = Number(sourceAwardId)
        if (!Number.isInteger(sourceId) || sourceId <= 0) {
            throw new Error("Premiação de origem inválida.")
        }
        const source = await Award.findByPk(sourceId)
        if (!source) {
            throw new Error("Premiação de origem não encontrada.")
        }
        payload = pickNfDataFromAward(source)
        const hasData = NF_FIELDS.some(
            (field) => payload[field] != null && payload[field] !== ""
        )
        if (!hasData) {
            throw new Error("A premiação de origem não possui NF anexada.")
        }
    } else {
        throw new Error("Envie um arquivo ou selecione uma NF existente.")
    }

    const meta = mapUserMeta(user)
    await Award.update(withUpdatedMeta(payload, meta), { where: { id: ids } })
    for (const id of ids) {
        await appendAwardLog(id, file ? "nf_attached" : "nf_reused", user, {
            sourceAwardId: sourceAwardId || null,
        })
    }
    return fetchAwardsWithLinks(ids)
}

export async function clearNfseFromAwards(awardIds = [], user = null) {
    const ids = Array.from(
        new Set(
            (awardIds || [])
                .map((id) => Number(id))
                .filter((id) => Number.isInteger(id) && id > 0)
        )
    )
    if (ids.length === 0) {
        throw new Error("Informe ao menos um ID de premiação para limpar.")
    }

    const clearPayload = {
        nfNumber: null,
        nfIssueDate: null,
        providerName: null,
        providerCnpj: null,
        serviceDescription: null,
        totalAmount: null,
        nfFilename: null,
        nfMimeType: null,
        nfXml: null,
    }

    const meta = mapUserMeta(user)
    await Award.update(withUpdatedMeta(clearPayload, meta), { where: { id: ids } })
    for (const id of ids) {
        await appendAwardLog(id, "nf_cleared", user, null)
    }
    return fetchAwardsWithLinks(ids)
}
 
export async function listAwards() {
  return Award.findAll({
    include: [
      { model: AwardLink, as: 'links' },
      { model: AwardLog, as: 'logs', separate: true, order: [['created_at', 'ASC']] }
    ],
    order: [
      ['created_at', 'DESC'],
      [{ model: AwardLink, as: 'links' }, 'id', 'ASC'],
    ],
  })
}
 
export async function updateAward(id, payload, user = null) {
    const award = await Award.findByPk(id)
    if (!award) {
        throw new Error("Award não encontrado.")
    }

    const data = {}

    if ("nfNumber" in payload) data.nfNumber = payload.nfNumber

    if ("nfIssueDate" in payload) {
        const normalized = normalizeIssueDate(payload.nfIssueDate)
        if (normalized === "__INVALID_DATE__") {
            throw new Error("Data de emissão inválida. Use YYYY-MM-DD ou DD/MM/YYYY.")
        }
        data.nfIssueDate = normalized
    }

    if ("providerName" in payload) data.providerName = payload.providerName

    if ("providerCnpj" in payload) {
        const doc = normalizeDoc(payload.providerCnpj)
        data.providerCnpj = doc || null
    }

    if ("customerName" in payload) data.customerName = payload.customerName
    if ("serviceDescription" in payload) data.serviceDescription = payload.serviceDescription

    if ("totalAmount" in payload) {
        const normalized = normalizeAmount(payload.totalAmount)
        if (normalized === "__INVALID_AMOUNT__") {
            throw new Error("Valor total inválido. Use algo como 1000,00 ou 1000.00.")
        }
        data.totalAmount = normalized
    }

    if ("status" in payload) {
        data.status = normalizeStatusValue(payload.status)
    }

    try {
        const meta = mapUserMeta(user)
        await award.update(withUpdatedMeta(data, meta))
        await appendAwardLog(id, "updated", user, { fields: Object.keys(data) })
        return await getAwardById(id)
    } catch (err) {
        console.error("Erro ao atualizar Award:", err.original || err)
        throw new Error(
            err?.original?.message || "Erro ao atualizar registro de NFS-e."
        )
    }
}

export async function createAwardLinks(awardId, links = []) {
    if (!awardId || !Array.isArray(links) || links.length === 0) return;

    const payload = []
    const seenKeys = new Set()

    for (const link of links) {
        const saleKey = String(link.saleKey ?? "").trim()
        if (!saleKey) {
            throw new Error("Cada vínculo precisa ter um identificador (saleKey).")
        }
        if (seenKeys.has(saleKey)) continue
        seenKeys.add(saleKey)

        payload.push({
            awardId,
            saleKey,

            customerId: link.customerId ?? null,
            customerName: link.customerName ?? null,

            unitId: link.unitId ?? null,
            unitName: link.unitName ?? null,

            enterpriseId: link.enterpriseId ?? null,
            enterpriseName: link.enterpriseName ?? null,

            etapa: link.stage ?? null,
            bloco: link.block ?? null,
            costCenter: link.costCenter ?? null,
            saleDate: link.saleDate ?? null,

            saleValue: link.saleValue ?? null,
        })
    }

    if (payload.length === 0) return

    await AwardLink.bulkCreate(payload)
}

export async function getAwardById(id) {
    return Award.findByPk(id, {
        include: [
            { model: AwardLink, as: 'links' },
            { model: AwardLog, as: 'logs', separate: true, order: [['created_at', 'ASC']] }
        ],
        order: [[{ model: AwardLink, as: 'links' }, 'id', 'ASC']],
    })
}

/**
 * REGISTRA CLIENTES NA PREMIAÇÃO (SEM NF) – usado pelo /awards/register-sales
 * Mantém a mesma lógica que você tinha no controller, agora centralizada no service.
 */
export async function registerSales(sales = [], user = null) {
    if (!Array.isArray(sales) || sales.length === 0) {
        throw new Error("Envie uma lista de vendas para registrar.")
    }

    const createdAwards = []
    const meta = mapUserMeta(user)

    for (const s of sales) {
        const saleKey = String(s?.saleKey ?? "").trim()
        if (!saleKey) {
            throw new Error("Cada venda precisa ter um identificador único (saleKey).")
        }

        const existingLink = await AwardLink.findOne({
            where: { saleKey },
            attributes: ["awardId"],
        })

        if (existingLink) {
            const fullAward = await getAwardById(existingLink.awardId)
            if (fullAward) createdAwards.push(fullAward)
            continue
        }

        const award = await Award.create(
            withCreatedMeta({
                nfNumber: null,
                nfIssueDate: null,
                providerName: null,
                providerCnpj: null,
                customerName: s.customerName ?? null,
                serviceDescription: null,
                totalAmount: null,
                nfFilename: null,
                nfMimeType: null,
                nfXml: null,
                status: "iniciado",
            }, meta)
        )

        await createAwardLinks(award.id, [{ ...s, saleKey }])
        await appendAwardLog(award.id, "created", user, { source: "manual_register" })

        const fullAward = await getAwardById(award.id)
        createdAwards.push(fullAward)
    }

    return createdAwards
}

export async function deleteAwards(awardIds = [], user = null) {
    const ids = Array.from(
        new Set(
            (awardIds || [])
                .map((id) => Number(id))
                .filter((id) => Number.isInteger(id) && id > 0)
        )
    )

    if (ids.length === 0) {
        throw new Error("Informe ao menos um ID de premiação para excluir.")
    }

    const awards = await Award.findAll({ where: { id: ids } })
    if (!awards.length) return []

    const meta = mapUserMeta(user)
    const nonInitial = awards.filter((award) => award.status !== "iniciado")
    if (nonInitial.length > 0 && meta.role !== "admin") {
        throw new Error("Somente administradores podem excluir premiações que não estejam na etapa inicial.")
    }

    await AwardLink.destroy({ where: { awardId: ids } })
    await AwardLog.destroy({ where: { awardId: ids } })
    await Award.destroy({ where: { id: ids } })

    return ids
}

export async function deleteAward(id, user = null) {
    const removed = await deleteAwards([id], user)
    return removed[0] || null
}
