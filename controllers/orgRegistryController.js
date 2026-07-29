// controllers/orgRegistryController.js
//
// API da tela "Sincronização de empresas" (/settings/empresas — ex "Vínculos
// de cidades"). Todas as rotas são admin (ver routes/admin.js).

import { syncFromCRM, syncFromSiengeCostCenters } from '../services/cityMappingService.js';
import { consolidateRegistry, pairEnterprises, listRegistry } from '../services/org/enterpriseRegistryService.js';
import db from '../models/sequelize/index.js';

export const listEnterprises = async (req, res) => {
  try {
    const { q, status, companyId, page, pageSize } = req.query;
    const data = await listRegistry({ q, status, companyId, page, pageSize });
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

// Sync CV → enterprise_cities → consolidação
export const syncCrm = async (_req, res) => {
  try {
    const sync = await syncFromCRM();
    const cons = await consolidateRegistry();
    return res.json({ ok: true, sync, consolidated: cons });
  } catch (e) {
    console.error('[orgRegistry] syncCrm:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Sync centros de custo Sienge → enterprise_cities → consolidação
export const syncErp = async (req, res) => {
  try {
    const { limit, maxCount } = req.query;
    const sync = await syncFromSiengeCostCenters({ limit, maxCount });
    const cons = await consolidateRegistry();
    return res.json({ ok: true, sync, consolidated: cons });
  } catch (e) {
    console.error('[orgRegistry] syncErp:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Reconsolida sem re-sincronizar as fontes (barato; útil após ajustes)
export const consolidate = async (_req, res) => {
  try {
    const cons = await consolidateRegistry();
    return res.json({ ok: true, ...cons });
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
