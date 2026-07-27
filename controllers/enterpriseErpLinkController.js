// controllers/enterpriseErpLinkController.js
//
// Central de vínculo CV ↔ Sienge das projeções.
//
// Leitura liberada a autenticados (o vínculo afeta o número de todo mundo);
// escrita restrita a admin, igual às demais configurações do dashboard.

import db from '../models/sequelize/index.js';

const { EnterpriseErpLink } = db;

const serialize = (r) => ({
    id: r.id,
    cv_enterprise_id: r.cv_enterprise_id,
    cv_enterprise_name: r.cv_enterprise_name,
    erp_enterprise_id: r.erp_enterprise_id,
    erp_enterprise_name: r.erp_enterprise_name,
    description: r.description,
    created_by: r.created_by,
});

export async function listErpLinks(req, res) {
    try {
        const rows = await EnterpriseErpLink.findAll({
            where: { active: true },
            order: [['cv_enterprise_name', 'ASC'], ['cv_enterprise_id', 'ASC']],
        });
        return res.json({ count: rows.length, results: rows.map(serialize) });
    } catch (err) {
        console.error('[listErpLinks]', err);
        return res.status(500).json({ error: 'Erro ao listar vínculos.' });
    }
}

export async function addErpLink(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const { cv_enterprise_id, cv_enterprise_name, erp_enterprise_id, erp_enterprise_name, description } = req.body;

        const erpId = Number(erp_enterprise_id);
        if (!Number.isInteger(erpId) || erpId <= 0) {
            return res.status(400).json({ error: 'erp_enterprise_id inválido.' });
        }

        const cvId = cv_enterprise_id != null && String(cv_enterprise_id).trim() !== ''
            ? Number(cv_enterprise_id)
            : null;
        if (cvId != null && (!Number.isInteger(cvId) || cvId <= 0)) {
            return res.status(400).json({ error: 'cv_enterprise_id inválido.' });
        }

        const cvName = (cv_enterprise_name || '').trim() || null;
        if (cvId == null && !cvName) {
            return res.status(400).json({ error: 'Informe o id ou o nome do empreendimento no CV.' });
        }

        // Reativa/atualiza o vínculo existente da mesma origem em vez de criar
        // um segundo, que reintroduziria a ambiguidade.
        const where = cvId != null ? { cv_enterprise_id: cvId } : { cv_enterprise_name: cvName };
        const existing = await EnterpriseErpLink.findOne({ where });

        if (existing) {
            existing.active = true;
            existing.cv_enterprise_id = cvId;
            existing.cv_enterprise_name = cvName;
            existing.erp_enterprise_id = erpId;
            existing.erp_enterprise_name = erp_enterprise_name || existing.erp_enterprise_name;
            if (description !== undefined) existing.description = description || null;
            existing.created_by = req.user?.username || req.user?.email || existing.created_by;
            await existing.save();
            return res.status(200).json(serialize(existing));
        }

        const row = await EnterpriseErpLink.create({
            cv_enterprise_id: cvId,
            cv_enterprise_name: cvName,
            erp_enterprise_id: erpId,
            erp_enterprise_name: erp_enterprise_name || null,
            description: description || null,
            created_by: req.user?.username || req.user?.email || null,
            active: true,
        });

        return res.status(201).json(serialize(row));
    } catch (err) {
        console.error('[addErpLink]', err);
        return res.status(500).json({ error: 'Erro ao salvar vínculo.' });
    }
}

export async function removeErpLink(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await EnterpriseErpLink.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Vínculo não encontrado.' });

        row.active = false;
        await row.save();

        return res.json({ success: true });
    } catch (err) {
        console.error('[removeErpLink]', err);
        return res.status(500).json({ error: 'Erro ao remover vínculo.' });
    }
}

/**
 * GET /api/admin/enterprise-erp-links/pendentes
 *
 * Diagnóstico: empreendimentos que aparecem nas projeções dos grupos de
 * workflow ativos e NÃO conseguem resolver o id do Sienge. São exatamente os
 * que caem como linha solta no dashboard.
 *
 * Para cada um devolve o motivo, para o usuário saber o que corrigir:
 *   sem_id_cv    → a reserva não traz idempreendimento_int nem idempreendimento_cv
 *   sem_ponte    → tem id do CV, mas enterprise_cities não tem erp_id para ele
 *                  (é o caso de `idempreendimento_int` vazio no cadastro do CV)
 */
