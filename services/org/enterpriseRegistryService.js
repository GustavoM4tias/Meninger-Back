// services/org/enterpriseRegistryService.js
//
// Consolida o registro unificado de empresas (companies) e empreendimentos
// (enterprises) a partir das fontes já sincronizadas:
//   - enterprise_cities (sync CV + sync de centros de custo Sienge)
//   - cv_enterprises    (cadastro rico do CV: cidade/UF/empresa CV)
//   - contracts         (empresas Sienge vistas nos contratos)
//
// Regras:
//   - SEM override manual: name/city/uf são sempre os efetivos das fontes.
//     (Na primeira consolidação, city aproveita um city_override legado como
//     semente APENAS quando a fonte não trouxe cidade — depois disso a fonte manda.)
//   - Linhas cv_only e erp_only que se descobrem o MESMO empreendimento são
//     fundidas; os grants da linha absorvida migram para a sobrevivente.
//   - Idempotente: pode rodar a cada sync e no boot.

import db from '../../models/sequelize/index.js';

const { sequelize, Sequelize } = db;
const Q = { type: Sequelize.QueryTypes.SELECT };

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanStr(v, max = 255) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

// ── Empresas (Sienge) ────────────────────────────────────────────────────────
async function consolidateCompanies() {
  const fromCostCenters = await sequelize.query(
    `SELECT (raw_payload->>'idCompany')::int AS id,
            MAX(raw_payload->>'companyName')  AS name,
            MAX(last_seen_at)                 AS seen
       FROM enterprise_cities
      WHERE source = 'erp'
        AND raw_payload->>'idCompany' ~ '^[0-9]+$'
      GROUP BY 1`, Q
  );

  const fromContracts = await sequelize.query(
    `SELECT company_id AS id, MAX(company_name) AS name, MAX(updated_at) AS seen
       FROM contracts
      WHERE company_id IS NOT NULL
      GROUP BY 1`, Q
  );

  const byId = new Map();
  for (const r of [...fromCostCenters, ...fromContracts]) {
    const id = toInt(r.id);
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (r.name && !prev.name)) {
      byId.set(id, { id, name: cleanStr(r.name) || prev?.name || `Empresa ${id}`, seen: r.seen || prev?.seen || null });
    }
  }

  for (const c of byId.values()) {
    await db.OrgCompany.upsert({ id: c.id, name: c.name, last_seen_at: c.seen });
  }
  return byId.size;
}

// ── Empreendimentos ──────────────────────────────────────────────────────────
// Monta a lista canônica a partir do enterprise_cities (dedupe CRM×ERP) e
// enriquece com cv_enterprises.
async function buildCandidates() {
  const ecRows = await sequelize.query(
    `SELECT id, source, crm_id,
            NULLIF(regexp_replace(COALESCE(erp_id, ''), '[^0-9]', '', 'g'), '')::bigint AS erp_num,
            enterprise_name, default_city, city_override, raw_payload,
            first_seen_at, last_seen_at
       FROM enterprise_cities`, Q
  );

  const cvRows = await sequelize.query(
    `SELECT idempreendimento, nome, cidade, estado, sigla
       FROM cv_enterprises`, Q
  );
  const cvById = new Map(cvRows.map(r => [Number(r.idempreendimento), r]));

  // 1) Linhas CRM são a base (podem já trazer o erp_id casado pelo CV).
  const candidates = [];
  const erpTaken = new Set();
  for (const r of ecRows.filter(x => x.source === 'crm')) {
    const cvId = toInt(r.crm_id);
    if (!cvId) continue;
    const erpId = toInt(r.erp_num);
    if (erpId) erpTaken.add(erpId);
    const cv = cvById.get(cvId);
    candidates.push({
      cv_id: cvId,
      erp_cost_center_id: erpId,
      name: cleanStr(cv?.nome) || cleanStr(r.enterprise_name),
      city: cleanStr(cv?.cidade, 120) || cleanStr(r.default_city, 120) || cleanStr(r.city_override, 120),
      uf: cleanStr(cv?.estado, 2),
      company_id: null, // preenchido pela linha ERP casada (abaixo) quando houver
      cv_payload: r.raw_payload || null,
      erp_payload: null,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
    });
  }

  // 2) Linhas ERP: casadas → enriquecem o candidato CRM; órfãs → erp_only.
  const byErp = new Map(candidates.filter(c => c.erp_cost_center_id).map(c => [c.erp_cost_center_id, c]));
  for (const r of ecRows.filter(x => x.source === 'erp')) {
    const erpId = toInt(r.erp_num);
    if (!erpId) continue;
    const companyId = toInt(r.raw_payload?.idCompany);
    const paired = byErp.get(erpId);
    if (paired) {
      paired.company_id = companyId ?? paired.company_id;
      paired.erp_payload = r.raw_payload || null;
      paired.city = paired.city || cleanStr(r.default_city, 120) || cleanStr(r.city_override, 120);
      continue;
    }
    if (erpTaken.has(erpId)) continue; // já coberto por linha CRM sem duplicar
    candidates.push({
      cv_id: null,
      erp_cost_center_id: erpId,
      name: cleanStr(r.enterprise_name),
      city: cleanStr(r.default_city, 120) || cleanStr(r.city_override, 120),
      uf: null,
      company_id: companyId,
      cv_payload: null,
      erp_payload: r.raw_payload || null,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
    });
  }

  return candidates;
}

