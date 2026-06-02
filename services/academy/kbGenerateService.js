// services/academy/kbGenerateService.js
//
// Gerador de artigos do Academy via Gemini — usado pelo Admin para criar
// rascunhos a partir de contexto bruto (notas, transcrições, descrição livre).
//
// Pontos importantes:
//   - SEMPRE retorna conteúdo como SUGESTÃO. O admin revisa, edita e publica.
//   - Usa o JSON mode do Gemini (responseMimeType=application/json) — o modelo
//     já devolve um objeto válido, sem precisar parsear texto solto.
//   - Faz rotação de chave: tenta cada GEMINI_API_KEY em sequência se falhar.
//
// Variáveis de ambiente:
//   - GEMINI_API_KEYS (lista, separada por vírgula) ou GEMINI_API_KEY
//   - GEMINI_ARTICLE_MODEL (opcional, default: gemini-2.5-flash)
//
// Aceita os estilos: procedimento | tutorial | faq | checklist.

import { GoogleGenerativeAI } from '@google/generative-ai';

function getKeys() {
    return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map((k) => k.trim()).filter(Boolean);
}

function getModelName() {
    return process.env.GEMINI_ARTICLE_MODEL
        || process.env.GEMINI_MODEL
        || 'gemini-2.5-flash';
}

const STYLE_HINT = {
    procedimento: 'um procedimento operacional padrão (POP) com: # Título, ## Objetivo, ## Pré-requisitos, ## Passo a passo, ## Validação, ## Erros comuns.',
    tutorial: 'um tutorial passo a passo com: # Título, ## Introdução, ## Cenário, ## Passos (numerados), ## Resultado esperado.',
    faq: 'um documento de Perguntas Frequentes com: # Título e 4 a 8 blocos no formato "## Pergunta?\\n\\nResposta curta e direta.".',
    checklist: 'um checklist objetivo com: # Título, ## Antes de começar, ## Checklist (itens no formato "- [ ] ..."), ## Conferência final.',
};

function buildPrompt({ topic, context, style, categorySlug }) {
    const styleHint = STYLE_HINT[style] || STYLE_HINT.procedimento;
    const catHint = categorySlug
        ? `A categoria sugerida pelo administrador é "${categorySlug}". Mantenha-a salvo se for incoerente.`
        : 'Sugira uma categoria em kebab-case (ex.: processos-comerciais, suporte-tecnico).';
    const ctx = String(context || '').trim();
    const ctxBlock = ctx
        ? `Contexto detalhado fornecido pelo administrador:\n"""\n${ctx}\n"""`
        : 'O administrador não forneceu contexto extra — gere com base no tópico e seja explícito sobre o que precisa ser confirmado pelo admin.';

    return `Você é o gerador de artigos do Menin Academy (plataforma de ensino corporativo da Menin).
Produza UM artigo em português do Brasil, com tom claro, didático e direto.

Formato pedido: ${styleHint}

Regras estritas:
- Use APENAS Markdown puro. NÃO inclua HTML, scripts, links externos ou imagens.
- Use \`#\` apenas no título principal. Subseções com \`##\` (e \`###\` se necessário).
- Listas com "- " ou "1. ". Frases curtas. Sem prosa enrolada.
- NÃO invente nomes de sistemas, pessoas ou dados que não estejam no contexto.
- Onde faltar informação para concluir com segurança, marque com "[ ! confirmar ]"
  em vez de chutar.
- Mantenha o artigo focado e útil para alguém que vai consultar na hora de executar.

${catHint}

Tópico: ${topic}

${ctxBlock}

Responda EXCLUSIVAMENTE com um objeto JSON válido, sem texto antes ou depois,
no formato exato:
{
  "title": "Título do artigo (sem o # do markdown)",
  "suggestedCategorySlug": "categoria-em-kebab-case",
  "body": "# Título...\\n\\n## Objetivo\\n..."
}`;
}

/**
 * Gera um rascunho de artigo. Lança erro em caso de falha em todas as chaves.
 * @returns {Promise<{title: string, suggestedCategorySlug: string, body: string, model: string}>}
 */
export async function generateArticle({ topic, context = '', style = 'procedimento', categorySlug = '' } = {}) {
    const keys = getKeys();
    if (!keys.length) {
        throw new Error('GEMINI_API_KEY(S) não configurada(s) no servidor.');
    }

    const t = String(topic || '').trim();
    if (!t) throw new Error('topic obrigatório.');

    const prompt = buildPrompt({
        topic: t,
        context,
        style: STYLE_HINT[style] ? style : 'procedimento',
        categorySlug: String(categorySlug || '').trim(),
    });

    const modelName = getModelName();

    let lastErr = null;
    for (let attempt = 0; attempt < keys.length; attempt++) {
        try {
            const client = new GoogleGenerativeAI(keys[attempt]);
            const model = client.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    temperature: 0.55,
                    maxOutputTokens: 2048,
                    responseMimeType: 'application/json',
                },
            });

            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });

            const raw = (result?.response?.text?.() || '').trim();
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // Fallback: se o modelo embrulhar o JSON em texto, tenta extrair.
                const match = raw.match(/\{[\s\S]*\}/);
                if (match) parsed = JSON.parse(match[0]);
            }

            const title = String(parsed?.title || '').trim();
            const body = String(parsed?.body || '').trim();

            if (!title || !body) {
                throw new Error('A IA não retornou título ou corpo válidos.');
            }

            return {
                title,
                suggestedCategorySlug:
                    String(parsed?.suggestedCategorySlug || categorySlug || '').trim(),
                body,
                model: modelName,
            };
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr || new Error('Falha ao gerar artigo.');
}
