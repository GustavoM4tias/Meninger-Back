// lib/screenCapabilities.js
//
// CAPACIDADES (ações) dentro de cada tela — a fonte ÚNICA de "quem pode o quê"
// depois que a tela já está aberta.
//
// Antes disto, cada tela delegada inventava a própria regra: um
// `computed(() => auth.hasRole('admin'))` no componente escondia a aba, e o
// backend tinha um `requireAdmin` solto na rota. Dois lugares, duas fontes de
// verdade, nada auditável — dava para esconder o botão e esquecer a API (ou o
// contrário) sem ninguém perceber.
//
// Agora a regra mora AQUI, uma vez:
//
//   '/rota-da-tela': { acao: 'screen' | 'admin' }
//
//     'screen' → basta ter a tela na alçada (admin também passa, como sempre)
//     'admin'  → só administrador, independente da alçada
//
// Quem consome:
//   - services/permissions/capabilityService.js  → calcula o que ESTE usuário pode
//   - middlewares/requireCapability.js           → enforcement na API
//   - GET /api/permissions/me                    → manda a lista pronta ao front,
//     que só pergunta `can('configure')`. O front NUNCA recalcula a regra, então
//     não tem como ficar mais permissivo que o servidor.
//
// Ao delegar uma tela nova: primeiro descreva as ações aqui, depois use
// requireCapability nas rotas e o can() na tela. Ação que não está aqui é
// negada para não-admin (fail-closed).

