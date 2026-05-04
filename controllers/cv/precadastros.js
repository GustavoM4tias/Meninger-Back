// Endpoints de leitura (do banco) para pré-cadastros já sincronizados.
import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const { CvPrecadastro, CvEnterprise, CvCorrespondent } = db;

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
        addIlikeCsv(whereClauses, replacements, 'empreendimento',
            `p.empreendimento->>'nome'`, empreendimento);
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

        return res.json(row);
    } catch (e) {
        console.error('Erro getPrecadastro:', e);
        return res.status(500).json({ error: 'Erro ao buscar pré-cadastro' });
    }
};
