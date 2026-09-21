// services/academy/kbGenerateService.js
//
// Gerador de artigos do Academy — usado pelo Admin para criar rascunhos a
// partir de contexto bruto (notas, transcrições, descrição livre).
//
// Pontos importantes:
//   - SEMPRE retorna conteúdo como SUGESTÃO. O admin revisa, edita e publica.
//   - Pede JSON ao modelo, então a resposta já vem como objeto válido em vez
//     de texto solto para parsear no grito.
//   - QUEM atende sai da tela Conexões de IA (contexto 'utilidades'). Rotação
//     de chave, fallback de modelo e tradução de formato são do gateway: este
//     arquivo não conhece fornecedor nenhum.
//
// Aceita os estilos: procedimento | tutorial | faq | checklist.

import { jsonDetalhado } from '../ai/gateway.js';

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
 * Gera um rascunho de artigo. Lança erro quando o provedor não responde ou
 * devolve algo inaproveitável - aqui a falha PRECISA subir: quem chamou está
 * numa tela esperando o rascunho, e devolver vazio em silêncio pareceria bug.
 * @returns {Promise<{title: string, suggestedCategorySlug: string, body: string, model: string}>}
 */
export async function generateArticle({ topic, context = '', style = 'procedimento', categorySlug = '' } = {}) {
    const t = String(topic || '').trim();
    if (!t) throw new Error('topic obrigatório.');

    const prompt = buildPrompt({
        topic: t,
        context,
        style: STYLE_HINT[style] ? style : 'procedimento',
        categorySlug: String(categorySlug || '').trim(),
    });

    // Uma chamada só: o gateway já percorre o pool de modelos e roda as
    // chaves por dentro. Repetir isso aqui era o que multiplicava o mesmo erro
    // de credencial no log sem melhorar nada.
    const { dados: parsed, modelo } = await jsonDetalhado('utilidades', prompt, { maxSaida: 2048, temperatura: 0.55 });

    const title = String(parsed?.title || '').trim();
    const body = String(parsed?.body || '').trim();
    if (!title || !body) {
        throw new Error('A IA não retornou título ou corpo válidos. Confira o provedor em Configurações > Conexões de IA.');
    }

    return {
        title,
        suggestedCategorySlug: String(parsed?.suggestedCategorySlug || categorySlug || '').trim(),
        body,
        // A tela mostra quem gerou. Com pool e fallback, o modelo que
        // respondeu pode nao ser o primeiro da lista - entao ele vem de quem
        // atendeu, nao de uma variavel de ambiente.
        model: modelo,
    };
}
