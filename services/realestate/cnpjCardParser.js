// services/realestate/cnpjCardParser.js
//
// Extrai os dados do Comprovante de Inscrição e de Situação Cadastral (cartão
// CNPJ da Receita Federal) em PDF para pré-preencher o cadastro de imobiliária.
// O cartão é uma tabela de pares LABEL → valor; o pdf-parse achata o texto, então
// a extração é ancorada nos labels conhecidos: captura o que existe entre um
// label e o próximo. PDF escaneado (sem camada de texto) retorna campos vazios —
// o formulário segue preenchível à mão.

// Import direto do lib/ evita o bloco de debug do index.js do pdf-parse,
// que quebra quando importado via ESM.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
// Fallback p/ cartão ESCANEADO (sem camada de texto): visão do Gemini, mesmo
// padrão do validatorAI/PaymentExtractorService.
import { AIService } from '../../validatorAI/src/services/AIService.js';

// Labels do cartão, na grafia da Receita (sem acento p/ casar normalizado).
const LABELS = [
    'NUMERO DE INSCRICAO',
    'DATA DE ABERTURA',
    'NOME EMPRESARIAL',
    'TITULO DO ESTABELECIMENTO (NOME DE FANTASIA)',
    'PORTE',
    'CODIGO E DESCRICAO DA ATIVIDADE ECONOMICA PRINCIPAL',
    'CODIGO E DESCRICAO DAS ATIVIDADES ECONOMICAS SECUNDARIAS',
    'CODIGO E DESCRICAO DA NATUREZA JURIDICA',
    'LOGRADOURO',
    'NUMERO',
    'COMPLEMENTO',
    'CEP',
    'BAIRRO/DISTRITO',
    'MUNICIPIO',
    'UF',
    'ENDERECO ELETRONICO',
    'TELEFONE',
    'ENTE FEDERATIVO RESPONSAVEL (EFR)',
    'SITUACAO CADASTRAL',
    'DATA DA SITUACAO CADASTRAL',
    'MOTIVO DE SITUACAO CADASTRAL',
    'SITUACAO ESPECIAL',
    'DATA DA SITUACAO ESPECIAL',
];

const stripAccents = (s) => String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

// Labels ordenados do mais longo para o mais curto: garante que 'NUMERO DE
// INSCRICAO' vença 'NUMERO' quando ambos são prefixo da mesma linha.
const LABELS_BY_LENGTH = [...LABELS].sort((a, b) => b.length - a.length);

function extractSections(rawText) {
    const lines = stripAccents(rawText).replace(/\r/g, '').split('\n');

    // Um label só vale no INÍCIO de linha (o título do cartão contém
    // 'SITUACAO CADASTRAL' no meio e não pode virar âncora). O valor é o
    // restante da linha + linhas seguintes até a próxima linha-label.
    const sections = {};
    let current = null;
    let buffer = [];

    const flush = () => {
        if (!current) return;
        const value = buffer.join(' ').replace(/\s+/g, ' ').trim();
        // Primeira ocorrência vence (o cartão pode repetir labels em rodapés).
        if (!(current in sections)) sections[current] = value;
        current = null;
        buffer = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const upper = trimmed.toUpperCase();
        const label = LABELS_BY_LENGTH.find(l => upper.startsWith(l));
        if (label) {
            flush();
            current = label;
            buffer.push(trimmed.slice(label.length));
        } else if (current) {
            buffer.push(trimmed);
        }
    }
    flush();
    return sections;
}

const cleanValue = (v) => {
    const s = String(v || '').trim();
    if (!s || s === '********' || /^\*+$/.test(s)) return '';
    return s;
};

// ── Fallback: cartão escaneado → visão do Gemini ─────────────────────────────

