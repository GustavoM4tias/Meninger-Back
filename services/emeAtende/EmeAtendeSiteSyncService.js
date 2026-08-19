// services/emeAtende/EmeAtendeSiteSyncService.js
//
// Traz o conteúdo do site institucional para dentro dos fluxos, uma vez por dia.
//
// Por que snapshot e não leitura ao vivo: a conversa lê `flow.site_snapshot`, um
// JSON já normalizado. Site fora do ar, lento ou com o formato mexido não deixa
// o lead sem resposta - ele continua sendo atendido com o conteúdo de ontem, e a
// tela mostra que o sync falhou. Ler ao vivo colocaria a rede no caminho crítico
// de cada rodada de IA.
//
// O site inteiro vem numa requisição só (window.__SITE__ traz todas as coleções),
// então sincronizar 1 ou 20 fluxos custa o mesmo download.
//
// Cada rodada vira uma linha em eme_atende_site_syncs COM O DIFF: o conteúdo que
// a Eme fala muda sozinho de madrugada, então "por que ela começou a dizer isso"
// precisa ter resposta sem investigação.

import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import { fetchEnterprises, resolveSiteUrl } from './emeAtendeSiteSource.js';

// Campos comparados entre o snapshot velho e o novo. Só o que a IA lê ou envia -
// mudar `logo` ou `selo` não altera uma conversa e não merece virar registro.
const CAMPOS_OBSERVADOS = [
    'nome', 'cidade', 'status', 'perfil', 'descricao', 'sobre',
    'area', 'quartos', 'vagas', 'terreno', 'obra', 'endereco', 'book',
];
const LISTAS_OBSERVADAS = ['diferenciais', 'comodidades', 'pontos', 'images'];

/** O que mudou entre dois snapshots, em nome de campo. */
function diffSnapshots(antes, depois) {
    if (!antes) return { first: true, fields: [], images: null };
    const fields = CAMPOS_OBSERVADOS.filter(k => String(antes[k] ?? '') !== String(depois[k] ?? ''));
    for (const k of LISTAS_OBSERVADAS) {
        const a = JSON.stringify(antes[k] || []);
        const b = JSON.stringify(depois[k] || []);
        if (a !== b) fields.push(k);
    }
    const imgAntes = (antes.images || []).length;
    const imgDepois = (depois.images || []).length;
    return {
        first: false,
        fields,
        images: imgAntes !== imgDepois ? [imgAntes, imgDepois] : null,
    };
}

/**
 * Sincroniza os fluxos que têm site_slug.
 * @param {{ flowId?: number, trigger?: string }} opts
 * @returns {Promise<{ synced, missing, total, changes, error? }>}
 */
async function syncFlows({ flowId = null, trigger = 'scheduler' } = {}) {
    const iniciou = Date.now();
    const where = { site_slug: { [db.Sequelize.Op.ne]: null } };
    if (flowId) where.id = flowId;

    const flows = await db.EmeAtendeFlow.findAll({ where });
    const cfg = await EmeAtendeSettingsService.getConfig();
    const siteUrl = resolveSiteUrl(cfg.site_url);

    // Sem fluxo vinculado não faz requisição nenhuma - e não polui o histórico.
    if (!flows.length) return { synced: 0, missing: [], total: 0, changes: [] };

    const registrar = (dados) => db.EmeAtendeSiteSync.create({
        trigger, site_url: siteUrl, duration_ms: Date.now() - iniciou, ...dados,
    }).catch(err => console.warn('[eme-atende/site-sync] histórico não gravado:', err?.message));

    let all;
    try {
        all = await fetchEnterprises(cfg.site_url);
    } catch (err) {
        // Falha de rede/formato NÃO apaga o snapshot: registra o erro em cada
        // fluxo e deixa o conteúdo anterior valendo.
        const msg = err?.message || String(err);
        await Promise.all(flows.map(f => f.update({ site_sync_error: msg }).catch(() => null)));
        await registrar({ ok: false, total_flows: flows.length, synced: 0, error: msg });
        console.warn(`[eme-atende/site-sync] falhou (snapshot anterior mantido): ${msg}`);
        return { synced: 0, missing: [], total: flows.length, changes: [], error: msg };
    }

    const bySlug = new Map(all.map(e => [e.slug, e]));
    const missing = [];
    const changes = [];
    let synced = 0;

    for (const flow of flows) {
        const snap = bySlug.get(flow.site_slug);
        if (!snap) {
            // Empreendimento saiu do site (vendido, renomeado, slug trocado).
            // Mantém o snapshot: sumir com o contexto no meio do atendimento é
            // pior do que servir um conteúdo de ontem.
            missing.push(flow.site_slug);
            await flow.update({ site_sync_error: `slug "${flow.site_slug}" não existe mais no site` });
            continue;
        }

        const diff = diffSnapshots(flow.site_snapshot, snap);
        if (diff.first || diff.fields.length) {
            changes.push({
                flow_id: flow.id, name: flow.name, slug: flow.site_slug,
                first: diff.first, fields: diff.fields, images: diff.images,
            });
        }

        await flow.update({ site_snapshot: snap, site_synced_at: new Date(), site_sync_error: null });
        synced++;
    }

    if (missing.length) {
        console.warn(`[eme-atende/site-sync] slugs ausentes no site: ${missing.join(', ')}`);
    }
    console.log(`[eme-atende/site-sync] ${synced}/${flows.length} fluxo(s) atualizado(s); ${changes.length} com mudança.`);
    await registrar({ ok: true, total_flows: flows.length, synced, missing, changes });

    return { synced, missing, total: flows.length, changes };
}

/** Histórico das rodadas, mais recente primeiro. */
async function history({ limit = 30 } = {}) {
    return db.EmeAtendeSiteSync.findAll({
        order: [['id', 'DESC']],
        limit: Math.min(Number(limit) || 30, 100),
    });
}

export default { syncFlows, history };
