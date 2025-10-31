// src/services/cityMappingService.js
import db from '../models/sequelize/index.js';
import apiCv from '../lib/apiCv.js';
import apiSienge from '../lib/apiSienge.js';
import { Op } from 'sequelize';

const asDate = v => (v ? new Date(v) : new Date());

// ---------- infra de logs ----------
function makeLogger({ verbose = false } = {}) {
  const logs = [];
  const push = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };
  return {
    log: push,
    getLogs: () => logs
  };
}

// ----------------------- helpers de normalização -----------------------
function titleCasePt(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/(^|\s|[-/])(.)/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrai cidade de nomes do Sienge no formato "CIDADE/UF - ..."
 */
export function extractCityFromCostCenterName(name = '') {
  if (!name) return null;
  const clean = String(name).replace(/\s+/g, ' ').trim();
  const m = clean.match(/^\s*([A-Za-zÀ-ÖØ-öø-ÿ'\.\-\s]+)\/([A-Z]{2})\s*-/);
  if (!m) return null;
  const cidadeRaw = m[1].trim();
  if (!cidadeRaw) return null;
  const cidade = titleCasePt(cidadeRaw);
  return cidade;
}

// ----------------------- upsert genérico -----------------------
async function upsertEnterpriseCity({ source, crm_id, erp_id, enterprise_name, default_city, raw }) {
  const where = source === 'crm' ? { source, crm_id } : { source, erp_id };
  const payload = {
    source,
    crm_id: crm_id ?? null,
    erp_id: erp_id ?? null,
    enterprise_name: enterprise_name ?? null,
    default_city: default_city ?? null,
    raw_payload: raw ?? {},
    last_seen_at: asDate()
  };

  const [row, created] = await db.EnterpriseCity.findOrCreate({
    where,
    defaults: { ...payload, first_seen_at: asDate() }
  });

  if (!created) {
    row.enterprise_name = payload.enterprise_name ?? row.enterprise_name;
    row.default_city = payload.default_city ?? row.default_city;
    row.raw_payload = payload.raw_payload ?? row.raw_payload;
    row.last_seen_at = payload.last_seen_at;
    await row.save();
  }
  return row;
}

// ----------------------- CRM -----------------------
export async function syncFromCRM() {
  const resp = await apiCv.get('/v1/cadastros/empreendimentos');
  const list = Array.isArray(resp.data) ? resp.data : [];

  const results = [];
  for (const it of list) {
    const row = await upsertEnterpriseCity({
      source: 'crm',
      crm_id: it.idempreendimento,
      erp_id: it.idempreendimento_int ?? null,
      enterprise_name: it.nome,
      default_city: it.cidade,
      raw: it
    });
    results.push({ id: row.id, crm_id: row.crm_id, effective_city: row.effective_city });
  }
  return { count: results.length, items: results };
}

// ----------------------- ERP (Sienge) -----------------------
export async function syncFromSiengeCostCenters({
  limit = 200,
  maxCount,
  verbose = false
} = {}) {
  const t0 = Date.now();
  const logger = makeLogger({ verbose });
  const itemsOut = [];

  let offset = 0;
  let total = null;
  let page = 0;

  let seen = 0;
  let matched = 0;
  let upserts = 0;
  let skipped = 0;
  let errors = 0;
  let merged = 0;

  logger.log(`ERP SYNC ▶️ Iniciando varredura em /v1/cost-centers (limit=${limit}${maxCount ? `, maxCount=${maxCount}` : ''})`);

  do {
    page += 1;
    logger.log(`ERP SYNC ⏳ Página ${page} – offset=${offset}, limit=${limit}`);
    const { data } = await apiSienge.get('/v1/cost-centers', { params: { offset, limit } });
    const meta = data?.resultSetMetadata || {};
    const results = Array.isArray(data?.results) ? data.results : [];

    if (total == null) total = Number(meta.count) || results.length;
    logger.log(`ERP SYNC ✅ Página ${page} recebida: ${results.length} itens (total reportado=${total})`);

    for (const it of results) {
      if (maxCount && upserts >= maxCount) {
        logger.log(`ERP SYNC ⛔ maxCount atingido (${maxCount}). Encerrando processamento.`);
        break;
      }
      seen++;

      try {
        const erp_id = it.id;
        const name = String(it.name || '').trim();
        const cidade = extractCityFromCostCenterName(name);

        if (!cidade) { skipped++; continue; }
        matched++;

        const enterprise_name = name.replace(/\s+/g, ' ').trim();

        // MERGE preferindo CRM (quando existir mapeamento CRM desse ERP)
        const existingCrm = await db.EnterpriseCity.findOne({
          where: { source: 'crm', erp_id }
        });
        if (existingCrm) {
          existingCrm.enterprise_name = existingCrm.enterprise_name ?? enterprise_name;
          existingCrm.default_city = existingCrm.default_city ?? cidade;
          existingCrm.raw_payload = { ...existingCrm.raw_payload, sienge_cost_center: it };
          existingCrm.last_seen_at = new Date();
          await existingCrm.save();
          itemsOut.push({ id: existingCrm.id, crm_id: existingCrm.crm_id, erp_id, effective_city: existingCrm.effective_city });
          merged++;
          continue;
        }

        const row = await upsertEnterpriseCity({
          source: 'erp',
          erp_id: String(erp_id),
          crm_id: null,
          enterprise_name,
          default_city: cidade,
          raw: it
        });

        upserts++;
        if (upserts % 200 === 0) {
          logger.log(`ERP SYNC 💾 Upserts acumulados: ${upserts} (matched=${matched}, skipped=${skipped}, seen=${seen})`);
        }

        if (itemsOut.length < 50) {
          itemsOut.push({ id: row.id, erp_id: row.erp_id, effective_city: row.effective_city });
        }
      } catch (e) {
        errors++;
        logger.log(`ERP SYNC ❌ Erro ao processar item id=${it?.id} – ${e?.message || e}`);
      }
    }

    if (maxCount && upserts >= maxCount) break;
    offset += limit;
  } while (offset < total);

  const ms = Date.now() - t0;
  logger.log(`ERP SYNC 🏁 FIM: pages=${page}, seen=${seen}, matched=${matched}, upserts=${upserts}, skipped=${skipped}, errors=${errors}, tempo=${(ms / 1000).toFixed(1)}s`);

  return {
    ok: true,
    pages: page,
    totalReported: total,
    seen, matched, upserts, skipped, errors, merged,
    tookMs: ms,
    items: itemsOut,
    logs: verbose ? logger.getLogs() : undefined
  };
}

// ----------------------- resolver/listagem/override -----------------------
export async function resolveCity({ crm_id, erp_id }) {
  let rows = [];
  if (crm_id || erp_id) {
    const or = [];
    if (crm_id) or.push({ source: 'crm', crm_id });
    if (erp_id) or.push({ erp_id: String(erp_id) }); // pega CRM e ERP desse erp_id
    rows = await db.EnterpriseCity.findAll({
      where: { [Op.or]: or },
      order: [
        [db.Sequelize.literal(`CASE WHEN source='crm' THEN 0 ELSE 1 END`), 'ASC'],
        ['updated_at', 'DESC']
      ]
    });
  }

  const pick = rows.find(r => r.source === 'crm') || rows[0];
  if (!pick) return null;

  return pick.city_override || pick.default_city || null;
}

/**
 * Resolve em lote por ERP IDs.
 * Opções:
 *  - prefer: 'crm' | 'erp' (ordem de preferência quando existir dos dois)
 *  - sources: array de fontes a considerar (default ['crm','erp'])
 * Retorna Map<string, string|null> (key = erp_id string)
 */
export async function resolveCityBulkByErpIds(
  erpIds = [],
  { prefer = 'crm', sources = ['crm', 'erp'] } = {}
) {
  const ids = Array.from(
    new Set(
      (erpIds || [])
        .map(x => (x == null ? null : String(x)))
        .filter(Boolean)
    )
  );
  if (!ids.length) return new Map();

  const where = { erp_id: { [Op.in]: ids } };
  if (Array.isArray(sources) && sources.length) {
    where.source = { [Op.in]: sources };
  }

  const rows = await db.EnterpriseCity.findAll({
    where,
    order: [
      [db.Sequelize.literal(`CASE WHEN source='${prefer === 'erp' ? 'erp' : 'crm'}' THEN 0 ELSE 1 END`), 'ASC'],
      ['updated_at', 'DESC']
    ]
  });

  const out = new Map(); // erp_id -> city
  for (const r of rows) {
    const k = String(r.erp_id);
    if (out.has(k)) continue; // primeira ocorrência já é a "melhor"
    const city = r.city_override || r.default_city || null;
    out.set(k, city);
  }

  // garante existência de todas as chaves
  for (const id of ids) if (!out.has(id)) out.set(id, null);
  return out;
}

export async function listEnterpriseCities({ q, page = 1, pageSize = 50, source, hasOverride, includeRaw = false }) {
  const where = {};
  if (source) where.source = source;
  if (hasOverride === true) where.city_override = { [Op.ne]: null };
  if (hasOverride === false) where.city_override = null;
  if (q) {
    where[Op.or] = [
      { enterprise_name: { [Op.iLike]: `%${q}%` } },
      { default_city: { [Op.iLike]: `%${q}%` } },
      { city_override: { [Op.iLike]: `%${q}%` } },
      { crm_id: isNaN(Number(q)) ? -1 : Number(q) },
      { erp_id: q }
    ];
  }

  const offset = (page - 1) * pageSize;
  const { rows, count } = await db.EnterpriseCity.findAndCountAll({
    where,
    limit: pageSize,
    offset,
    order: [
      [db.Sequelize.literal(`CASE WHEN source='crm' THEN 0 ELSE 1 END`), 'ASC'],
      ['updated_at', 'DESC']
    ]
  });

  const seenCrmErp = new Set();
  const dedupedCrmSameErp = [];
  for (const r of rows) {
    if (r.source === 'crm' && r.erp_id) {
      const k = String(r.erp_id);
      if (seenCrmErp.has(k)) continue;
      seenCrmErp.add(k);
    }
    dedupedCrmSameErp.push(r);
  }

  return {
    page, pageSize, total: count,
    items: dedupedCrmSameErp.map(r => ({
      id: r.id,
      source: r.source,
      crm_id: r.crm_id,
      erp_id: r.erp_id,
      enterprise_name: r.enterprise_name,
      default_city: r.default_city,
      city_override: r.city_override,
      effective_city: r.city_override || r.default_city,
      ...(includeRaw ? { raw_payload: r.raw_payload } : {})
    }))
  };
}

export async function updateCityOverride({ id, city_override }) {
  const row = await db.EnterpriseCity.findByPk(id);
  if (!row) throw new Error('Registro não encontrado');
  row.city_override = city_override || null;
  await row.save();
  return {
    id: row.id,
    effective_city: row.city_override || row.default_city,
    city_override: row.city_override,
    default_city: row.default_city
  };
}
