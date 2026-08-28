// services/OfficeAI/ToolPreselect.js
//
// Quais das 81 tools a Eme leva para ESTE turno.
//
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA, MEDIDO
//
// O Office declarava as 81 tools em toda pergunta: 83 KB, ~21 mil tokens de
// entrada ANTES do system prompt, do cérebro e do histórico. E não uma vez por
// pergunta - o laço de tool call reenvia tudo a cada passo (até 4) mais a
// cutucada de retry. Uma pergunta simples chegava a pagar ~120 mil tokens de
// entrada.
//
// Isso explicava os dois sintomas de uma vez:
//
//   LENTIDÃO      21k tokens é o custo fixo do turno, mesmo para "quais minhas
//                 tarefas de hoje?".
//   PERDER O FIO  com 81 declarações o modelo passa a ESCREVER o nome da tool em
//                 vez de chamá-la (o "pseudo-tool-call" que o OfficeChatService
//                 já detecta) e a repetir a resposta anterior. Não é falta de
//                 memória: é excesso de opção.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMO ESCOLHE
//
//   1. NÚCLEO         um punhado que vai sempre, porque é o que a pessoa mais
//                     pede e o que responde "o que eu tenho hoje?".
//   2. CONTINUIDADE   as tools usadas nas últimas mensagens DESTA conversa. É o
//                     que conserta o "perde contexto": se o turno anterior criou
//                     uma tarefa, "o de Naviraí coloque para amanhã" ainda
//                     encontra `atualizar_tarefa`.
//   3. AFINIDADE      pontuação da mensagem contra o NOME e a DESCRIÇÃO de cada
//                     tool. A fonte é a própria declaração - não existe tabela
//                     de palavras-chave para manter em dia, então ela não pode
//                     divergir do que a tool faz.
//
// E o principal: ERRAR AQUI NÃO QUEBRA NADA. Se a tool certa ficou de fora, o
// modelo escreve o nome dela em vez de chamar (ou diz que não consegue), o
// OfficeChatService detecta e refaz o turno com as 81. O custo do erro é uma
// resposta mais lenta, não uma resposta errada.

const TETO = 28;          // quantas declarações no máximo
const MEMORIA_TURNOS = 6; // quantas mensagens atrás olhar para continuidade

/**
 * Vai em TODO turno.
 *
 * Curto de propósito: cada nome aqui é um pedaço do orçamento que some para
 * todas as outras perguntas. São as que respondem o que a pessoa mais pergunta
 * ("o que eu tenho hoje?") e as que ela mais dispara ("anota aí").
 */
const NUCLEO = [
    'meu_dia', 'minhas_tarefas', 'criar_tarefa', 'atualizar_tarefa', 'concluir_tarefa',
];

/** Sinais de que a pergunta é sobre um assunto, e as tools que o servem. */
const PISTAS = [
    { quando: /tarefa|lembr|anota|prazo|pendenc|pendênc|afazer|to-?do|cobrar|acompanh|subtarefa|parceir|convite/i,
      tools: /^(meu_dia|criar_tarefa|minhas_tarefas|concluir_tarefa|atualizar_tarefa|marcar_subtarefa|adicionar_parceiro|meus_convites|responder_convite|configurar_assistente)$/ },
    { quando: /e-?mail|caixa|outlook|inbox|remetente|responder|encaminhar|triagem/i, tools: /^(outlook|email)/ },
    { quando: /reuni|agenda|teams|calend|compromiss/i, tools: /(meeting|agenda|teams|calendar)/i },
    { quando: /checklist|demanda|lançamento|lancamento/i, tools: /checklist/ },
    { quando: /relat[óo]rio|report|dashboard/i, tools: /report/ },
    { quando: /venda|vgv|comiss|faturamento|contrato|reserva|repasse|distrato/i,
      tools: /(contract|repasse|reserva|sales|venda|faturamento|projec)/i },
    { quando: /lead|m[ií]dia|campanha|meta|marketing|an[úu]ncio/i, tools: /(lead|marketing|campaign|meta)/i },
    { quando: /boleto|t[íi]tulo|custo|pagamento|financeiro|inadimpl|receber/i,
      tools: /(boleto|custo|payment|financ|title|titulo)/i },
    // "gestores comerciais" nao tinha pista nenhuma: a palavra que sobrava era
    // "comerciais", que pontua alto na descricao das tools de FICHA comercial -
    // e foi exatamente a tela que a Eme abriu quando pediram para convidar os
    // gestores para uma reuniao. Cargo generico agora puxa gente, nao ficha.
    { quando: /pessoa|usu[áa]rio|colaborador|equipe|organograma|cargo|gestor|gerente|diretor|coordenador|supervisor/i, tools: /(people|user|pessoa)/i },
    // Convidar e sempre duas coisas: QUEM (people) e PARA ONDE (meeting).
    { quando: /convid|convoc/i, tools: /(meeting|agenda|people|pessoa)/i },
    { quando: /imobili[áa]ria|corretor|correspondente/i, tools: /(realestate|imobili|corretor)/i },
    { quando: /processo|procedimento|pop|como fa[çz]|academy|treinamento|trilha/i, tools: /^academy/ },
    { quando: /alerta|aviso autom|monitor/i, tools: /alert/ },
    { quando: /ficha|condi[çc][ãa]o comercial|tabela de preço|tabela de preco/i, tools: /condition/ },
    { quando: /evento|plano de evento|stand/i, tools: /event/ },
];

