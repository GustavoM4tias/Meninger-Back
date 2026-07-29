// services/permissions/accessScopeService.js
//
// Fonte ÚNICA do escopo de DADOS de um usuário: quais empreendimentos ele
// enxerga. O acesso é EXCLUSIVAMENTE por grants de empreendimento
// (enterprise_grants: usuário + perfil vivo) sobre o registro unificado
// (tabela enterprises). O antigo modo por cidade foi REMOVIDO em 2026-07-29 —
// não existe fallback: sem grant, sem dado.
//
// Regras:
//   - admin → all:true (vê tudo)
//   - REGRA DE OURO: funcionalidade nova NUNCA filtra por cidade/empresa na
//     mão — sempre por este serviço. O validador de integridade cobra isso.
//   - args vindos de IA/front são hints; a fonte da verdade é req.user aqui.

import db from '../../models/sequelize/index.js';

const { sequelize, Sequelize } = db;
const Q = { type: Sequelize.QueryTypes.SELECT };

// ── Escopo bruto ─────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{all:boolean, enterpriseIds:number[], cvIds:number[],
 *                    erpIds:number[], companyIds:number[], cities:string[]}>}
 */
export async function getScope(user) {
  if (!user) return { all: false, enterpriseIds: [], cvIds: [], erpIds: [], companyIds: [], cities: [] };
  if (user.role === 'admin') return { all: true, enterpriseIds: [], cvIds: [], erpIds: [], companyIds: [], cities: [] };

  const rows = await sequelize.query(
    `SELECT e.id, e.cv_id, e.erp_cost_center_id, e.company_id, e.city
       FROM enterprise_grants g
       JOIN enterprises e ON e.id = g.enterprise_id AND e.active = true
      WHERE (g.subject_type = 'user' AND g.subject_id = :userId)
         OR (g.subject_type = 'profile' AND g.subject_id = (
              SELECT permission_profile_id FROM users WHERE id = :userId))`,
    { replacements: { userId: user.id }, ...Q }
  );
  const enterpriseIds = [...new Set(rows.map(r => Number(r.id)))];
  const cvIds = [...new Set(rows.map(r => Number(r.cv_id)).filter(n => Number.isFinite(n) && n > 0))];
  const erpIds = [...new Set(rows.map(r => Number(r.erp_cost_center_id)).filter(n => Number.isFinite(n) && n > 0))];
  const companyIds = [...new Set(rows.map(r => Number(r.company_id)).filter(n => Number.isFinite(n) && n > 0))];
  const cities = [...new Set(rows.map(r => String(r.city || '').trim()).filter(Boolean))];
  return { all: false, enterpriseIds, cvIds, erpIds, companyIds, cities };
}

// ── Helpers para os consumidores ─────────────────────────────────────────────

/** ids de empreendimento CV visíveis. null = todos (admin). [] = nenhum. */
export async function visibleCvIds(user) {
  const s = await getScope(user);
  return s.all ? null : s.cvIds;
}

/** ids de centro de custo Sienge visíveis. null = todos (admin). [] = nenhum. */
export async function visibleErpIds(user) {
  const s = await getScope(user);
  return s.all ? null : s.erpIds;
}

/**
 * Um centro de custo específico é visível? Considera a heurística de sub-CC
 * (80104 pertence ao empreendimento do CC base 80001), a mesma usada no Custos.
 */
export function isErpAllowed(scope, costCenterId) {
  if (!scope || scope.all) return true;
  const cc = Number(costCenterId);
  if (!Number.isFinite(cc)) return false;
  const set = new Set(scope.erpIds);
  if (set.has(cc)) return true;
  const base = Math.floor(cc / 100) * 100 + 1;
  return base !== cc && set.has(base);
}

/**
 * Cidades "visíveis" (para consumidores que só sabem filtrar por cidade, ex.
 * eventos por endereço): as cidades dos empreendimentos liberados.
 * null = todas (admin).
 */
export async function visibleCities(user) {
  const s = await getScope(user);
  return s.all ? null : s.cities;
}

export default { getScope, visibleCvIds, visibleErpIds, visibleCities, isErpAllowed };
