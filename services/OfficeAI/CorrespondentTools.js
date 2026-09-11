// services/OfficeAI/CorrespondentTools.js
//
// Tool da Eme sobre os CORRESPONDENTES BANCÁRIOS (CCAs) - tela CV CRM >
// Correspondentes:
//   - correspondentes_search: empresas correspondentes e seus usuários no CV,
//     QUAIS EMPREENDIMENTOS cada uma atende (pela Ficha Comercial) e quantos
//     pré-cadastros analisou no período.
//
// Três fontes que antes não conversavam:
//   1. o panorama da tela (correspondentService.montarPanorama): empresas +
//      usuários, já no escopo de cidade do usuário;
//   2. a Ficha Comercial: cada módulo aponta o correspondente que atende o
//      produto (enterprise_condition_modules.correspondent_id → usuário do CV)
//      ou, no mínimo, o nome da CCA digitado (cca_company_name);
//   3. os pré-cadastros do CV, que carregam idempresa_correspondente.
//
// Segurança: a alçada é a da tela (/crm/correspondentes); o escopo de cidade
// vem do panorama e o de empreendimento (pré-cadastros) do accessScopeService,
// os dois calculados pelo `user`, nunca pelos args.
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { montarPanorama } from '../correspondent/correspondentService.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';
import { PRECAD_BUCKET_CASE } from './ComercialTools.js';

const SCREEN = '/crm/correspondentes';
const MAX_LINHAS = 25;
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const { EnterpriseCondition, EnterpriseConditionModule, CvEnterprise } = db;

/**
 * Empreendimentos atendidos por cada CCA segundo a ficha MAIS RECENTE de cada
 * série. Devolve dois mapas: por idempresa do CV (quando o módulo aponta o
 * usuário) e por nome normalizado da CCA (quando só há o nome digitado).
 */
async function empreendimentosPorCca(usuarioParaEmpresa) {
    const fichas = await EnterpriseCondition.findAll({
        attributes: ['id', 'idempreendimento', 'series_id', 'display_name', 'reference_month'],
        include: [
            { model: CvEnterprise, as: 'enterprise', attributes: ['nome'] },
            { model: EnterpriseConditionModule, as: 'modules', attributes: ['module_name', 'correspondent_id', 'cca_company_name'] },
        ],
        order: [['reference_month', 'DESC'], ['id', 'DESC']],
    });

    const porEmpresa = new Map();   // idempresa → Set(nome do empreendimento)
    const porNome = new Map();      // nome normalizado da CCA → Set(nome)
    const vistas = new Set();
    for (const f of fichas) {
        const serie = f.idempreendimento != null ? `cv:${f.idempreendimento}` : (f.series_id != null ? `s:${f.series_id}` : `f:${f.id}`);
        if (vistas.has(serie)) continue;    // só a ficha mais recente da série
        vistas.add(serie);
        const nome = f.enterprise?.nome || f.display_name || `Ficha #${f.id}`;
        for (const m of f.modules || []) {
            const emp = usuarioParaEmpresa.get(Number(m.correspondent_id));
            if (emp) {
                if (!porEmpresa.has(emp)) porEmpresa.set(emp, new Set());
                porEmpresa.get(emp).add(nome);
            }
            const cca = normText(m.cca_company_name);
            if (cca) {
                if (!porNome.has(cca)) porNome.set(cca, new Set());
                porNome.get(cca).add(nome);
            }
        }
    }
    return { porEmpresa, porNome };
}

/** Pré-cadastros por empresa correspondente nos últimos `dias`, por bucket do funil. */
async function precadastrosPorCca(user, dias) {
    const cvIds = await visibleCvIds(user);      // null = admin
    if (cvIds && !cvIds.length) return new Map();
    const rows = await db.sequelize.query(`
        SELECT p.idempresa_correspondente AS idempresa,
               ${PRECAD_BUCKET_CASE} AS bucket,
               COUNT(*)::int AS n
          FROM cv_precadastros p
         WHERE p.idempresa_correspondente IS NOT NULL
           AND p.data_cad >= :desde
           ${cvIds ? 'AND p.idempreendimento IN (:cvIds)' : ''}
         GROUP BY 1, 2`, {
        replacements: { desde: dayjs().subtract(dias, 'day').startOf('day').toDate(), cvIds: cvIds || undefined },
        type: db.Sequelize.QueryTypes.SELECT,
    });
    const out = new Map();
    for (const r of rows) {
        const e = out.get(Number(r.idempresa)) || { total: 0, aprovado: 0, reserva: 0, reprovado: 0, em_analise: 0, documentacao: 0, outros: 0 };
        e.total += r.n;
        e[r.bucket] = (e[r.bucket] || 0) + r.n;
        out.set(Number(r.idempresa), e);
    }
    return out;
}