/** Palavras que não distinguem nada: pontuar por elas escolheria ao acaso. */
const VAZIAS = new Set([
    'para', 'como', 'qual', 'quais', 'meu', 'minha', 'meus', 'minhas', 'que', 'the', 'com',
    'dos', 'das', 'uma', 'uns', 'por', 'mais', 'sobre', 'esta', 'este', 'isso', 'ele', 'ela',
    'nao', 'não', 'sim', 'todos', 'todas', 'ver', 'quero', 'preciso', 'pode', 'faz', 'fazer',
    'hoje', 'ontem', 'amanha', 'amanhã', 'agora', 'ate', 'até', 'das', 'dia', 'mes', 'mês',
]);

function palavras(txt) {
    return String(txt || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9_]+/)
        .filter(p => p.length >= 4 && !VAZIAS.has(p));
}

/**
 * As tools que esta conversa vinha usando.
 *
 * É o pedaço que resolve a queixa de "perde contexto". A pessoa diz "esse aí
 * coloque para amanhã" e não repete a palavra "tarefa" - sem continuidade a
 * pontuação por afinidade não teria como saber do que ela fala.
 */
export function tosRecentes(mensagens = []) {
    const usadas = new Set();
    for (const m of mensagens.slice(-MEMORIA_TURNOS)) {
        for (const c of (m?.metadata?.tool_calls || [])) {
            if (c?.name) usadas.add(c.name);
        }
    }
    return usadas;
}

/**
 * Escolhe as declarações do turno.
 *
 * @param {Array}  declaracoes  todas as declarações elegíveis para o usuário
 * @param {string} mensagem     o que a pessoa acabou de escrever
 * @param {Set}    recentes     nomes de tools usadas nas últimas mensagens
 * @returns {{ declaracoes: Array, cortou: number, motivo: string }}
 */
export function escolherTools(declaracoes = [], mensagem = '', recentes = new Set()) {
    // Poucas tools: não há o que cortar, e cortar só criaria risco sem ganho.
    if (declaracoes.length <= TETO) {
        return { declaracoes, cortou: 0, motivo: 'cabe inteiro' };
    }

    const texto = String(mensagem || '');
    const termos = palavras(texto);
    const escolhidas = new Map();

    const somar = (d, peso) => {
        escolhidas.set(d.name, Math.max(escolhidas.get(d.name) || 0, peso));
    };

    for (const d of declaracoes) {
        if (!d?.name) continue;

        // 1. Núcleo e continuidade entram com peso alto - não competem.
        if (NUCLEO.includes(d.name)) { somar(d, 1000); continue; }
        if (recentes.has(d.name)) { somar(d, 900); continue; }

        let pontos = 0;

        // 2. Assunto: a pista casou com a pergunta E com esta tool.
        for (const p of PISTAS) {
            if (p.quando.test(texto) && p.tools.test(d.name)) pontos += 100;
        }

        // 3. Afinidade crua com nome e descrição.
        const nome = d.name.toLowerCase();
        const desc = String(d.description || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
        for (const t of termos) {
            if (nome.includes(t)) pontos += 12;
            else if (desc.includes(t)) pontos += 3;
        }

        if (pontos > 0) somar(d, pontos);
    }

    const porNome = new Map(declaracoes.map(d => [d.name, d]));
    const ordenadas = [...escolhidas.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TETO)
        .map(([nome]) => porNome.get(nome))
        .filter(Boolean);

    // Nada pontuou: a pergunta não parece ser de dado nenhum ("bom dia", "quem é
    // você"). Mandar o núcleo é melhor que mandar as 81 - e se ela precisar de
    // outra coisa, o retry com o conjunto cheio cobre.
    if (!ordenadas.length) {
        const nucleo = declaracoes.filter(d => NUCLEO.includes(d.name));
        return { declaracoes: nucleo, cortou: declaracoes.length - nucleo.length, motivo: 'sem pista' };
    }

    return {
        declaracoes: ordenadas,
        cortou: declaracoes.length - ordenadas.length,
        motivo: `${ordenadas.length} de ${declaracoes.length}`,
    };
}

export { TETO, NUCLEO };