const VISION_PROMPT = `Extraia os dados deste Comprovante de Inscrição e de Situação Cadastral (cartão CNPJ) da Receita Federal do Brasil.
Retorne APENAS JSON (sem markdown):
{
  "cnpj": "<00.000.000/0000-00>",
  "razao_social": "<NOME EMPRESARIAL>",
  "nome_fantasia": "<TITULO DO ESTABELECIMENTO ou vazio>",
  "porte": "<ME|EPP|DEMAIS|vazio>",
  "data_abertura": "<dd/mm/aaaa>",
  "email": "<ENDERECO ELETRONICO ou vazio>",
  "telefone": "<primeiro telefone ou vazio>",
  "logradouro": "<LOGRADOURO>",
  "numero": "<NUMERO>",
  "complemento": "<COMPLEMENTO ou vazio>",
  "bairro": "<BAIRRO/DISTRITO>",
  "cidade": "<MUNICIPIO>",
  "estado": "<UF>",
  "cep": "<CEP>",
  "situacao_cadastral": "<ATIVA|BAIXADA|...>"
}
Campos ilegíveis ou ausentes: string vazia. Sem texto fora do JSON.`;

async function parseViaVision(buffer) {
    const result = await AIService.generateResponseFromPdf(
        `${VISION_PROMPT}\n\nEste documento é uma imagem escaneada. Use visão para ler e extrair os dados.`,
        buffer
    );
    if (result?.error || !result?.response) return null;

    let data;
    try {
        data = JSON.parse(result.response.replace(/^```json\n?|^```\n?|```$/gm, '').trim());
    } catch {
        return null;
    }

    const porte = cleanValue(data.porte).toUpperCase();
    return {
        cnpj: cleanValue(data.cnpj),
        razao_social: cleanValue(data.razao_social),
        nome_fantasia: cleanValue(data.nome_fantasia),
        micro_empresa: porte === 'ME' || porte === 'EPP' ? 'S' : (porte ? 'N' : ''),
        porte,
        data_abertura: cleanValue(data.data_abertura),
        email: cleanValue(data.email).toLowerCase(),
        telefone: cleanValue(data.telefone).split('/')[0].trim(),
        logradouro: cleanValue(data.logradouro),
        numero: cleanValue(data.numero),
        complemento: cleanValue(data.complemento),
        bairro: cleanValue(data.bairro),
        cidade: cleanValue(data.cidade),
        estado: cleanValue(data.estado).toUpperCase(),
        cep: cleanValue(data.cep),
        situacao_cadastral: cleanValue(data.situacao_cadastral).split(' ')[0],
    };
}

export async function parseCnpjCard(buffer) {
    let text = '';
    try {
        const parsed = await pdfParse(buffer);
        text = parsed?.text || '';
    } catch {
        // PDF sem camada de texto legível — segue para o fallback de visão.
    }

    // Escaneado (sem texto) ou sem CNPJ legível: tenta a visão do Gemini.
    if (!/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(text)) {
        const viaVision = await parseViaVision(buffer);
        if (viaVision?.cnpj) return viaVision;
    }

    const sections = extractSections(text);

    const cnpj = (stripAccents(text).match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/) || [''])[0];
    const porte = cleanValue(sections['PORTE']).toUpperCase();

    const razaoSocial = cleanValue(sections['NOME EMPRESARIAL']);
    const nomeFantasia = cleanValue(sections['TITULO DO ESTABELECIMENTO (NOME DE FANTASIA)']);

    return {
        cnpj,
        razao_social: razaoSocial,
        nome_fantasia: nomeFantasia,
        // ME/EPP no cartão → microempresa 'S' no CV; DEMAIS → 'N'.
        micro_empresa: porte === 'ME' || porte === 'EPP' ? 'S' : (porte ? 'N' : ''),
        porte,
        data_abertura: cleanValue(sections['DATA DE ABERTURA']),
        email: cleanValue(sections['ENDERECO ELETRONICO']).toLowerCase(),
        telefone: cleanValue(sections['TELEFONE']).split('/')[0].trim(),
        logradouro: cleanValue(sections['LOGRADOURO']),
        numero: cleanValue(sections['NUMERO']),
        complemento: cleanValue(sections['COMPLEMENTO']),
        bairro: cleanValue(sections['BAIRRO/DISTRITO']),
        cidade: cleanValue(sections['MUNICIPIO']),
        estado: cleanValue(sections['UF']).toUpperCase(),
        cep: cleanValue(sections['CEP']),
        situacao_cadastral: cleanValue(sections['SITUACAO CADASTRAL']).split(' ')[0],
    };
}

export default { parseCnpjCard };