export async function listUnlinkedProjections(req, res) {
    try {
        const groups = await db.CvWorkflowGroup.findAll({ where: { ativo: true } });
        const situacoes = [...new Set(
            groups.flatMap(g => (Array.isArray(g.situacoes_ids) ? g.situacoes_ids : []))
                .filter(Number.isInteger)
        )];

        if (!situacoes.length) return res.json({ count: 0, results: [] });

        const sql = `
WITH base AS (
  SELECT
    NULLIF((r.unidade_json->>'idempreendimento_int'), '')::int AS idemp_int,
    NULLIF((r.unidade_json->>'idempreendimento_cv'), '')::int  AS idemp_cv,
    COALESCE(
      NULLIF(trim(both from (r.unidade_json->>'empreendimento')), ''),
      NULLIF(trim(both from r.empreendimento), '')
    ) AS nome,
    r.idreserva,
    r.data_reserva
  FROM reservas r
  WHERE (r.situacao->>'idsituacao')::int IN (:ids)
),

resolvido AS (
  SELECT
    b.*,
    /* mesma cascata da query de projeção, resumida */
    (SELECT NULLIF(ec.erp_id, '')::int
       FROM enterprise_cities ec
      WHERE (b.idemp_int IS NOT NULL AND ec.erp_id = b.idemp_int::text)
         OR (b.idemp_int IS NOT NULL AND ec.crm_id = b.idemp_int)
         OR (b.idemp_cv  IS NOT NULL AND ec.crm_id = b.idemp_cv)
      ORDER BY (ec.erp_id IS NOT NULL) DESC, ec.updated_at DESC
      LIMIT 1) AS erp_auto,
    (SELECT l.erp_enterprise_id
       FROM enterprise_erp_links l
      WHERE l.active = true
        AND (
          l.cv_enterprise_id = b.idemp_cv
          OR l.cv_enterprise_id = b.idemp_int
          OR (l.cv_enterprise_name IS NOT NULL AND b.nome IS NOT NULL
              AND unaccent(upper(regexp_replace(l.cv_enterprise_name, '[^A-Za-z0-9]+',' ','g'))) =
                  unaccent(upper(regexp_replace(b.nome,               '[^A-Za-z0-9]+',' ','g'))))
        )
      LIMIT 1) AS erp_link,
    /* Ponte pelo cadastro da projeção ativa — mesma regra da query de projeção */
    (SELECT NULLIF(spe.erp_id, '')::int
       FROM sales_projection_enterprises spe
       JOIN sales_projections sp ON sp.id = spe.projection_id AND sp.is_active = true
      WHERE spe.erp_id IS NOT NULL
        AND spe.enterprise_name_cache IS NOT NULL
        AND b.nome IS NOT NULL
        AND unaccent(upper(regexp_replace(spe.enterprise_name_cache, '[^A-Za-z0-9]+',' ','g'))) =
            unaccent(upper(regexp_replace(b.nome,                    '[^A-Za-z0-9]+',' ','g')))
      LIMIT 1) AS erp_projecao
  FROM base b
)

SELECT
  nome                              AS cv_enterprise_name,
  MAX(idemp_cv)                     AS cv_enterprise_id,
  MAX(idemp_int)                    AS cv_enterprise_int_id,
  COUNT(*)::int                     AS reservas,
  MAX(data_reserva)                 AS ultima_reserva,
  CASE
    WHEN MAX(COALESCE(idemp_int, idemp_cv)) IS NULL THEN 'sem_id_cv'
    ELSE 'sem_ponte'
  END                               AS motivo
FROM resolvido
WHERE erp_auto IS NULL
  AND erp_link IS NULL
  AND erp_projecao IS NULL
  AND nome IS NOT NULL
GROUP BY nome
ORDER BY COUNT(*) DESC, nome;
`;

        const rows = await db.sequelize.query(sql, {
            replacements: { ids: situacoes },
            type: db.Sequelize.QueryTypes.SELECT,
        });

        return res.json({ count: rows.length, results: rows });
    } catch (err) {
        console.error('[listUnlinkedProjections]', err);
        return res.status(500).json({ error: 'Erro ao diagnosticar vínculos pendentes.' });
    }
}
