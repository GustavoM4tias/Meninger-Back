// validatorAI/src/services/PaymentExtractorService.js
import fs from 'fs/promises';
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { AIService } from './AIService.js';

// ── Defaults por tipo de lançamento ──────────────────────────────────────────
export const LAUNCH_TYPE_DEFAULTS = {
    Premiação: { budgetItem: 'Premiação de Vendas', financialAccountNumber: '1.1.01.001' },
    ITBI: { budgetItem: 'ITBI - Imposto de Transmissão', financialAccountNumber: '1.1.02.001' },
    Marketing: { budgetItem: 'Marketing e Publicidade', financialAccountNumber: '1.1.03.001' },
    CEF: { budgetItem: 'Taxas e Emolumentos CEF', financialAccountNumber: '1.1.04.001' },
    Cartório: { budgetItem: 'Despesas Cartorárias', financialAccountNumber: '1.1.05.001' },
    Stand: { budgetItem: 'Despesas com Estrutura Local e/ou Stand de Vendas', financialAccountNumber: '2.02.07' },
};

// ── Prompts enxutos para resposta rápida ─────────────────────────────────────

const NF_PROMPT = `Extraia dados desta Nota Fiscal/documento fiscal brasileiro.
Retorne APENAS JSON (sem markdown):
{
  "documentType": "NFe|NFS|NF|Recibo|Fatura|Outro",
  "documentNumber": "<número>",
  "documentDate": "YYYY-MM-DD|null",
  "providerName": "<razão social emitente>",
  "providerCnpj": "<14 dígitos sem pontuação>",
  "recipientName": "<razão social destinatário>",
  "recipientCnpj": "<14 dígitos sem pontuação>",
  "serviceDescription": "<descrição resumida>",
  "totalAmount": <número float>,
  "enterpriseHint": "<empreendimento mencionado|null>",
  "suggestedLaunchType": "Premiação|ITBI|Marketing|CEF|Cartório|Stand|null",
  "confidence": "alto|medio|baixo"
}
Regras: CNPJ=14 dígitos. Valores=float. Datas=YYYY-MM-DD. Sem texto fora do JSON.`;

const BOLETO_PROMPT = `Extraia dados deste Boleto Bancário brasileiro.
Retorne APENAS JSON (sem markdown):
{
  "barcode": "<linha digitável completa|null>",
  "documentDate": "YYYY-MM-DD|null",
  "dueDate": "YYYY-MM-DD|null",
  "amount": <número float|null>,
  "beneficiaryName": "<cedente/beneficiário>",
  "beneficiaryCnpj": "<14 dígitos|null>",
  "payerName": "<sacado/pagador>",
  "description": "<descrição/instrução|null>",
  "bankName": "<banco emissor|null>",
  "confidence": "alto|medio|baixo"
}
Regras: Valores=float. Datas=YYYY-MM-DD. documentDate=data de emissão/documento do boleto (campo "Data do Documento"). Sem texto fora do JSON.`;

// ── Heurística: é boleto ou NF? ───────────────────────────────────────────────
function detectDocumentCategory(text) {
    const t = text.toLowerCase();
    const boletoSignals = [
        'linha digitável', 'cedente', 'sacado', 'nosso número',
        'agência', 'código de barras', 'boleto', 'vencimento',
        'banco bradesco', 'banco itaú', 'banco santander', 'caixa econômica',
        'compensação', 'instrução', 'ficha de compensação',
    ];
    const nfSignals = [
        'nota fiscal', 'nfe', 'nfs', 'danfe', 'cfop', 'ncm',
        'chave de acesso', 'emitente', 'destinatário', 'tributos',
        'icms', 'iss', 'pis', 'cofins', 'valor total da nota',
    ];

    let boletoScore = boletoSignals.filter(s => t.includes(s)).length;
    let nfScore = nfSignals.filter(s => t.includes(s)).length;

    return boletoScore > nfScore ? 'boleto' : 'nf';
}

// ── Extração rápida: texto relevante (primeiras 3000 chars) ───────────────────
function extractRelevantText(fullText) {
    // Para boleto: foca no início (dados do beneficiário, código de barras)
    // Para NF: foca no início (emitente, destinatário, valores)
    return fullText.slice(0, 3000).trim();
}

