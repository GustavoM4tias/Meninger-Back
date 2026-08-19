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

import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import { fetchEnterprises } from './emeAtendeSiteSource.js';

/**
 * Sincroniza os fluxos que têm site_slug.
 * @param {{ flowId?: number }} opts flowId sincroniza só aquele fluxo
 * @returns {Promise<{ synced: number, missing: string[], total: number, error?: string }>}
 */
async function syncFlows({ flowId = null } = {}) {
    const where = { site_slug: { [db.Sequelize.Op.ne]: null } };
    if (flowId) where.id = flowId;

    const flows = await db.EmeAtendeFlow.findAll({ where });
    if (!flows.length) return { synced: 0, missing: [], total: 0 };

    const cfg = await EmeAtendeSettingsService.getConfig();

    let all;
    try {
        all = await fetchEnterprises(cfg.site_url);
    } catch (err) {
        // Falha de rede/formato NÃO apaga o snapshot: registra o erro em cada
        // fluxo e deixa o conteúdo anterior valendo.
        const msg = err?.message || String(err);
        await Promise.all(flows.map(f => f.update({ site_sync_error: msg }).catch(() => null)));
        console.warn(`[eme-atende/site-sync] falhou (snapshot anterior mantido): ${msg}`);
        return { synced: 0, missing: [], total: flows.length, error: msg };
    }

    const bySlug = new Map(all.map(e => [e.slug, e]));
    const missing = [];
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
        await flow.update({ site_snapshot: snap, site_synced_at: new Date(), site_sync_error: null });
        synced++;
    }

    if (missing.length) {
        console.warn(`[eme-atende/site-sync] slugs ausentes no site: ${missing.join(', ')}`);
    }
    console.log(`[eme-atende/site-sync] ${synced}/${flows.length} fluxo(s) atualizado(s) do site.`);
    return { synced, missing, total: flows.length };
}

export default { syncFlows };
