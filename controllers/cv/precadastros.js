// Endpoints de leitura (do banco) para pré-cadastros já sincronizados.
import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { getScope, isErpAllowed } from '../../services/permissions/accessScopeService.js';
// Empreendimento é o id do CV (`cv_precadastros.idempreendimento`); o nome no
// JSON é o rótulo da época. Filtro por id, rótulo pelo nome ATUAL do catálogo.
import { cvIdsDeFiltro, mapaNomeAtual, facetasEmpreendimento } from '../../services/org/enterpriseNames.js';

const { CvPrecadastro, CvEnterprise, CvCorrespondent } = db;

/**
 * Troca `empreendimento.nome` pelo nome atual (pelo `idempreendimento`) e expõe
 * `idempreendimento_cv` no topo da linha, que é a chave que o front usa. O
 * nome gravado fica em `empreendimento.nome_gravado` para auditoria.
 */
async function aplicarNomeAtualPrecadastros(rows) {
    if (!rows?.length) return rows;
    const mapa = await mapaNomeAtual(rows.map(r => r.idempreendimento));
    for (const r of rows) {
        const id = Number(r.idempreendimento);
        r.idempreendimento_cv = Number.isFinite(id) && id > 0 ? id : null;
        const atual = mapa.get(id);
        if (!atual) continue;
        if (r.empreendimento && typeof r.empreendimento === 'object') {
            if (r.empreendimento.nome !== atual) {
                if (r.empreendimento.nome_gravado === undefined) r.empreendimento.nome_gravado = r.empreendimento.nome ?? null;
                r.empreendimento.nome = atual;
            }
        } else {
            r.empreendimento = { nome: atual };
        }
    }
    return rows;
}

/**
 * Recorte de escopo (accessScopeService) em SQL sobre `cv_precadastros p`:
 * null para admin, `FALSE` para escopo vazio (fail-closed).
 */
function montarEscopoSql(scope, replacements) {
    if (scope.all) return null;
    const scopeCvIds  = scope.cvIds  || [];
    const scopeErpIds = scope.erpIds || [];
    if (!scopeCvIds.length && !scopeErpIds.length) return 'FALSE';
    const scopeParts = [];
    if (scopeCvIds.length) {
        scopeParts.push(`p.idempreendimento IN (:scopeCvIds)`);
        replacements.scopeCvIds = scopeCvIds;
    }
    if (scopeErpIds.length) {
        scopeParts.push(`NULLIF(regexp_replace(COALESCE(p.empreendimento->>'idempreendimento_int',''), '[^0-9]', '', 'g'), '')::bigint IN (:scopeErpIds)`);
        replacements.scopeErpIds = scopeErpIds;
    }
    return `(${scopeParts.join(' OR ')})`;
}

/**
 * GET /api/cv/precadastros/facets
 * Empreendimentos presentes nos pré-cadastros dentro do escopo do usuário:
 * uma entrada por id, com o nome ATUAL, ordenadas por id.
 */
export const listPrecadastrosFacets = async (req, res) => {
    try {
        const replacements = {};
        const escopo = montarEscopoSql(await getScope(req.user), replacements);
        const rows = escopo === 'FALSE' ? [] : await db.sequelize.query(`
            SELECT p.idempreendimento AS idempreendimento_cv,
                   NULLIF(trim(p.empreendimento->>'nome'), '') AS empreendimento
              FROM cv_precadastros p
             WHERE ${escopo || 'TRUE'}
             GROUP BY 1, 2
        `, { replacements, type: db.Sequelize.QueryTypes.SELECT });
        return res.json({ empreendimentos: await facetasEmpreendimento(rows) });
    } catch (e) {
        console.error('Erro listPrecadastrosFacets:', e);
        return res.status(500).json({ error: 'Erro ao listar empreendimentos dos pré-cadastros' });
    }
};

const toIntOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
};

// helper: ILIKE com CSV (igual leads.js)
function addIlikeCsv(whereClauses, replacements, paramName, column, rawVal) {
    if (!rawVal) return;
    const termos = String(rawVal).split(',').map(s => s.trim()).filter(Boolean);
    if (!termos.length) return;
    if (termos.length === 1) {
        whereClauses.push(`${column} ILIKE :${paramName}`);
        replacements[paramName] = `%${termos[0]}%`;
    } else {
        const parts = termos.map((_, i) => `${column} ILIKE :${paramName}_${i}`);
        whereClauses.push(`(${parts.join(' OR ')})`);
        termos.forEach((t, i) => (replacements[`${paramName}_${i}`] = `%${t}%`));
    }
}