export const SCREEN_CAPABILITIES = {
    // Outlook — a caixa de e-mail da propria pessoa dentro do Office.
    // Ler e organizar sao trabalho do dia. ENVIAR e caso a parte: sai mensagem
    // no nome da pessoa, para fora da empresa, e nao tem desfazer - por isso
    // capacidade propria, que o admin pode dar so a quem precisa.
    '/microsoft/outlook': {
        view: 'screen',      // ler, buscar, baixar anexo
        organize: 'screen',  // marcar, sinalizar, categorizar, mover, excluir
        send: 'screen',      // rascunho, resposta e envio
    },

    // Ato (Cobrança) — a tela única das duas formas de cobrar a entrada: boleto
    // Caixa e link de cartão Userede. Histórico e operação vão por alçada; a
    // configuração (credenciais dos dois portais, janelas, comissão, templates)
    // é admin.
    '/financeiro/cobranca/ato': {
        view: 'screen',       // histórico, filtros, KPIs, detalhe, timeline
        operate: 'screen',    // reprocessar, regerar, reenviar, conferir pagamento, excluir link
        configure: 'admin',   // aba Configurações dos dois portais
    },

    // Rotas antigas mantidas enquanto o redirect existir: alçada gravada antes
    // da unificação continua valendo até o rename rodar no boot.
    '/financeiro/boleto-caixa': {
        view: 'screen',
        operate: 'screen',
        configure: 'admin',
    },
    '/financeiro/link-cartao': {
        view: 'screen',
        configure: 'admin',
    },

    // Cancelamento de Reservas — mesma forma.
    '/comercial/cancelamento-reservas': {
        view: 'screen',
        operate: 'screen',    // reprocessar um caso do histórico
        configure: 'admin',   // aba Configurações + processar avulso + simular
    },

    // Mural de Avisos (gestão) — redigir e publicar é trabalho de comunicação;
    // apagar comunicado é irreversível e some com a trilha de leitura, então
    // fica com o admin.
    '/mural/admin': {
        view: 'screen',
        manage: 'screen',     // criar, editar, público-alvo, publicar, arquivar
        remove: 'admin',      // excluir de vez
    },

    // ── Telas que já eram delegáveis e tinham a regra espalhada ──────────────
    // Migradas em 2026-08-20. O mapeamento é 1:1 com o que já valia (o gate
    // antigo virou linha aqui), então nenhum acesso muda.

    // Checklists — participar é de quem tem a tela (o dono/responsável de cada
    // tarefa ainda é conferido no taskService); montar o checklist é admin.
    '/checklists': {
        view: 'screen',       // ler, mexer na própria tarefa, comentar, anexar, aprovar
        manage: 'admin',      // criar/editar checklist, seções, templates, status,
                              // régua de cobrança, perfis de autorização, importar Excel
    },

    // Fichas Comerciais — quem pode EDITAR/AUTORIZAR uma ficha é regra de
    // NEGÓCIO (perfil de autorização do módulo, em GET /conditions/permissions)
    // e continua lá. Aqui fica só o que é alçada x admin.
    '/comercial/conditions': {
        view: 'screen',
        configure: 'admin',   // configurações do módulo + integração DocuSign
    },

    // Fluxo de Pagamento — cadastro de tipo de lançamento e a coluna de quem
    // criou o lançamento são supervisão.
    '/financeiro/paymentflow': {
        view: 'screen',
        configure: 'admin',   // tipos de lançamento + visão de autoria
    },

    // Organograma — ver é alçada (hoje só o Comercial); mexer no layout
    // (reposicionar pessoa) é admin, igual às rotas de escrita.
    '/settings/organograma': {
        view: 'screen',
        edit: 'admin',        // "Editar layout": grava override de posição
    },

    // Relatório de Faturamento — ler é alçada; mexer nas REGRAS que mudam o
    // número (VGV, comissão, ajuste contábil, fechamento do mês) é admin.
    '/comercial/relatorios/faturamento': {
        view: 'screen',
        configure: 'admin',   // regras de valor/comissão, ajustes contábeis,
                              // consolidação do fechamento mensal
    },

    // Relatório Vendas x Projeção — ler é alçada; a regra de meta (unidades x
    // VGV) vale para TODOS os leitores da tela, então é admin. O não-admin
    // continua enxergando a regra vigente, só não muda.
    '/comercial/relatorios/projecao': {
        view: 'screen',
        configure: 'admin',   // modo de meta global + exceções por empreendimento
    },

    // Empreendimentos — puxar as tabelas de preço do CV mexe no insumo das
    // Fichas Comerciais, então é supervisão.
    '/comercial/buildings': {
        view: 'screen',
        sync: 'admin',        // sincronizar tabelas de preço do CV
    },

    // MCMV — a tabela de limites por cidade vale para todo mundo que simula.
    '/comercial/mcmv': {
        view: 'screen',
        configure: 'admin',   // limites/vigência (tela /comercial/mcmv/settings)
    },

    // Editor de Projeção — montar a projeção é admin (o guard já existia dentro
    // do controller). Ler a lista é da alçada de quem acompanha metas.
    '/comercial/projections': {
        view: 'screen',
        edit: 'admin',        // criar, clonar, salvar grid, renomear, excluir
    },

    // Viabilidade — liberar etapa e configurar é decisão de gestão.
    '/marketing/viabilidade': {
        view: 'screen',
        configure: 'admin',   // liberação por etapa, tetos e configurações
    },

    // Imobiliárias — consultar o cadastro das parceiras é trabalho do dia.
    // CADASTRAR é caso à parte: escreve no CV de verdade e o link público
    // permite que alguém de fora preencha, então é ação própria. Forçar a
    // varredura completa do CV virou supervisão depois que o cron horário
    // passou a manter o espelho em dia (o botão é só um refresh manual; o
    // cadastro feito aqui já sincroniza sozinho o registro dele).
    '/comercial/imobiliarias': {
        view: 'screen',       // lista, filtros, detalhe, contatos, gerente
        register: 'screen',   // cadastro direto no CV, gerar/editar/revogar link, reprocessar
        sync: 'admin',        // varredura completa do CV pelo botão
    },

    // Leads — a trilha de EXPORTAÇÕES é auditoria (quem baixou base de lead).
    '/marketing/leads': {
        view: 'screen',
        audit: 'admin',       // log de exportações
    },
};

/** Ações declaradas de uma tela (objeto vazio se a tela não declara nenhuma). */
export function capabilitiesOf(route) {
    return SCREEN_CAPABILITIES[String(route || '').toLowerCase()] || {};
}

/** Todas as telas que declaram capacidades. */
export function screensWithCapabilities() {
    return Object.keys(SCREEN_CAPABILITIES);
}

export default { SCREEN_CAPABILITIES, capabilitiesOf, screensWithCapabilities };
