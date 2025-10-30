// src/lib/cityResolver.js
import db from '../models/sequelize/index.js'
import { Op, Sequelize } from 'sequelize'
import { normalizeCityName, normalizeEnterpriseName } from './textNormalize.js'

export async function getCityByCrmId(crmId) {
    const row = await db.EnterpriseCity.findOne({
        where: { source: 'crm', crm_id: Number(crmId) },
        order: [['updated_at', 'DESC']]
    })
    return row ? (row.city_override || row.default_city || null) : null
}

export async function getCityByErpId(erpId) {
    const row = await db.EnterpriseCity.findOne({
        where: { source: 'erp', erp_id: String(erpId) },
        order: [['updated_at', 'DESC']]
    })
    return row ? (row.city_override || row.default_city || null) : null
}

export async function getCitiesByErpIds(erpIds = []) {
    const ids = [...new Set((erpIds || []).map(String).filter(Boolean))]
    if (!ids.length) return new Map()
    const rows = await db.EnterpriseCity.findAll({
        where: { source: 'erp', erp_id: { [Op.in]: ids } },
        order: [['updated_at', 'DESC']]
    })
    const out = new Map()
    for (const r of rows) if (!out.has(r.erp_id)) out.set(r.erp_id, r.city_override || r.default_city || null)
    for (const id of ids) if (!out.has(id)) out.set(id, null)
    return out
}

// útil para casos legados (ex.: logs externos sem id)
export async function getCitiesByEnterpriseNamesCRM(names = []) {
    const norm = (s) => normalizeEnterpriseName(s)
    const map = new Map()
    const items = [...new Set((names || []).map(String).filter(Boolean))]

    if (!items.length) return map

    // carrega todos CRM e indexa por nome normalizado
    const rows = await db.EnterpriseCity.findAll({ where: { source: 'crm' }, attributes: ['enterprise_name', 'city_override', 'default_city', 'updated_at'] })
    const idx = new Map()
    for (const r of rows) {
        const key = norm(r.enterprise_name || '')
        const val = r.city_override || r.default_city || null
        if (!key) continue
        if (!idx.has(key)) idx.set(key, val) // pega o mais recente se quiser, mas aqui basta o primeiro
    }

    for (const raw of items) {
        const k = norm(raw)
        map.set(raw, idx.get(k) || null)
    }
    return map
}

export { normalizeCityName }
