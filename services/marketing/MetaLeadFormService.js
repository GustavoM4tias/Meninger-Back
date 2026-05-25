// services/marketing/MetaLeadFormService.js
//
// Sincroniza os Lead Forms da Meta pro cache local. Fluxo:
//   1. GET /me/accounts → todas as Páginas que o System User vê
//   2. Pra cada Página, GET /{page-id}/leadgen_forms → forms ativos/arquivados
//   3. Upsert no banco — preserva o mapping local (empreendimentos, midia) se
//      já tiver sido configurado pelo admin.
//
// O sync é manual (botão "Sincronizar" na UI) — não roda sozinho. Em vista do
// volume baixo de forms novos (alguns por semana), não compensa rodar cron.

import axios from 'axios';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';

const { MetaLeadForm } = db;

async function getCreds() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg.meta_access_token;
    const version = cfg.meta_graph_api_version || 'v21.0';
    if (!token) throw new Error('Token de acesso do Meta não configurado.');
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

/**
 * Lista as Páginas acessíveis pelo System User junto com o Page Access Token
 * de cada uma. /leadgen_forms exige Page Access Token (não funciona com User
 * token — devolve erro #190 "must be called with a Page Access Token").
 */
async function listPages({ token, base }) {
    const r = await axios.get(`${base}/me/accounts`, {
        params: { access_token: token, fields: 'id,name,access_token', limit: 100 },
        timeout: 20000,
    });
    return Array.isArray(r.data?.data) ? r.data.data : [];
}

/**
 * Lista os lead forms de uma Página. Inclui forms arquivados/desativados.
 * Usa o Page Access Token específico (page.access_token vindo do /me/accounts).
 */
async function listFormsForPage(base, pageId, pageAccessToken) {
    if (!pageAccessToken) {
        throw new Error('Sem Page Access Token — confirme que o System User tem permissão pages_show_list + pages_read_engagement + leads_retrieval nessa Página.');
    }
    const all = [];
    let url = `${base}/${pageId}/leadgen_forms`;
    let params = {
        access_token: pageAccessToken,
        fields: 'id,name,status,locale,created_time,questions{key,label,type}',
        limit: 100,
    };
    // Paginação cursor-based da Graph API.
    for (let i = 0; i < 10; i++) { // safety: até 10 páginas (1000 forms)
        const r = await axios.get(url, { params, timeout: 20000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...data);
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next;
        params = {}; // o next URL já tem todos os params encoded
    }
    return all;
}

/**
 * Sincroniza forms da Meta. Retorna { pages, forms_total, forms_new, forms_updated }.
 * Preserva mapping local (bound_empreendimentos, midia_slug, cv_origem, mapping_active).
 */
export async function syncFromMeta() {
    const creds = await getCreds();
    const pages = await listPages(creds);

    let formsTotal = 0;
    let formsNew = 0;
    let formsUpdated = 0;
    const errors = [];

    for (const page of pages) {
        let formList;
        try {
            // /leadgen_forms exige Page Access Token (não User/System User token).
            // O page.access_token vem do /me/accounts quando o System User tem
            // permissão pages_show_list + acesso atribuído à Página.
            formList = await listFormsForPage(creds.base, page.id, page.access_token);
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            errors.push({ page_id: page.id, page_name: page.name, error: detail });
            continue;
        }

        for (const f of formList) {
            formsTotal += 1;
            const existing = await MetaLeadForm.findByPk(String(f.id));
            const payload = {
                id:           String(f.id),
                page_id:      String(page.id),
                page_name:    page.name || null,
                name:         f.name || null,
                status:       f.status || null,
                locale:       f.locale || null,
                created_time: f.created_time ? new Date(f.created_time) : null,
                questions:    Array.isArray(f.questions) ? f.questions : (f.questions?.data || null),
                last_synced_at: new Date(),
            };

            if (!existing) {
                await MetaLeadForm.create({
                    ...payload,
                    mapping_active: true, // default — mas sem binding ainda
                });
                formsNew += 1;
            } else {
                // Atualiza só metadata vinda da Meta — preserva mapping local.
                existing.page_id        = payload.page_id;
                existing.page_name      = payload.page_name;
                existing.name           = payload.name;
                existing.status         = payload.status;
                existing.locale         = payload.locale;
                existing.created_time   = payload.created_time;
                existing.questions      = payload.questions;
                existing.last_synced_at = payload.last_synced_at;
                await existing.save();
                formsUpdated += 1;
            }
        }
    }

    return {
        pages_count: pages.length,
        forms_total: formsTotal,
        forms_new: formsNew,
        forms_updated: formsUpdated,
        errors,
    };
}

/** Lista todos os forms cacheados (com mapping). Ordenado por status + nome. */
export async function getAll() {
    const rows = await MetaLeadForm.findAll({
        order: [['status', 'ASC'], ['name', 'ASC']],
    });
    return rows.map(r => r.get({ plain: true }));
}

/** Busca um form por id (= meta_form_id). */
export async function findById(metaFormId) {
    const row = await MetaLeadForm.findByPk(String(metaFormId));
    return row ? row.get({ plain: true }) : null;
}

/**
 * Atualiza o mapping local de um form. Aceita:
 *   - bound_empreendimentos: [int]
 *   - midia_slug: string
 *   - cv_origem: 'FB' | 'IG'
 *   - tags: [string]
 *   - mapping_active: boolean
 */
export async function updateMapping(metaFormId, patch = {}) {
    const row = await MetaLeadForm.findByPk(String(metaFormId));
    if (!row) throw new Error('Formulário Meta não encontrado.');

    const fields = ['bound_empreendimentos', 'midia_slug', 'cv_origem', 'tags', 'mapping_active'];
    for (const k of fields) {
        if (patch[k] !== undefined) row[k] = patch[k];
    }
    await row.save();
    return row.get({ plain: true });
}

export default { syncFromMeta, getAll, findById, updateMapping };