/**
 * GET /api/cv/precadastros
 * Retorna lista filtrada para o dashboard (segue mesmo padrão de getLeads).
 * Filtros suportados via query: empreendimento, situacao_nome, imobiliaria,
 * corretor, correspondente, empresa_correspondente, intencao_compra,
 * documento, nome, data_inicio, data_fim, only_active, with_lead.
 */
export const listPrecadastros = async (req, res) => {
    try {
        const {
            empreendimento, situacao_nome, imobiliaria, corretor,
            correspondente, empresa_correspondente, intencao_compra,
            documento, nome, only_active, with_lead,
            excluir_painel, lead_origem,   // ← novos
            data_inicio, data_fim,
        } = req.query;

        const hoje = dayjs();
        const start = data_inicio ? dayjs(data_inicio) : hoje.startOf('month');
        const end = data_fim ? dayjs(data_fim) : hoje;
        if (end.isBefore(start)) {
            return res.status(400).json({ error: 'Data final não pode ser menor que a inicial.' });
        }

        const whereClauses = [`p.data_cad BETWEEN :start AND :end`];
        const replacements = {
            start: start.format('YYYY-MM-DD 00:00:00'),
            end:   end.format('YYYY-MM-DD 23:59:59'),
        };

        if (documento) {
            whereClauses.push(`p.documento ILIKE :documento`);
            replacements.documento = `%${documento}%`;
        }
        if (nome) {
            whereClauses.push(`p.nome_cliente ILIKE :nome`);
            replacements.nome = `%${nome}%`;
        }

        addIlikeCsv(whereClauses, replacements, 'situacao_nome', 'p.situacao_nome', situacao_nome);
        addIlikeCsv(whereClauses, replacements, 'intencao_compra', 'p.intencao_compra', intencao_compra);
        // Empreendimento por id do CV. O filtro chega como CSV de ids (padrão
        // novo) ou de nomes (link antigo); nome vira id pelo resolver e só o
        // termo que não resolveu cai no ILIKE sobre o nome gravado.
        if (empreendimento) {
            const { ids, nomes_sem_id } = await cvIdsDeFiltro(empreendimento);
            const parts = [];
            if (ids.length) {
                parts.push(`p.idempreendimento IN (:empIds)`);
                replacements.empIds = ids;
            }
            if (nomes_sem_id.length) {
                addIlikeCsv(parts, replacements, 'empreendimento', `p.empreendimento->>'nome'`, nomes_sem_id.join(','));
            }
            whereClauses.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
        }
        addIlikeCsv(whereClauses, replacements, 'imobiliaria',
            `p.imobiliaria->>'nome'`, imobiliaria);
        addIlikeCsv(whereClauses, replacements, 'corretor',
            `p.corretor->>'nome'`, corretor);
        addIlikeCsv(whereClauses, replacements, 'correspondente',
            `p.correspondente->>'nome'`, correspondente);
        addIlikeCsv(whereClauses, replacements, 'empresa_correspondente',
            `p.empresa_correspondente->>'nome'`, empresa_correspondente);

        if (String(only_active) === 'true') {
            whereClauses.push(`p.data_fim IS NULL AND p.data_cancelamento IS NULL`);
        }
        if (String(with_lead) === 'true') {
            whereClauses.push(`jsonb_array_length(COALESCE(p.leads_associados, '[]'::jsonb)) > 0`);
        }

        // Excluir Painel: precad deve ter ao menos 1 lead com origem que NÃO começa com "Painel"
        // (mesmo conceito do `excluir_painel=1` do relatório de Leads — diferencia interno vs externo)
        if (String(excluir_painel) === 'true') {
            whereClauses.push(`
                EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la
                    JOIN leads l ON l.idlead = NULLIF(la->>'idlead','')::int
                    WHERE l.origem IS NOT NULL AND l.origem NOT ILIKE 'Painel%'
                )
            `);
        }

        // Filtro multi por origem do lead (ex: ?lead_origem=Site,Facebook)
        if (lead_origem) {
            const termos = String(lead_origem).split(',').map(s => s.trim()).filter(Boolean);
            if (termos.length) {
                const orParts = termos.map((_, i) => `l2.origem ILIKE :lead_orig_${i}`);
                whereClauses.push(`
                    EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la2
                        JOIN leads l2 ON l2.idlead = NULLIF(la2->>'idlead','')::int
                        WHERE ${orParts.join(' OR ')}
                    )
                `);
                termos.forEach((t, i) => { replacements[`lead_orig_${i}`] = `%${t}%`; });
            }
        }

        // (filtro de empresa-construtora removido — agora "Empresa" no front mapeia
        //  para empresa_correspondente, que já é tratado em addIlikeCsv acima)

        // ── Filtro por escopo de acesso do usuário (accessScopeService) ──────
        // Admin vê tudo; user vê apenas pré-cadastros cujo empreendimento está
        // no seu escopo (id CV, com fallback pelo id ERP do empreendimento).
        const escopoSql = montarEscopoSql(await getScope(req.user), replacements);
        if (escopoSql === 'FALSE') {
            // fail-closed: escopo vazio → resultado vazio
            return res.json({
                count: 0,
                periodo: { data_inicio: replacements.start, data_fim: replacements.end },
                took_ms: 0,
                results: [],
            });
        }
        if (escopoSql) whereClauses.push(escopoSql);

        const sql = `
          SELECT
            p.idprecadastro,
            p.codigointerno,
            p.documento,
            p.nome_cliente,
            p.email_cliente,
            p.idempreendimento, p.idunidade, p.idimobiliaria, p.idcorretor,
            p.idcorrespondente, p.idempresa_correspondente,
            p.idsituacao, p.situacao_nome,
            p.valor_avaliacao, p.valor_aprovado, p.valor_subsidio, p.valor_fgts,
            p.valor_total, p.valor_prestacao, p.saldo_devedor,
            p.renda_cliente_principal, p.renda_total,
            p.intencao_compra, p.idintencao_compra,
            p.tabela, p.carta_credito, p.prazo, p.prazo_financiamento, p.vencimento_aprovacao,
            p.data_cad, p.data_fim, p.data_cancelamento, p.link,
            p.empreendimento, p.unidade, p.imobiliaria, p.corretor,
            p.correspondente, p.empresa_correspondente, p.situacao,
            p.cliente, p.usuario_aprovou, p.leads_associados, p.fator_social,
            p.associados, p.campos_adicionais, p.mensagem_resumo,
            -- métricas calculadas no SQL
            EXTRACT(EPOCH FROM (COALESCE(p.data_fim, p.data_cancelamento, NOW()) - p.data_cad))/86400 AS dias_em_analise,
            CASE
              WHEN p.data_fim IS NOT NULL AND p.data_cancelamento IS NULL THEN 'finalizado'
              WHEN p.data_cancelamento IS NOT NULL THEN 'cancelado'
              ELSE 'em_analise'
            END AS estado_geral,
            jsonb_array_length(COALESCE(p.leads_associados, '[]'::jsonb)) AS qtd_leads_associados,
            -- Array de origens dos leads associados (para classificar interno/externo no front)
            COALESCE((
                SELECT ARRAY_AGG(DISTINCT l3.origem)
                FROM jsonb_array_elements(COALESCE(p.leads_associados, '[]'::jsonb)) AS la3
                LEFT JOIN leads l3 ON l3.idlead = NULLIF(la3->>'idlead','')::int
                WHERE l3.origem IS NOT NULL
            ), ARRAY[]::text[]) AS lead_origens
          FROM cv_precadastros p
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY p.data_cad DESC
        `;

        const t0 = Date.now();
        const rows = await db.sequelize.query(sql, {
            replacements,
            type: db.Sequelize.QueryTypes.SELECT,
        });
        const took = Date.now() - t0;
        // `empreendimento.nome` de hoje, pelo id; o gravado fica em `nome_gravado`.
        await aplicarNomeAtualPrecadastros(rows);

        return res.json({
            count: rows.length,
            periodo: { data_inicio: replacements.start, data_fim: replacements.end },
            took_ms: took,
            results: rows,
        });
    } catch (e) {
        console.error('Erro listPrecadastros:', e);
        return res.status(500).json({ error: 'Erro ao listar pré-cadastros' });
    }
};

