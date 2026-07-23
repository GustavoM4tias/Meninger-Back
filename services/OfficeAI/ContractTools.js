// services/OfficeAI/ContractTools.js
//
// Tool da Eme sobre o VALIDADOR DE CONTRATOS (tela /tools/validator):
//   - query_repasses_contratos: estatísticas dos repasses do CV — quantos contratos
//     estão em cada etapa, quantos aguardam a análise automática ("Analise Contratos"),
//     quebra por empreendimento.
//
// Fonte: API do CV ao vivo (/v1/financeiro/repasses) — não há tabela local de
// contratos validados; o validador processa a fila "Analise Contratos" e devolve
// o resultado direto no CV. Mesma alçada da tela (requiredPermissions).

import apiCv from '../../lib/apiCv.js';
import { registerTool } from './ToolRegistry.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

registerTool({
    name: 'query_repasses_contratos',
    description: 'Consulta os REPASSES/CONTRATOS do CV usados pelo Validador de Contratos (tela /tools/validator): quantos contratos/repasses existem em cada etapa (ex: "Analise Contratos" = fila do validador automático), quebra por empreendimento e filtro por etapa. Use quando o usuário perguntar "quantos contratos temos", "quantos aguardam análise/validação", "repasses do empreendimento X", "situação dos contratos". A análise automática valida CONFISSÃO DE DÍVIDA + CONTRATO CEF e aprova/reprova direto no CV. NUNCA invente números — só afirme o que vier desta ferramenta.',
    parameters: {
        type: 'object',
        properties: {
            etapa: { type: 'string', description: 'Filtra por etapa do repasse (ex: "Analise Contratos"). Parcial e sem acento funciona.' },
            empreendimento: { type: 'string', description: 'Filtra por nome (ou parte) do empreendimento.' },
            agrupar: { type: 'string', enum: ['etapa', 'empreendimento'], description: 'Quebra do gráfico. Padrão: etapa.' },
        },
    },
    requiredPermissions: ['/tools/validator'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        let repasses;
        try {
            const resp = await apiCv.get('/v1/financeiro/repasses?limit=0');
            repasses = resp.data?.repasses;
            if (!Array.isArray(repasses)) throw new Error('Resposta inválida da API de repasses do CV');
        } catch (err) {
            return {
                result: { message: `Não consegui consultar os repasses no CV agora (${String(err?.message || err).slice(0, 150)}). Diga que a consulta falhou e sugira tentar de novo em instantes ou conferir a tela /tools/validator — NÃO invente números.` },
                resultCount: 0,
            };
        }

        let rows = repasses;
        const etapa = norm(args?.etapa);
        const emp = norm(args?.empreendimento);
        if (etapa) rows = rows.filter(r => norm(r.status_repasse).includes(etapa));
        if (emp) rows = rows.filter(r => norm(r.empreendimento).includes(emp));

        const total = rows.length;
        if (!total) {
            return {
                result: { total: 0, message: 'Nenhum repasse encontrado nesse filtro no CV. Diga isso com clareza — não invente. Tela do validador: /tools/validator.' },
                resultCount: 0,
            };
        }

        const agrupar = args?.agrupar === 'empreendimento' ? 'empreendimento' : 'etapa';
        const keyOf = agrupar === 'empreendimento'
            ? (r) => r.empreendimento || 'Sem empreendimento'
            : (r) => r.status_repasse || 'Sem etapa';

        const byKey = new Map();
        for (const r of rows) byKey.set(keyOf(r), (byKey.get(keyOf(r)) || 0) + 1);
        const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1]);

        const filaValidador = repasses.filter(r => r.status_repasse === 'Analise Contratos').length;
        const quebra = sorted.slice(0, 15).map(([k, v], i) => `[${i + 1}] ${k}: ${v}`).join('\n');

        return {
            result: {
                total,
                fila_analise_contratos: filaValidador,
                quebra,
                type: 'chart',
                chartType: 'bar',
                title: `Repasses por ${agrupar}`,
                subtitle: `${total} repasse(s) no filtro`,
                labels: sorted.slice(0, 15).map(([k]) => k),
                data: sorted.slice(0, 15).map(([, v]) => v),
                message: `${total} repasse(s)/contrato(s) no filtro. Quebra por ${agrupar} no campo "quebra" (o gráfico JÁ está na UI). No total geral, ${filaValidador} está(ão) na etapa "Analise Contratos" — a fila do validador automático. Responda CURTO usando SOMENTE estes dados. Para rodar a análise automática ou ver um contrato: tela /tools/validator.`,
            },
            resultCount: total,
            filtersApplied: { etapa: args?.etapa || undefined, empreendimento: args?.empreendimento || undefined },
        };
    },
});
