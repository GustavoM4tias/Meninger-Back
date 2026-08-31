// controllers/orgRegistryController.js
//
// API da tela "Sincronização de empresas" (/settings/empresas — ex "Vínculos
// de cidades"). Todas as rotas são admin (ver routes/admin.js). Os syncs leem
// DIRETO das APIs CV/Sienge para o registro unificado (companies/enterprises);
// enterprise_cities foi aposentada. Além do manual, o orgRegistryScheduler
// roda o sync completo 1x por dia de madrugada.

import { syncFromCv, syncFromSienge, syncAll, pairEnterprises, listRegistry } from '../services/org/enterpriseRegistryService.js';
import db from '../models/sequelize/index.js';

export const listEnterprises = async (req, res) => {
  try {
    const { q, status, companyId, active, sortBy, sortDir, page, pageSize } = req.query;
    const data = await listRegistry({ q, status, companyId, active, sortBy, sortDir, page, pageSize });
    return res.json(data);
  } catch (e) {
    console.error('[orgRegistry] list:', e);
    return res.status(500).json({ error: e.message });
  }
};

export const listCompanies = async (_req, res) => {
  try {
    const rows = await db.OrgCompany.findAll({ order: [['name', 'ASC']] });
    return res.json(rows);
  } catch (e) {
    console.error('[orgRegistry] companies:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Sync CV → enterprises (direto da API)
export const syncCrm = async (_req, res) => {
  try {
    const sync = await syncFromCv();
    return res.json({ ok: true, sync, consolidated: { enterprises: sync.seen } });
  } catch (e) {
    console.error('[orgRegistry] syncCrm:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Sync centros de custo Sienge → companies + enterprises (direto da API)
export const syncErp = async (req, res) => {
  try {
    const { limit, maxCount } = req.query;
    const sync = await syncFromSienge({
      limit: Number(limit) || 200,
      maxCount: maxCount ? Number(maxCount) : undefined,
    });
    return res.json({ ok: true, sync, consolidated: { enterprises: sync.matched, companies: sync.companies } });
  } catch (e) {
    console.error('[orgRegistry] syncErp:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Sync completo (Sienge + CV), mesmo job do scheduler diário
export const consolidate = async (_req, res) => {
  try {
    const r = await syncAll();
    return res.json({
      ok: true,
      enterprises: (r.cv?.seen || 0),
      companies: (r.companies?.vistas || 0),
      vinculosCorrigidos: (r.erp?.vinculosCorrigidos || 0),
      detail: r,
    });
  } catch (e) {
    console.error('[orgRegistry] consolidate:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Pareamento manual CV×Sienge: funde absorbId dentro de surviveId
export const pair = async (req, res) => {
  try {
    const surviveId = Number(req.params.id);
    const absorbId = Number(req.body?.absorbId);
    if (!surviveId || !absorbId) return res.status(400).json({ error: 'id e absorbId são obrigatórios.' });
    const row = await pairEnterprises({ surviveId, absorbId });
    return res.json({ ok: true, enterprise: row });
  } catch (e) {
    console.error('[orgRegistry] pair:', e);
    return res.status(400).json({ error: e.message });
  }
};

// Ajustes manuais permitidos: empresa e ativo/inativo (NUNCA cidade/nome —
// esses são efetivos das fontes).
export const updateEnterprise = async (req, res) => {
  try {
    const row = await db.OrgEnterprise.findByPk(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Empreendimento não encontrado.' });
    const patch = {};
    if (req.body?.companyId !== undefined) patch.company_id = req.body.companyId ? Number(req.body.companyId) : null;
    if (req.body?.active !== undefined) patch.active = !!req.body.active;
    await row.update(patch);
    return res.json({ ok: true, enterprise: row });
  } catch (e) {
    console.error('[orgRegistry] update:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Mesmos ajustes do update individual, aplicados a VÁRIOS empreendimentos de
// uma vez (ações em lote da tela). Body: { ids: [], companyId?, active? }.
// companyId = null desvincula a empresa; ausente = não mexe no campo.
export const bulkUpdateEnterprises = async (req, res) => {
  try {
    const ids = [...new Set((req.body?.ids || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Informe ao menos um empreendimento.' });

    const patch = {};
    if (req.body?.companyId !== undefined) patch.company_id = req.body.companyId ? Number(req.body.companyId) : null;
    if (req.body?.active !== undefined) patch.active = !!req.body.active;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada a alterar.' });

    const [count] = await db.OrgEnterprise.update(patch, { where: { id: ids } });
    return res.json({ ok: true, updated: count });
  } catch (e) {
    console.error('[orgRegistry] bulkUpdate:', e);
    return res.status(500).json({ error: e.message });
  }
};

// ── Rótulos de empreendimento p/ telas de dados (NÃO-admin) ──────────────────
// GET /api/org/enterprise-labels — nome/cidade por CC e por CV id, LIMITADO ao
// escopo do usuário (admin vê todos). Substitui o antigo
// GET /api/admin/enterprise-cities consumido por Títulos/Custos.
export const listEnterpriseLabels = async (req, res) => {
  try {
    const { visibleErpIds } = await import('../services/permissions/accessScopeService.js');
    const allowed = await visibleErpIds(req.user); // null = admin
    const where = { active: true };
    if (allowed !== null) {
      if (!allowed.length) return res.json({ items: [] });
      where.erp_cost_center_id = allowed;
    }
    const rows = await db.OrgEnterprise.findAll({
      where,
      attributes: ['id', 'cv_id', 'erp_cost_center_id', 'name', 'city', 'uf'],
      order: [['name', 'ASC']],
      raw: true,
    });
    return res.json({
      items: rows.map(r => ({
        id: r.id,
        cv_id: r.cv_id,
        erp_id: r.erp_cost_center_id != null ? String(r.erp_cost_center_id) : null,
        name: r.name,
        city: r.city,
        uf: r.uf,
      })),
    });
  } catch (e) {
    console.error('[orgRegistry] labels:', e);
    return res.status(500).json({ error: e.message });
  }
};