export const getPrecadastro = async (req, res) => {
    try {
        const id = toIntOrNull(req.params.id);
        if (!id) return res.status(400).json({ error: 'idprecadastro inválido' });

        const row = await CvPrecadastro.findByPk(id);
        if (!row) return res.status(404).json({ error: 'Pré-cadastro não encontrado' });

        // ── Visibilidade: não-admin só pode ver se o empreendimento da pasta
        //    está no seu escopo (mesma regra do listing). Fail-closed.
        const scope = await getScope(req.user);
        if (!scope.all) {
            const cvOk = row.idempreendimento != null
                && (scope.cvIds || []).includes(Number(row.idempreendimento));
            const erpRaw = String(row.empreendimento?.idempreendimento_int ?? '').replace(/[^0-9]/g, '');
            const erpOk = erpRaw !== '' && isErpAllowed(scope, Number(erpRaw));
            if (!cvOk && !erpOk) {
                return res.status(403).json({ error: 'Pré-cadastro fora do seu escopo.' });
            }
        }

        const [json] = await aplicarNomeAtualPrecadastros([row.toJSON()]);
        return res.json(json);
    } catch (e) {
        console.error('Erro getPrecadastro:', e);
        return res.status(500).json({ error: 'Erro ao buscar pré-cadastro' });
    }
};
