// services/OfficeAI/geminiClient.js
//
// FACHADA. O nome do arquivo ficou por compatibilidade - seis serviços
// importam daqui (triagem de e-mail do Outlook, digests do Academy, busca
// semântica, insights de gasto, leitura de odômetro, cartão CNPJ) - mas nada
// aqui fala mais com o Gemini.
//
// Tudo passa pela porta única (services/ai/gateway.js), que resolve QUAL
// fornecedor atende cada contexto a partir da tela Conexões de IA. Trocar o
// provedor de utilidades para OpenAI, Anthropic ou qualquer API compatível
// passou a ser uma linha na tela - estes seis serviços não sabem e não
// precisam saber.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ASSINATURA NÃO MUDOU, DE PROPÓSITO
//
// `generateJson`, `generateJsonFromImage`, `embedText`, `toPgVector` e
// `hasGeminiKey` continuam iguais, com o mesmo comportamento em caso de falha:
// devolvem `null` e deixam o chamador cair no caminho determinístico que ele já
// tinha. Migrar a camada de baixo não é motivo para mexer em seis serviços.
//
// ─────────────────────────────────────────────────────────────────────────────
// DOIS CONTEXTOS DIFERENTES, E ISSO IMPORTA
//
//   'utilidades'  JSON e visão. Troca de fornecedor sem consequência: cada
//                 chamada é independente e o resultado é lido na hora.
//   'academy'     embedding. Aqui NÃO é só trocar: o vetor guardado tem 768
//                 dimensões e não se compara com o de outro modelo. Trocar o
//                 fornecedor exige recriar a coluna e reindexar tudo. A tela
//                 diz isso na nota do contexto.

import { json as gwJson, embed as gwEmbed } from '../ai/gateway.js';
import { temProvedorSync } from '../ai/providers.js';

// Dimensão do vetor. Está presa à coluna `vector(768)` do Academy: mudar aqui
// sem recriar a coluna e reindexar os artigos deixa a busca comparando vetores
// incomparáveis, e o sintoma é resultado ruim sem erro nenhum.
export const EMBEDDING_DIM = Number(process.env.GEMINI_EMBEDDING_DIM) > 0
    ? Number(process.env.GEMINI_EMBEDDING_DIM)
    : 768;

/**
 * Nome do modelo de embedding EM USO. Mantido porque o embeddingIndex o grava
 * junto do vetor para invalidar o índice quando o modelo muda - continua sendo
 * a informação certa, só que agora ela vem da tela.
 */
export const EMBEDDING_MODEL = (process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim();

/**
 * Vale a pena tentar?
 *
 * Síncrono porque os chamadores já eram (`if (hasGeminiKey() && ...)`), e
 * best-effort de propósito: na dúvida responde SIM. Pular um digest que daria
 * certo é pior que gastar uma chamada e receber null.
 */
export function hasGeminiKey() {
    return temProvedorSync();
}

/**
 * Embedding de um texto → number[EMBEDDING_DIM] ou null.
 *
 * Normaliza o vetor: com truncagem por dimensão (MRL) ele não vem normalizado,
 * e sem isto o cosseno daria resultados diferentes no JS e no pgvector.
 */
export async function embedText(text, { taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
    const input = String(text || '').slice(0, 8000).trim();
    if (!input) return null;
    try {
        const valores = await gwEmbed('academy', input, { dimensoes: EMBEDDING_DIM, tarefa: taskType });
        if (!Array.isArray(valores) || !valores.length) return null;
        const norma = Math.sqrt(valores.reduce((s, v) => s + v * v, 0)) || 1;
        return valores.map(v => v / norma);
    } catch (err) {
        console.warn('[geminiClient.embedText]', err?.message);
        return null;
    }
}

/** JSON estruturado a partir de um prompt. `null` quando não sai nada. */
export async function generateJson(prompt, { maxOutputTokens = 2048 } = {}) {
    return gwJson('utilidades', prompt, { maxSaida: maxOutputTokens });
}

/**
 * JSON a partir de uma IMAGEM (ou PDF).
 *
 * Nasceu para ler o odômetro na foto do painel: digitar seis dígitos de pé, no
 * estacionamento, é onde o erro entra - e um km errado vira o piso da próxima
 * leitura e contamina toda a quilometragem seguinte. A leitura é SUGESTÃO:
 * quem confirma é a pessoa, e a regra de consistência valida depois.
 *
 * @param {{ data: string, mimeType: string }} imagem  data = base64 puro
 */
export async function generateJsonFromImage(prompt, imagem, { maxOutputTokens = 512 } = {}) {
    if (!imagem?.data) return null;
    return gwJson('utilidades', prompt, { maxSaida: maxOutputTokens, imagem });
}

/** Formata floats como literal pgvector: '[0.1,0.2,...]'. null se vazio. */
export function toPgVector(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return `[${arr.map(n => Number(n)).join(',')}]`;
}

export default { embedText, generateJson, generateJsonFromImage, toPgVector, hasGeminiKey, EMBEDDING_DIM, EMBEDDING_MODEL };