registerTool({
    name: 'correspondentes_search',
    description: 'Consulta os CORRESPONDENTES BANCÁRIOS (CCAs) - as empresas que analisam o crédito do cliente - e as pessoas de cada uma no CV: contatos, gerentes, cidades onde atuam, QUAIS EMPREENDIMENTOS cada CCA atende segundo a Ficha Comercial, e quantos pré-cadastros analisou no período (aprovados, em reserva, reprovados). Use para "quem é o correspondente do empreendimento X", "quais CCAs atendem em [cidade]", "contato da CCA Y", "qual correspondente aprova mais", "quantas pastas a CCA Z analisou". Para comparar taxa de aprovação entre CCAs com filtros finos use query_precadastros (group_by empresa_correspondente). NUNCA invente contato, nome ou número.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Busca livre: nome da CCA/empresa ou nome de uma pessoa (correspondente).' },
            cidade: { type: 'string', description: 'Filtra pelas cidades onde a CCA atua.' },
            empreendimento: { type: 'string', description: 'Só CCAs que atendem este empreendimento (segundo a Ficha Comercial). Nome ou parte.' },
            dias: { type: 'number', description: 'Janela dos pré-cadastros contados, em dias. Padrão 90.' },
        },
    },
    requiredPermissions: [SCREEN],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const dias = Math.min(Math.max(Number(args?.dias) || 90, 7), 730);
        const panorama = await montarPanorama(user);

        // usuário do CV → empresa (para casar o correspondent_id da ficha)
        const usuarioParaEmpresa = new Map();
        for (const e of panorama.empresas) for (const u of e.usuarios || []) usuarioParaEmpresa.set(Number(u.idusuario), Number(e.cv_idempresa));

        const [{ porEmpresa, porNome }, precad] = await Promise.all([
            empreendimentosPorCca(usuarioParaEmpresa),
            precadastrosPorCca(user, dias),
        ]);

        const q = normText(args?.query);
        const cidade = normText(args?.cidade);
        const emp = normText(args?.empreendimento);

        let empresas = panorama.empresas.map(e => {
            const atende = new Set([
                ...(porEmpresa.get(Number(e.cv_idempresa)) || []),
                ...(porNome.get(normText(e.nome)) || []),
            ]);
            return { ...e, atende: [...atende].sort(), precad: precad.get(Number(e.cv_idempresa)) || null };
        });

        if (q) {
            empresas = empresas.filter(e =>
                normText(e.nome).includes(q) || (e.usuarios || []).some(u => normText(u.nome).includes(q)));
        }
        if (cidade) empresas = empresas.filter(e => (e.cidades || []).some(c => normText(c).includes(cidade)));
        if (emp) empresas = empresas.filter(e => e.atende.some(n => normText(n).includes(emp)));

        const total = empresas.length;
        if (!total) {
            return {
                result: { total: 0, message: `Nenhum correspondente encontrado nesse filtro (dentro do que o usuário pode ver). Diga isso com clareza - não invente. Tela: ${SCREEN}.` },
                resultCount: 0,
            };
        }

        // Quem analisou mais primeiro; empate por quem atende mais empreendimentos.
        empresas.sort((a, b) => (b.precad?.total || 0) - (a.precad?.total || 0) || b.atende.length - a.atende.length || a.nome.localeCompare(b.nome, 'pt-BR'));
        const shown = empresas.slice(0, MAX_LINHAS);

        const linhas = shown.map(e => {
            const gerentes = (e.usuarios || []).filter(u => u.gerente && u.ativo_login).map(u => u.nome);
            const p = e.precad;
            return {
                cca: e.nome,
                cidades: (e.cidades || []).join(', ') || '-',
                pessoas: e.total_usuarios,
                gerentes: gerentes.slice(0, 3).join(', ') + (gerentes.length > 3 ? ` +${gerentes.length - 3}` : '') || '-',
                empreendimentos: e.atende.join(', ') || '-',
                pre_cadastros: p ? p.total : 0,
                aprovados: p ? (p.aprovado + p.reserva) : 0,
                reprovados: p ? p.reprovado : 0,
                contato: [e.email, e.telefone].filter(Boolean).join(' · ') || '-',
            };
        });

        // Uma empresa só: leva as pessoas com contato, que é o que se pergunta
        // ("quem é o contato da CCA X?").
        const detalhe = shown.length === 1 ? {
            cca: shown[0].nome,
            status_cadastro: shown[0].origem,
            cidades: shown[0].cidades,
            atende: shown[0].atende,
            pre_cadastros_periodo: shown[0].precad,
            pessoas: (shown[0].usuarios || []).map(u => ({
                nome: u.nome, gerente: u.gerente, ativo: u.ativo_login,
                contato: [u.email, u.celular || u.telefone].filter(Boolean).join(' · ') || undefined,
            })),
        } : undefined;

        const totalPrecad = shown.reduce((s, e) => s + (e.precad?.total || 0), 0);
        return {
            result: {
                type: 'table',
                title: 'Correspondentes (CCAs)',
                subtitle: `${total} empresa(s) · ${totalPrecad} pré-cadastro(s) nos últimos ${dias} dias`,
                columns: [
                    { key: 'cca', label: 'CCA' },
                    { key: 'cidades', label: 'Atua em' },
                    { key: 'gerentes', label: 'Gerente(s)' },
                    { key: 'empreendimentos', label: 'Atende (ficha)' },
                    { key: 'pre_cadastros', label: `Pastas ${dias}d`, type: 'number' },
                    { key: 'aprovados', label: 'Aprov.+Reserva', type: 'number' },
                    { key: 'reprovados', label: 'Reprov.', type: 'number' },
                    { key: 'contato', label: 'Contato' },
                ],
                rows: linhas,
                total,
                detalhe,
                screenLink: SCREEN,
                message: `${total} correspondente(s) no filtro (${shown.length} na tabela, que JÁ está na UI). "Atende" vem da Ficha Comercial mais recente de cada empreendimento; pastas contadas nos últimos ${dias} dias, só de empreendimentos que o usuário enxerga. Responda CURTO com o que foi perguntado usando SOMENTE estes dados - nunca invente contato ou número. Empreendimento sem CCA na tabela = a ficha dele não aponta correspondente (diga isso, não deduza). Tela: ${SCREEN}.`,
                context: { source: 'correspondentes', dias },
            },
            resultCount: total,
            filtersApplied: { query: q || undefined, cidade: cidade || undefined, empreendimento: emp || undefined, dias },
        };
    },
});

export default { SCREEN };