// ── Extração principal ────────────────────────────────────────────────────────
export class PaymentExtractorService {
    /**
     * Extrai dados de um PDF com modo automático (NF ou Boleto).
     * @param {string} filePath  Caminho absoluto do PDF no servidor (upload temporário)
     * @param {'nf'|'boleto'|'auto'} mode  Forçar modo ou detectar automaticamente
     */
    static async extractFromPdf(filePath, mode = 'auto') {
        let buffer;
        try {
            buffer = await fs.readFile(filePath);
        } catch (err) {
            return { error: `Não foi possível ler o arquivo: ${err.message}`, extracted: null };
        }

        let pdfText = '';
        let numpages = 0;
        try {
            const parsed = await pdfParse(buffer);
            pdfText = parsed.text || '';
            numpages = parsed.numpages || 0;
        } catch (_) {
            // pdf-parse falha em PDFs puramente escaneados — segue para visão do Gemini
            numpages = 0;
        }

        const isScanned = !pdfText || pdfText.trim().length < 15;
        const detectedMode = mode === 'auto'
            ? (isScanned ? 'nf' : detectDocumentCategory(pdfText))
            : mode;
        const prompt = detectedMode === 'boleto' ? BOLETO_PROMPT : NF_PROMPT;

        let result;
        if (isScanned) {
            // PDF sem camada de texto (escaneado): envia o arquivo para o Gemini via visão
            result = await AIService.generateResponseFromPdf(
                `${prompt}\n\nEste documento é uma imagem escaneada. Use visão para ler e extrair os dados.`,
                buffer
            );
        } else {
            const snippet = extractRelevantText(pdfText);
            result = await AIService.generateResponse(prompt, `Documento:\n${snippet}`);
        }

        if (result.error) {
            return {
                error: result.error,
                extracted: null,
                detectedMode,
                tokensUsed: result.tokensUsed || 0,
                model: result.model || null,
                numpages,
            };
        }

        try {
            const clean = result.response
                .replace(/^```json\n?|^```\n?|```$/gm, '')
                .trim();
            const extracted = JSON.parse(clean);

            return {
                error: null,
                extracted,
                detectedMode,
                tokensUsed: result.tokensUsed || 0,
                model: result.model || null,
                numpages,
            };
        } catch (parseErr) {
            return {
                error: `IA retornou resposta não-JSON: ${parseErr.message}`,
                extracted: null,
                rawResponse: result.response?.slice(0, 500) || null,
                detectedMode,
                tokensUsed: result.tokensUsed || 0,
                model: result.model || null,
                numpages,
            };
        }
    }

    /**
     * Monta o prefill para o frontend a partir dos dados extraídos de uma NF.
     */
    static buildNfPrefill(extracted, today) {
        if (!extracted) return null;
        const t = today || new Date().toISOString().slice(0, 10);
        const endOfYear = `${t.slice(0, 4)}-12-31`;
        const suggestedType = extracted.suggestedLaunchType || null;
        const typeDefaults = suggestedType ? (LAUNCH_TYPE_DEFAULTS[suggestedType] || {}) : {};

        return {
            // Fornecedor
            providerName: extracted.providerName || null,
            providerCnpj: extracted.providerCnpj || null,
            // Documento
            nfType: extracted.documentType || null,
            nfNumber: extracted.documentNumber || null,
            documentDate: extracted.documentDate || null,
            // Valor
            unitPrice: extracted.totalAmount || null,
            // Empresa/empreendimento hints
            companyHint: extracted.recipientName || null,
            enterpriseHint: extracted.enterpriseHint || null,
            serviceDescription: extracted.serviceDescription || null,
            // Datas padrão
            startDate: t,
            endDate: endOfYear,
            // Tipo sugerido
            suggestedLaunchType: suggestedType,
            budgetItem: typeDefaults.budgetItem || null,
            financialAccountNumber: typeDefaults.financialAccountNumber || null,
            // Qualidade
            confidence: extracted.confidence || null,
        };
    }

    /**
     * Monta o prefill para o frontend a partir dos dados extraídos de um Boleto.
     */
    static buildBoletoPrefill(extracted) {
        if (!extracted) return null;
        return {
            boletoBarcode: extracted.barcode || null,
            documentDate: extracted.documentDate || null,
            boletoDueDate: extracted.dueDate || null,
            boletoAmount: extracted.amount || null,
            providerName: extracted.beneficiaryName || null,
            providerCnpj: extracted.beneficiaryCnpj || null,
            confidence: extracted.confidence || null,
        };
    }
}