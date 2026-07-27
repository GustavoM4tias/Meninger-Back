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
    cv_stage_name: r.cv_stage_name,
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

        const {
            cv_enterprise_id, cv_enterprise_name, cv_stage_name,
            erp_enterprise_id, erp_enterprise_name, description
        } = req.body;

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
        const cvStage = (cv_stage_name || '').trim() || null;
        if (cvId == null && !cvName) {
            return res.status(400).json({ error: 'Informe o id ou o nome do empreendimento no CV.' });
        }

        // Reativa/atualiza o vínculo existente da mesma origem em vez de criar
        // um segundo, que reintroduziria a ambiguidade. A origem inclui a etapa:
        // o mesmo empreendimento pode ter um vínculo por fase.
        const where = cvId != null
            ? { cv_enterprise_id: cvId, cv_stage_name: cvStage }
            : { cv_enterprise_name: cvName, cv_stage_name: cvStage };
        const existing = await EnterpriseErpLink.findOne({ where });

        if (existing) {
            existing.active = true;
            existing.cv_enterprise_id = cvId;
            existing.cv_enterprise_name = cvName;
            existing.cv_stage_name = cvStage;
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
            cv_stage_name: cvStage,
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
 * Raio-X do vínculo: para CADA origem do CV que está gerando projeção
 * (empreendimento + fase), mostra qual centro de custo do Sienge ela resolve e
 * por qual caminho. É o "de onde saiu esse número" da tela.
 *
 * A cascata é a mesma da query de projeção, na mesma ordem:
 *   manual         → vínculo criado à mão nesta tela
 *   projecao       → cadastro da projeção ativa, por nome exato
 *   projecao_fase  → cadastro da projeção ativa, por nome + nº da fase
 *   cadastro_cv    → enterprise_cities (a ponte automática do CV)
 *   (nenhum)       → não resolve: cai como linha solta no dashboard
 *
 * `alerta` sinaliza o caso traiçoeiro: resolveu pelo cadastro_cv num
 * empreendimento que tem VÁRIAS fases em aberto. Como enterprise_cities não
 * conhece fase, todas as fases vão para o mesmo centro de custo — o número
 * aparece, mas no módulo errado.
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
WITH origem AS (
  SELECT
    COALESCE(NULLIF(trim(both from (r.unidade_json->>'empreendimento')), ''),
             NULLIF(trim(both from r.empreendimento), ''))            AS cv_enterprise_name,
    COALESCE(NULLIF(trim(both from (r.unidade_json->>'etapa')), ''),
             NULLIF(trim(both from r.etapa), ''))                     AS cv_stage_name,
    NULLIF((r.unidade_json->>'idempreendimento_int'), '')::int        AS cv_int_id,
    NULLIF((r.unidade_json->>'idempreendimento_cv'), '')::int         AS cv_id,
    COUNT(*)::int                                                     AS reservas,
    MAX(r.data_reserva)                                               AS ultima_reserva
  FROM reservas r
  WHERE (r.situacao->>'idsituacao')::int IN (:ids)
  GROUP BY 1,2,3,4
),

resolvido AS (
  SELECT
    o.*,
    (SELECT l.erp_enterprise_id FROM enterprise_erp_links l
      WHERE l.active = true
        AND (l.cv_enterprise_id = o.cv_id
             OR l.cv_enterprise_id = o.cv_int_id
             OR (l.cv_enterprise_name IS NOT NULL AND o.cv_enterprise_name IS NOT NULL
                 AND menin_base_name(l.cv_enterprise_name) = menin_base_name(o.cv_enterprise_name)))
        AND (l.cv_stage_name IS NULL
             OR menin_base_name(l.cv_stage_name) = menin_base_name(o.cv_stage_name))
      ORDER BY (l.cv_stage_name IS NOT NULL) DESC LIMIT 1) AS erp_manual,

    (SELECT NULLIF(spe.erp_id,'')::int FROM sales_projection_enterprises spe
       JOIN sales_projections sp ON sp.id = spe.projection_id AND sp.is_active = true
      WHERE spe.erp_id IS NOT NULL
        AND menin_base_name(spe.enterprise_name_cache) = menin_base_name(o.cv_enterprise_name)
        AND menin_stage_num(spe.enterprise_name_cache) IS NULL
      LIMIT 1) AS erp_projecao,

    (SELECT NULLIF(spe.erp_id,'')::int FROM sales_projection_enterprises spe
       JOIN sales_projections sp ON sp.id = spe.projection_id AND sp.is_active = true
      WHERE spe.erp_id IS NOT NULL
        AND menin_stage_num(o.cv_stage_name) IS NOT NULL
        AND menin_base_name(spe.enterprise_name_cache) = menin_base_name(o.cv_enterprise_name)
        AND menin_stage_num(spe.enterprise_name_cache) = menin_stage_num(o.cv_stage_name)
      LIMIT 1) AS erp_projecao_fase,

    (SELECT NULLIF(ec.erp_id,'')::int FROM enterprise_cities ec
      WHERE (o.cv_int_id IS NOT NULL AND ec.erp_id = o.cv_int_id::text)
         OR (o.cv_int_id IS NOT NULL AND ec.crm_id = o.cv_int_id AND ec.erp_id IS NOT NULL)
         OR (o.cv_id     IS NOT NULL AND ec.crm_id = o.cv_id     AND ec.erp_id IS NOT NULL)
      ORDER BY (ec.erp_id = o.cv_int_id::text) DESC, ec.updated_at DESC
      LIMIT 1) AS erp_cadastro_cv,

    (SELECT COUNT(DISTINCT o2.cv_stage_name) FROM origem o2
      WHERE o2.cv_enterprise_name = o.cv_enterprise_name
        AND o2.cv_stage_name IS NOT NULL)::int AS fases_no_empreendimento
  FROM origem o
)

SELECT
  cv_enterprise_name,
  cv_stage_name,
  cv_id            AS cv_enterprise_id,
  cv_int_id        AS cv_enterprise_int_id,
  reservas,
  ultima_reserva,
  fases_no_empreendimento,
  COALESCE(erp_manual, erp_projecao, erp_projecao_fase, erp_cadastro_cv) AS erp_enterprise_id,
  CASE
    WHEN erp_manual        IS NOT NULL THEN 'manual'
    WHEN erp_projecao      IS NOT NULL THEN 'projecao'
    WHEN erp_projecao_fase IS NOT NULL THEN 'projecao_fase'
    WHEN erp_cadastro_cv   IS NOT NULL THEN 'cadastro_cv'
    ELSE NULL
  END AS via,
  (SELECT c.enterprise_name FROM contracts c
    WHERE c.enterprise_id = COALESCE(erp_manual, erp_projecao, erp_projecao_fase, erp_cadastro_cv)
    LIMIT 1) AS erp_enterprise_name,
  /* Resolveu pelo cadastro do CV num empreendimento com várias fases: todas as
     fases apontam para o mesmo centro de custo, então há grande chance de estar
     no módulo errado. */
  (erp_manual IS NULL AND erp_projecao IS NULL AND erp_projecao_fase IS NULL
   AND erp_cadastro_cv IS NOT NULL
   AND (SELECT COUNT(DISTINCT o2.cv_stage_name) FROM origem o2
         WHERE o2.cv_enterprise_name = resolvido.cv_enterprise_name
           AND o2.cv_stage_name IS NOT NULL) > 1) AS alerta_fase_generica
FROM resolvido
WHERE cv_enterprise_name IS NOT NULL
ORDER BY
  (COALESCE(erp_manual, erp_projecao, erp_projecao_fase, erp_cadastro_cv) IS NULL) DESC,
  reservas DESC,
  cv_enterprise_name, cv_stage_name;
`;

        const rows = await db.sequelize.query(sql, {
            replacements: { ids: situacoes },
            type: db.Sequelize.QueryTypes.SELECT,
        });

        return res.json({ count: rows.length, results: rows });
    } catch (err) {
        console.error('[listUnlinkedProjections]', err);
        return res.status(500).json({ error: 'Erro ao diagnosticar vínculos.' });
    }
}
