// lib/relatorioScreens.js
//
// Telas dos relatórios comerciais (/comercial/relatorios/<relatorio>).
//
// Cada relatório é uma tela com ALÇADA PRÓPRIA - é o que permite liberar o de
// Leads para o Comercial sem abrir o Faturamento junto. Como todas leem dos
// mesmos endpoints (contratos, reservas, projeções), as rotas de API precisam
// aceitar qualquer uma delas; daí a lista viver num lugar só em vez de repetida
// em cada arquivo de rota.
//
// Espelha o catálogo do front em
// Meninger-Front/src/views/Office/Comercial/Relatorios/relatorios.js - relatório
// novo entra nos dois.

export const RELATORIO_SCREENS = [
    '/comercial/relatorios/faturamento',
    '/comercial/relatorios/projecao',
    '/comercial/relatorios/leads',
    '/comercial/relatorios/imobiliarias',
    '/comercial/relatorios/corretores',
];

export default RELATORIO_SCREENS;
