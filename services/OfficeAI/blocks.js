// services/OfficeAI/blocks.js
//
// Construtores do contrato EmeBlock (Meninger-Front/_design/EME-COMPONENTES-PLANO.md,
// seção 2) para as tools da Eme. A tool devolve DADO num formato único; o
// visual é escolhido por cima - pela Eme (`visual`), pela pessoa (botão de
// trocar) ou pela régua do front (escolherVisual).
//
// Regra de transição (fase 4): a tool devolve `blocks` JUNTO do formato
// antigo (`type: 'table'|'chart'` + rows/labels). O chat lê `blocks`; alertas,
// relatórios e o resumo para o modelo continuam lendo o antigo até migrarem.
//
// Nada aqui formata número: valor vai cru e tipado (`type` da coluna), e o
// componente formata. É o que deixa a mesma coluna virar tabela, barra ou
// rosca sem voltar ao servidor.

export const VISUALS = ['table', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'heatmap', 'combo', 'comparison', 'funnel', 'rank', 'cards', 'kpis'];

/** Argumento `visual` para a declaração de qualquer tool de dado. */
export const VISUAL_PARAM = {
    type: 'string',
    enum: VISUALS,
    description: 'Como mostrar o resultado, SÓ quando a pessoa pedir ("em pizza", "em barras", "compara", "linha do tempo", "só os números", "em tabela"). Omitido, a tela escolhe pela forma do dado.',
};
export const VISUAL_PARAM_GEMINI = { ...VISUAL_PARAM, type: 'STRING' };

export const visualPedido = (args) => (VISUALS.includes(args?.visual) ? { type: args.visual } : undefined);

const limpar = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Bloco de dataset (lista ou série). `columns` tipadas:
 *   { key, label, type: text|number|currency|percent|date|month|badge|link, priority?, sortable? }
 * `series` opcional: [{ key, label, role: 'meta' }] para o combo.
 */
export function datasetBlock({ id, title, subtitle, source, columns, rows, total, truncated, visual, actions, series, parteDeUmTodo }) {
    return limpar({
        id, kind: 'dataset', title, subtitle, source,
        visual: typeof visual === 'string' ? { type: visual } : visual,
        dataset: limpar({
            columns: columns || [], rows: rows || [],
            total: total ?? (rows || []).length,
            truncated: !!truncated,
            series, parteDeUmTodo,
        }),
        actions,
    });
}

/** KPIs: [{ label, value, type?, unit?, hint?, tone?, delta? }]. `inline` = em linha (bolha). */
export function kpisBlock({ id, title, subtitle, source, kpis, inline = true, actions }) {
    return limpar({ id, kind: 'kpis', title, subtitle, source, inline, kpis: kpis || [], actions });
}

/** Cards: [{ title, subtitle?, badges?, fields?, avatar?, icon?, meta?, actions? }]. */
export function cardsBlock({ id, title, subtitle, source, cards, actions }) {
    return limpar({ id, kind: 'cards', title, subtitle, source, cards: cards || [], actions });
}

/** Detalhe de UM registro: { fields?, sections?: [{ title, icon?, fields }] }. */
export function detailBlock({ id, title, subtitle, source, icon, detail, actions }) {
    return limpar({ id, kind: 'detail', title, subtitle, source, icon, detail: detail || {}, actions });
}

/** Opções que viram prompt ou navegação: [{ label, prompt?, route?, filters?, icon? }]. */
export function choiceBlock({ id, label, options, multiple, submitPrompt, submitLabel }) {
    return limpar({ id, kind: 'choice', choice: limpar({ label, options: options || [], multiple, submitPrompt, submitLabel }) });
}

export function navBlock({ id, route, filters, message }) {
    return limpar({ id, kind: 'nav', nav: limpar({ route, filters, message }) });
}

/** Ação de abrir tela, para `actions` de qualquer bloco. */
export const abrirTela = (route, label = 'Abrir tela', filters) => limpar({ kind: 'navigate', label, payload: limpar({ route, filters }) });

export default { VISUALS, VISUAL_PARAM, VISUAL_PARAM_GEMINI, visualPedido, datasetBlock, kpisBlock, cardsBlock, detailBlock, choiceBlock, navBlock, abrirTela };
