// services/OfficeAI/ProcessosTools.js
//
// A Eme consultando o MAPA DE PROCESSOS durante uma conversa.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO MUDA NA RESPOSTA DELA
//
// Sem esta tool, "o que a gente costuma fazer quando um lead trava?" só podia
// ser respondido com o que o modelo acha que uma incorporadora faz. Com ela, a
// resposta vem das regras que ESTA empresa aprovou, com o número de casos que
// sustentaram cada uma.
//
// É a diferença entre um assistente que sabe o setor e um que sabe a casa.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÓ LÊ REGRA APROVADA, E ISSO É A METADE DO DESENHO
//
// A tool NÃO enxerga observação crua nem proposta pendente. Duas razões, e as
// duas importam:
//
//   ESCOPO.   Observação carrega o escopo de onde nasceu. Se a Eme pudesse
//             lê-las, o padrão do empreendimento que a pessoa A enxerga
//             chegaria à pessoa B dentro de uma resposta de chat - o mesmo
//             vazamento que a trava de largura existe para impedir, entrando
//             por outra porta.
//   VERDADE.  Proposta é palpite do motor esperando julgamento. Ler palpite
//             como se fosse regra é a Eme afirmando para a empresa inteira algo
//             que ninguém aprovou.
//
// Regra aprovada já passou pelas duas peneiras: largura de evidência e
// aprovação de gente.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import { efetivo, ROTULOS } from '../processos/autonomia.js';
import { ativas, marcarConsulta } from '../processos/regras.js';

const SCREEN = '/tools/eme-processos';
const MAX = 8;

const normText = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

registerTool({
    name: 'query_processos',
    description: 'Consulta o MAPA DE PROCESSOS da empresa: como a casa trabalha em cada fluxo comercial (lead parado no funil, reserva até contrato, repasse e pendências, performance do time), quais REGRAS foram aprendidas e aprovadas, as etapas de cada processo e até onde a Eme pode agir sozinha. Use quando perguntarem "como a gente costuma fazer quando...", "qual é o nosso processo de...", "qual a regra para...", "o que a empresa faz quando um lead trava/uma reserva atrasa/um repasse prende". As regras vêm das aprovadas por gente, com o número de casos que sustentou cada uma: CITE esse número quando responder. NUNCA invente regra que não esteja no retorno, e NUNCA apresente etapa como se fosse regra.',
    parameters: {
        type: 'object',
        properties: {
            busca: {
                type: 'string',
                description: 'Assunto ou nome do processo (parcial): "lead", "reserva", "repasse", "performance". Vazio lista todos.',
            },
        },
    },
    // A mesma tela. Quem não tem alçada para ver o mapa também não o recebe
    // por dentro de uma conversa - senão a tool viraria a porta dos fundos da
    // permissão que a tela cobra na porta da frente.
    requiredPermissions: [SCREEN],
    contexts: ['OFFICE'],

    async handler(user, args) {
        const rows = await db.ProcessoDefinicao.findAll({
            where: { enabled: true },
            order: [['ordem', 'ASC']],
            raw: true,
        });

        const b = normText(args?.busca);
        const achados = b
            ? rows.filter(p => normText(p.nome).includes(b)
                || normText(p.descricao).includes(b)
                || normText(p.key).includes(b))
            : rows;

        if (!achados.length) {
            return {
                result: {
                    message: b
                        ? `Nenhum processo cadastrado casa com "${args.busca}". Diga isso, e cite os que existem: ${rows.map(r => r.nome).join(', ') || 'nenhum'}.`
                        : 'Nenhum processo cadastrado ainda. Diga isso em vez de descrever um processo genérico do mercado.',
                },
                resultCount: 0,
            };
        }

        const processos = achados.slice(0, MAX).map(p => {
            // Regra REVOGADA nunca chega ao modelo. Se ela chegasse, a Eme
            // continuaria afirmando para a empresa inteira algo que alguém
            // tirou do mapa justamente por estar errado.
            const regras = ativas(p.regras);
            return {
                nome: p.nome,
                descricao: p.descricao,
                etapas: (p.etapas || []).map(e => e.nome).filter(Boolean),
                // A procedência vai junto: uma regra de 40 casos e uma de 6
                // não valem a mesma coisa numa conversa, e a Eme precisa
                // conseguir dizer qual é qual.
                regras: regras.map(r => ({
                    regra: r.texto,
                    casos: r.evidencia_n ?? null,
                    vale_para: r.alcance === 'empresa' ? 'toda a empresa' : `recorte ${r.alcance}`,
                })),
                autonomia: ROTULOS[efetivo(p)],
                observacao: regras.length
                    ? null
                    : 'Este processo ainda está em observação: nenhuma regra foi aprovada. Não afirme como a empresa age aqui.',
            };
        });

        const totalRegras = processos.reduce((s, p) => s + p.regras.length, 0);

        // Marca as regras entregues como consultadas. Best-effort e sem await
        // bloqueante no caminho da resposta: contar uso é útil, mas não ao
        // ponto de atrasar o que a pessoa perguntou.
        Promise.all(achados.slice(0, MAX).map(async (p) => {
            const ids = ativas(p.regras).map((r, i) => r.id ?? i);
            if (!ids.length) return;
            await db.ProcessoDefinicao.update(
                { regras: marcarConsulta(p.regras, ids) },
                { where: { key: p.key } },
            );
        })).catch(err => console.warn('[ProcessosTools] contagem de consulta falhou:', err?.message));

        return {
            result: {
                processos,
                screenLink: SCREEN,
                message: totalRegras
                    ? `Responda SÓ com as regras acima e cite o número de casos de cada uma. Etapa não é regra: etapa é o caminho, regra é o que a empresa aprendeu. Se faltar regra para o que perguntaram, diga que ainda não há uma aprovada.`
                    : 'Nenhuma regra aprovada ainda nestes processos. Descreva as etapas se ajudar, mas deixe claro que a empresa ainda não firmou regra - não preencha o vazio com prática de mercado.',
            },
            resultCount: processos.length,
        };
    },
});

export default {};
