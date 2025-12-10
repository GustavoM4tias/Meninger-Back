// src/services/sienge/awardService.js
import db from "../../models/sequelize/index.js";
import { parseNfseXml } from "../../playwright/modules/sienge/nfsParser.js";
import { parseNfsePdf } from "../../playwright/modules/sienge/nfsPdfParser.js";

const { Award, AwardLink } = db

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

export async function createAwardFromNfseFile(file) {
    if (!file) {
        throw new Error("Nenhum arquivo enviado.");
    }

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

    const award = await Award.create({
        nfNumber: parsed.invoiceNumber,
        nfIssueDate: nfIssueDateIso,
        providerName: parsed.providerName,
        providerCnpj: normalizeDoc(parsed.providerCnpj),
        customerName: parsed.customerName,
        serviceDescription: parsed.serviceDescription,
        totalAmount: parsed.totalAmount,
        nfFilename: file.originalname,
        nfMimeType: file.mimetype,
        nfXml: rawContent,
    })

    return award
}
 
export async function listAwards() {
  return Award.findAll({
    include: [{ model: AwardLink, as: 'links' }],
    order: [
      ['created_at', 'DESC'],
      [{ model: AwardLink, as: 'links' }, 'id', 'ASC'],
    ],
  })
}
 
export async function updateAward(id, payload) {
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

    try {
        await award.update(data)
        return award
    } catch (err) {
        console.error("Erro ao atualizar Award:", err.original || err)
        throw new Error(
            err?.original?.message || "Erro ao atualizar registro de NFS-e."
        )
    }
}

export async function createAwardLinks(awardId, links = []) {
    if (!awardId || !Array.isArray(links) || links.length === 0) return;

    const payload = links.map((l) => ({
        awardId,
        saleKey: l.saleKey,

        customerId: l.customerId ?? null,
        customerName: l.customerName ?? null,

        unitId: l.unitId ?? null,
        unitName: l.unitName ?? null,

        enterpriseId: l.enterpriseId ?? null,
        enterpriseName: l.enterpriseName ?? null,

        // usado para próximos passos
        etapa: l.stage ?? null,
        bloco: l.block ?? null,
        costCenter: l.costCenter ?? null,
        saleDate: l.saleDate ?? null,

        saleValue: l.saleValue ?? null,
    }))

    await AwardLink.bulkCreate(payload)
}

export async function getAwardById(id) {
    return Award.findByPk(id, {
        include: [{ model: AwardLink, as: 'links' }],
        order: [[{ model: AwardLink, as: 'links' }, 'id', 'ASC']],
    })
}

/**
 * REGISTRA CLIENTES NA PREMIAÇÃO (SEM NF) – usado pelo /awards/register-sales
 * Mantém a mesma lógica que você tinha no controller, agora centralizada no service.
 */
export async function registerSales(sales = []) {
    if (!Array.isArray(sales) || sales.length === 0) {
        throw new Error("Envie uma lista de vendas para registrar.")
    }

    const createdAwards = []

    for (const s of sales) {
        const award = await Award.create({
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
        })

        await createAwardLinks(award.id, [s])

        const fullAward = await getAwardById(award.id)
        createdAwards.push(fullAward)
    }

    return createdAwards
}
