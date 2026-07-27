// services/workflowGroupsService.js (ou onde você mostrou)

import db from '../../models/sequelize/index.js';
import { getReservaWorkflow } from '../../controllers/cv/reservas.js';
import { getRepasseWorkflow } from './repasseWorkflowService.js';

const { CvWorkflowGroup } = db;

/** Mantém igual, só inclui segmentos no retorno */
export async function syncWorkflowGroups(tipo) {
    const workflow = tipo === 'repasses' ? await getRepasseWorkflow() : await getReservaWorkflow();

    const situacoesAtuais = workflow.situacoes;
    const idsAtuais = new Set(situacoesAtuais.map(s => s.idsituacao));
    const situacoesById = Object.fromEntries(situacoesAtuais.map(s => [s.idsituacao, s.nome]));

    const grupos = await CvWorkflowGroup.findAll({ where: { tipo } });

    for (const g of grupos) {
        const validos = (g.situacoes_ids || []).filter(id => idsAtuais.has(id));
        const nomes = validos.map(id => situacoesById[id]).filter(Boolean);

        await g.update({
            situacoes_ids: validos,
            descricao: `${nomes.join(', ')}`,
            updated_at_cv: new Date()
        });
    }

    return grupos.map(g => ({
        idgroup: g.idgroup,
        nome: g.nome,
        tipo: g.tipo,
        descricao: g.descricao,
        situacoes: (g.situacoes_ids || []).map(id => ({
            id,
            nome: situacoesById[id] || '(Removida do workflow)'
        })),
        // 👇 inclui segmentos no payload
        segmentos: Array.isArray(g.segmentos) ? g.segmentos : [],
        stale_days: g.stale_days ?? null
    }));
}

/** Upsert aceita segmentos e o corte por inatividade (stale_days) */
export async function upsertWorkflowGroup({ tipo, nome, descricao, situacoes_ids, segmentos, stale_days }) {
    const segs = Array.isArray(segmentos)
        ? segmentos
        : (typeof segmentos === 'string' && segmentos.trim() ? [segmentos.trim()] : []);

    // null/vazio mantém o default (30); 0 desliga o corte.
    const staleRaw = Number(stale_days);
    const stale = stale_days === null || stale_days === undefined || stale_days === ''
        ? undefined
        : (Number.isFinite(staleRaw) && staleRaw >= 0 ? Math.floor(staleRaw) : undefined);

    const [group, created] = await CvWorkflowGroup.findOrCreate({
        where: { tipo, nome },
        defaults: { descricao, situacoes_ids, segmentos: segs, ...(stale !== undefined ? { stale_days: stale } : {}) }
    });

    if (!created) {
        await group.update({
            descricao,
            situacoes_ids,
            segmentos: segs,
            ...(stale !== undefined ? { stale_days: stale } : {})
        });
    }

    return group;
}

export async function deleteWorkflowGroup(idgroup) {
    await CvWorkflowGroup.destroy({ where: { idgroup } });
}

/** Service puro: retorna lista de segmentos (array de string) */
export async function getDistinctSegments() {
  const rows = await db.sequelize.query(
    `
    SELECT DISTINCT segmento_nome
    FROM cv_enterprises
    WHERE segmento_nome IS NOT NULL AND TRIM(segmento_nome) <> ''
    ORDER BY segmento_nome;
    `,
    { type: db.Sequelize.QueryTypes.SELECT }
  );
  return rows.map(r => r.segmento_nome);
}