// Move grants da linha absorvida para a sobrevivente e apaga a absorvida.
async function mergeEnterpriseRows(surviveId, absorbId, t) {
  await sequelize.query(
    `UPDATE enterprise_grants g
        SET enterprise_id = :survive
      WHERE enterprise_id = :absorb
        AND NOT EXISTS (
          SELECT 1 FROM enterprise_grants g2
           WHERE g2.subject_type = g.subject_type
             AND g2.subject_id = g.subject_id
             AND g2.enterprise_id = :survive)`,
    { replacements: { survive: surviveId, absorb: absorbId }, transaction: t }
  );
  await sequelize.query(
    `DELETE FROM enterprise_grants WHERE enterprise_id = :absorb`,
    { replacements: { absorb: absorbId }, transaction: t }
  );
  await sequelize.query(
    `DELETE FROM enterprises WHERE id = :absorb`,
    { replacements: { absorb: absorbId }, transaction: t }
  );
}

async function upsertEnterprise(cand) {
  return sequelize.transaction(async (t) => {
    const byCv = cand.cv_id
      ? await db.OrgEnterprise.findOne({ where: { cv_id: cand.cv_id }, transaction: t })
      : null;
    const byErp = cand.erp_cost_center_id
      ? await db.OrgEnterprise.findOne({ where: { erp_cost_center_id: cand.erp_cost_center_id }, transaction: t })
      : null;

    // Duas linhas distintas que agora se sabem o mesmo empreendimento → funde.
    let row = byCv || byErp;
    if (byCv && byErp && byCv.id !== byErp.id) {
      await mergeEnterpriseRows(byCv.id, byErp.id, t);
      row = byCv;
    }

    const pairStatus = cand.cv_id && cand.erp_cost_center_id
      ? 'paired' : (cand.cv_id ? 'cv_only' : 'erp_only');

    const values = {
      cv_id: cand.cv_id,
      erp_cost_center_id: cand.erp_cost_center_id,
      company_id: cand.company_id ?? row?.company_id ?? null,
      name: cand.name ?? row?.name ?? null,
      city: cand.city ?? row?.city ?? null,
      uf: cand.uf ?? row?.uf ?? null,
      pair_status: pairStatus,
      cv_payload: cand.cv_payload ?? row?.cv_payload ?? null,
      erp_payload: cand.erp_payload ?? row?.erp_payload ?? null,
      first_seen_at: row?.first_seen_at ?? cand.first_seen_at ?? new Date(),
      last_seen_at: cand.last_seen_at ?? new Date(),
      active: row ? row.active : true, // inativação manual sobrevive à consolidação
    };

    if (row) {
      await row.update(values, { transaction: t });
      return { created: false };
    }
    await db.OrgEnterprise.create(values, { transaction: t });
    return { created: true };
  });
}

export async function consolidateRegistry({ log = console.log } = {}) {
  const companies = await consolidateCompanies();
  const candidates = await buildCandidates();
  let created = 0;
  for (const cand of candidates) {
    const r = await upsertEnterprise(cand);
    if (r.created) created++;
  }
  log(`[orgRegistry] consolidado: ${companies} empresa(s), ${candidates.length} empreendimento(s) (${created} novos).`);
  return { companies, enterprises: candidates.length, created };
}

// ── Pareamento manual (tela Sincronização de empresas) ───────────────────────
// Funde uma linha erp_only (ou cv_only) em outra, declarando que são o mesmo
// empreendimento. surviveId mantém grants de ambos.
export async function pairEnterprises({ surviveId, absorbId }) {
  return sequelize.transaction(async (t) => {
    const survive = await db.OrgEnterprise.findByPk(surviveId, { transaction: t });
    const absorb = await db.OrgEnterprise.findByPk(absorbId, { transaction: t });
    if (!survive || !absorb) throw new Error('Empreendimento não encontrado.');
    if (survive.cv_id && absorb.cv_id) throw new Error('Ambos já têm cadastro CV — não é um par CV×Sienge.');
    if (survive.erp_cost_center_id && absorb.erp_cost_center_id) {
      throw new Error('Ambos já têm centro de custo Sienge — não é um par CV×Sienge.');
    }

    const merged = {
      cv_id: survive.cv_id ?? absorb.cv_id,
      erp_cost_center_id: survive.erp_cost_center_id ?? absorb.erp_cost_center_id,
      company_id: survive.company_id ?? absorb.company_id,
      name: survive.name ?? absorb.name,
      city: survive.city ?? absorb.city,
      uf: survive.uf ?? absorb.uf,
      cv_payload: survive.cv_payload ?? absorb.cv_payload,
      erp_payload: survive.erp_payload ?? absorb.erp_payload,
      pair_status: 'paired',
    };

    await mergeEnterpriseRows(survive.id, absorb.id, t);
    await survive.update(merged, { transaction: t });
    return survive;
  });
}

export async function listRegistry({ q = '', status = '', companyId = null, page = 1, pageSize = 50 } = {}) {
  const where = {};
  if (status) where.pair_status = status;
  if (companyId) where.company_id = Number(companyId);
  if (q) {
    where[Sequelize.Op.or] = [
      { name: { [Sequelize.Op.iLike]: `%${q}%` } },
      { city: { [Sequelize.Op.iLike]: `%${q}%` } },
    ];
  }
  const { rows, count } = await db.OrgEnterprise.findAndCountAll({
    where,
    include: [{ model: db.OrgCompany, as: 'company', attributes: ['id', 'name'] }],
    order: [['name', 'ASC']],
    limit: Math.min(Number(pageSize) || 50, 3000),
    offset: (Math.max(Number(page) || 1, 1) - 1) * (Number(pageSize) || 50),
  });
  return { items: rows, total: count };
}

export default { consolidateRegistry, pairEnterprises, listRegistry };
