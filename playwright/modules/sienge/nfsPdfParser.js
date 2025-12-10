// modules/sienge/nfsPdfParser.js
import pdfParse from 'pdf-parse'

function normalizeNumber(str) {
    if (!str) return null
    const raw = String(str).trim()
    if (!raw) return null

    const num = Number(
        raw
            .replace(/\s/g, '')
            .replace(/\./g, '')
            .replace(',', '.')
            .replace(/[^\d.-]/g, '')
    )

    return Number.isFinite(num) ? num : null
}

export async function parseNfsePdf(buffer) {
    const data = await pdfParse(buffer)
    const rawText = (data.text || '').replace(/\r/g, '')
    const lines = rawText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)

    const fullText = rawText

    const findMatch = (regex) => {
        const m = fullText.match(regex)
        return m ? m[1].trim() : null
    }

    const findLineAfter = (label) => {
        const idx = lines.findIndex((l) =>
            l.toLowerCase().includes(label.toLowerCase())
        )
        if (idx === -1 || idx + 1 >= lines.length) return null
        return lines[idx + 1].trim()
    }

    // ---------- DATA EMISSÃO (DD/MM/YYYY) ----------
    let issueDateBr =
        // “Data de Emissão”, “Data Emissão”
        findMatch(/data\s*(?:e\s*hora\s*de\s*)?emiss[aã]o[^\d]*([0-3]\d\/[01]\d\/\d{4})/i) ||
        // “Emitida em 08/12/2025”
        findMatch(/emitida\s*em[^\d]*([0-3]\d\/[01]\d\/\d{4})/i) ||
        // “Emissão da NFS-e 16/10/2025”
        findMatch(/emiss[aã]o\s+da\s+nfs-e[^\d]*([0-3]\d\/[01]\d\/\d{4})/i) ||
        null

    if (!issueDateBr) {
        const m = fullText.match(/([0-3]\d\/[01]\d\/\d{4})/)
        if (m) issueDateBr = m[1]
    }

    // ---------- NÚMERO DA NOTA ----------
    const invoiceNumber =
        // “Número da Nota 103”, “Número 218”, “Número da Nota - Série 000000000852 - 1”
        findMatch(/n[úu]mero(?:\s*da\s*nota)?[^\d]*([\d\.]+)/i) ||
        // “Número Nota Fiscal: 98”
        findMatch(/n[úu]mero\s*nota\s*fiscal[^\d]*([\d\.]+)/i) ||
        // Caso da SJRio Preto, pega RPS 272 como número
        findMatch(/rps[^\d]*([\d]{2,})/i) ||
        null

    // ---------- PRESTADOR ----------
    const providerName =
        findLineAfter('PRESTADOR DE SERVIÇOS') ||
        findLineAfter('Prestador de Serviços') ||
        findLineAfter('Prestador') ||
        // layout Bauru: linha após “CNPJ/CPF:”
        findLineAfter('CNPJ/CPF') ||
        null

    const providerCnpj =
        (findMatch(/cpf\/cnpj\s*[:\-]?\s*([\d\.\-\/]{14,18})/i) ||
            findMatch(/cnpj\s*[:\-]?\s*([\d\.\-\/]{14,18})/i) ||
            '')
            .replace(/\D/g, '') || null

    // ---------- TOMADOR ----------
    const customerName =
        findLineAfter('Dados do Tomador de Serviço') ||
        findLineAfter('TOMADOR DE SERVIÇOS') ||
        findLineAfter('Tomador de Serviços') ||
        findLineAfter('Tomador de Serviço') ||
        // alguns layouts trazem “Nome/Razão Social:” logo abaixo
        findMatch(/tomador de servi[cç]os[\s\S]*?Nome\/Raz[aã]o Social:\s*(.+)/i) ||
        null

    // ---------- DESCRIÇÃO / DISCRIMINAÇÃO ----------
    const serviceDescription =
        // Bauru / Ourinhos / SJRio Preto / Marília
        findLineAfter('Discriminação dos Serviços') ||
        findLineAfter('Discriminação do Serviço') ||
        findLineAfter('Discriminação dos serviços') ||
        // Pompéia / Marília:
        findLineAfter('DESCRIÇÃO DOS SERVIÇOS') ||
        findLineAfter('DESCRIÇÃO DOS SERVIÇOS PRESTADOS') ||
        null

    // ---------- VALOR TOTAL ----------
    const totalAmountStr =
        // “VALOR TOTAL DA NOTA = R$ 2.500,00”, “Valor Total da NFS-e ...”
        findMatch(/valor\s*total[^0-9]*([\d\.\,]+)/i) ||
        // “Total da Nota 1.000,00”
        findMatch(/total\s*da\s*nota[^0-9]*([\d\.\,]+)/i) ||
        // “Valor Total da NFS-e R$ 5.000,00”
        findMatch(/valor\s*total\s*da\s*nfs-e[^0-9]*([\d\.\,]+)/i) ||
        // “Valor dos Serviços”
        findMatch(/valor\s*dos\s*servi[cç]os[^0-9]*([\d\.\,]+)/i) ||
        // “Valor do Serviço 1.000,00”
        findMatch(/valor\s*do\s*servi[cç]o[^0-9]*([\d\.\,]+)/i) ||
        null

    const totalAmount = normalizeNumber(totalAmountStr)

    return {
        issueDate: issueDateBr, // dd/MM/yyyy (vamos normalizar no service)
        invoiceNumber,
        providerName,
        providerCnpj,
        customerName,
        serviceDescription,
        totalAmount,
        rawText: rawText,
    }
}
