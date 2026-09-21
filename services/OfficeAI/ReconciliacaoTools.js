// services/OfficeAI/ReconciliacaoTools.js
//
// "Por que o mapa diz 48 reservadas e a Eme diz 149 reservas?"
//
// Os dois estavam certos: o mapa conta ESTOQUE (o estado de cada unidade
// agora) e as reservas contam FLUXO (registros criados no período, e a mesma
// unidade pode ter sido reservada, distratada e reservada de novo).
//
// Comparar os dois totais nunca ia fechar. Esta tool não compara totais:
// compara UNIDADE A UNIDADE e devolve só onde os dois discordam, com o nome do
// problema. É a diferença entre "esses números não batem" e "estas 6 unidades
// estão divergentes, e por quê".

import { registerTool } from './ToolRegistry.js';
import { reconciliarUnidades } from '../comercial/reconciliacaoService.js';
import { resolverEmpreendimentos } from '../org/enterpriseResolver.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';

const SCREEN = '/comercial/relatorios/reservas';

registerTool({
    name: 'reconciliar_unidades',
    description: 'Compara o MAPA DE DISPONIBILIDADE (estado de cada unidade no CV) com as RESERVAS do sistema, unidade a unidade, e devolve só onde os dois discordam. '
        + 'Use quando perguntarem "o mapa não bate com as reservas", "por que o CV diz X e aqui diz Y", "tem unidade vendida duas vezes?", "confere o estoque do empreendimento". '
        + 'Acusa quatro problemas: unidade ocupada no mapa sem reserva viva, reserva viva com a unidade aberta no mapa (pode ser vendida de novo), estados divergentes, e a mesma unidade com duas reservas vivas. '
        + 'NÃO serve para contar reservas nem para ver o funil: para isso use query_reservas.',
    parameters: {
        type: 'object',
        properties: {
            empreendimento: {
                type: 'string',
                description: 'Nome do empreendimento (aceita o nome ANTIGO: o CV renomeia) ou o id do CV. Um por chamada.',
            },
            limite: { type: 'number', description: 'Máximo de divergências detalhadas. Padrão 200.' },
        },
        required: ['empreendimento'],
    },
    requiredPermissions: [SCREEN],
    contexts: ['OFFICE'],

    async handler(user, args) {
        const termo = String(args?.empreendimento || '').trim();
        if (!termo) return { result: { erro: 'Diga qual empreendimento conferir.' } };

        // O nome só serve para ACHAR; o recorte é por id. O CV renomeia, e o
        // nome que a reserva guardou é o da época dela.
        const r = await resolverEmpreendimentos(termo);
        if (!r.empreendimentos.length) {
            return { result: {
                erro: `Não achei empreendimento com "${termo}", nem pelo nome atual, nem por nome antigo, nem nas reservas.`,
            } };
        }
        if (r.empreendimentos.length > 1) {
            return { result: {
                precisaEscolher: true,
                candidatos: r.empreendimentos.map(e => ({ nome: e.nome, cidade: e.cidade, cv_id: e.cv_id })),
                resumo: `"${termo}" casa com ${r.empreendimentos.length} empreendimentos. Pergunte qual, pelo NOME e pela CIDADE.`,
            } };
        }

        const alvo = r.empreendimentos[0];

        // Escopo: admin (null) vê tudo; os demais só o que está liberado.
        const cvIds = await visibleCvIds(user);
        if (cvIds && !cvIds.includes(Number(alvo.cv_id))) {
            return { result: { erro: 'Este empreendimento não está no seu escopo de acesso.' } };
        }

        const dados = await reconciliarUnidades(alvo.cv_id, {
            limite: Math.min(500, Math.max(1, Number(args?.limite) || 200)),
        });
        if (dados.erro) return { result: { erro: dados.erro } };

        const { resumo } = dados;
        const totalDiv = resumo.unidades - resumo.conferem;

        return {
            result: {
                type: 'reconciliacao_unidades',
                empreendimento: {
                    nome: alvo.nome, cidade: alvo.cidade, cv_id: alvo.cv_id,
                    // Vai junto para a Eme poder dizer "que já se chamou X",
                    // que é o que explica um histórico parecendo menor.
                    nomes_anteriores: alvo.nomes_anteriores,
                },
                encontrado_por: r.via,
                resumo,
                divergencias: dados.divergencias,
                truncado: dados.truncado,
                mensagem: totalDiv
                    ? `${totalDiv} de ${resumo.unidades} unidade(s) divergem (${resumo.taxa_divergencia}%). `
                        + 'Cite os TIPOS e quantos de cada; liste as unidades só se pedirem. '
                        + 'As duas graves são "duplicada" e "reserva_sem_ocupacao": as duas terminam com duas pessoas comprando o mesmo imóvel. '
                        + 'NÃO compare o total de unidades com o total de reservas: um é estoque de agora, o outro é fluxo do período.'
                    : `As ${resumo.unidades} unidades conferem com as reservas. `
                        + 'Se o usuário estranhou uma diferença de totais, explique que o mapa conta ESTOQUE (agora) e as reservas contam FLUXO (do período), '
                        + 'e que a mesma unidade pode ter várias reservas ao longo do ano.',
            },
            resultCount: dados.divergencias.length,
        };
    },
});

export default {};
