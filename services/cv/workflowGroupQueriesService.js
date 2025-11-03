// services/cv/workflowGroupQueriesService.js
import db from '../../models/sequelize/index.js';

export async function getGroupProjections({ idgroup }) {
    const group = await db.CvWorkflowGroup.findByPk(idgroup);
    if (!group) throw new Error('Grupo não encontrado');

    const tipo = group.tipo; // 'reservas' | 'repasses'
    const situacoes = Array.isArray(group.situacoes_ids) ? group.situacoes_ids.filter(Number.isInteger) : [];
    const segmentos = Array.isArray(group.segmentos) ? group.segmentos.filter(s => typeof s === 'string' && s.trim().length) : [];

    if (!situacoes.length) {
        return { count: 0, results: [], meta: { tipo, segmentos, situacoes } };
    }

    if (tipo === 'reservas') {
        // RESERVAS: join em enterprises via unidade_json->>'idempreendimento_int'
        const sql = `
      WITH base AS (
        SELECT r.*,
               (r.unidade_json->>'idempreendimento_int')::text AS idemp_int
        FROM reservas r
        WHERE (r.situacao->>'idsituacao')::int IN (:ids)
      )
      SELECT b.*, ce.segmento_nome
      FROM base b
      LEFT JOIN cv_enterprises ce
        ON ce.idempreendimento_int::text = b.idemp_int
      ${segmentos.length ? `WHERE ce.segmento_nome IN (:segments)` : ''}
      ORDER BY b.data_reserva DESC NULLS LAST, b.idreserva DESC
    `;

        const results = await db.sequelize.query(sql, {
            replacements: {
                ids: situacoes,
                segments: segmentos.length ? segmentos : undefined,
            },
            type: db.Sequelize.QueryTypes.SELECT,
        });

        return {
            count: results.length,
            results,
            meta: { tipo, segmentos, situacoes }
        };
    }

    // REPASSES: join em enterprises via codigointerno_empreendimento
    const sql = `
    SELECT r.*, ce.segmento_nome
    FROM repasses r
    LEFT JOIN cv_enterprises ce
      ON ce.idempreendimento_int::text = r.codigointerno_empreendimento::text
    WHERE r.idsituacao_repasse IN (:ids)
      ${segmentos.length ? `AND ce.segmento_nome IN (:segments)` : ''}
    ORDER BY r.data_status_repasse DESC NULLS LAST, r.idrepasse DESC
  `;

    const results = await db.sequelize.query(sql, {
        replacements: {
            ids: situacoes,
            segments: segmentos.length ? segmentos : undefined,
        },
        type: db.Sequelize.QueryTypes.SELECT,
    });

    return {
        count: results.length,
        results,
        meta: { tipo, segmentos, situacoes }
    };
}
