// services/org/enterpriseRegistryService.js
//
// Registro unificado de empresas (companies) e empreendimentos (enterprises).
//
// FONTES (sync DIRETO das APIs — enterprise_cities foi aposentada):
//   - syncFromCv():     GET /v1/cadastros/empreendimentos (CV CRM)
//   - syncFromSienge(): GET /v1/cost-centers (Sienge ERP, paginado) — também
//                       alimenta companies (idCompany/companyName do payload)
//
// Regras:
//   - SEM override manual: name/city/uf são sempre os efetivos das fontes
//     (CV manda no nome/cidade quando o registro é pareado).
//   - Linhas cv_only e erp_only que se descobrem o MESMO empreendimento são
//     fundidas; os grants da linha absorvida migram para a sobrevivente.
//   - Idempotente: roda no scheduler diário, na tela e no boot.
//   - consolidateRegistry(): SEMENTE legada — importa da tabela
//     enterprise_cities SE ela ainda existir (primeiro boot pós-migração);
//     depois que a tabela for dropada vira no-op.

import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import apiSienge from '../../lib/apiSienge.js';

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

function titleCasePt(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/(^|\s|[-/])(.)/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai cidade e UF de nomes do Sienge no formato "CIDADE/UF - ..." */
export function parseCityFromCostCenterName(name = '') {
  if (!name) return { city: null, uf: null };
  const clean = String(name).replace(/\s+/g, ' ').trim();
  const m = clean.match(/^\s*([A-Za-zÀ-ÖØ-öø-ÿ'\.\-\s]+)\/([A-Z]{2})\s*-/);
  if (!m) return { city: null, uf: null };
  const cidadeRaw = m[1].trim();
  return {
    city: cidadeRaw ? titleCasePt(cidadeRaw) : null,
    uf: m[2] || null,
  };
}

// ── Merge/upsert de empreendimento ───────────────────────────────────────────

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

/**
 * Upsert de um candidato a empreendimento.
 * soft=true (sync ERP): valores do candidato só PREENCHEM lacunas — nunca
 * sobrescrevem nome/cidade vindos do CV (fonte preferida quando pareado).
 */
async function upsertEnterprise(cand, { soft = false } = {}) {
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

    const pick = (candVal, rowVal) => (soft ? (rowVal ?? candVal) : (candVal ?? rowVal ?? null));

    const cvId = cand.cv_id ?? row?.cv_id ?? null;
    const erpId = cand.erp_cost_center_id ?? row?.erp_cost_center_id ?? null;
    const values = {
      cv_id: cvId,
      erp_cost_center_id: erpId,
      company_id: cand.company_id ?? row?.company_id ?? null,
      name: pick(cand.name, row?.name),
      city: pick(cand.city, row?.city),
      uf: pick(cand.uf, row?.uf),
      pair_status: cvId && erpId ? 'paired' : (cvId ? 'cv_only' : 'erp_only'),
      cv_payload: cand.cv_payload ?? row?.cv_payload ?? null,
      erp_payload: cand.erp_payload ?? row?.erp_payload ?? null,
      first_seen_at: row?.first_seen_at ?? cand.first_seen_at ?? new Date(),
      last_seen_at: new Date(),
      active: row ? row.active : true, // inativação manual sobrevive ao sync
    };

    if (row) {
      await row.update(values, { transaction: t });
      return { created: false };
    }
    await db.OrgEnterprise.create(values, { transaction: t });
    return { created: true };
  });
}

// ── Sync das EMPRESAS (Sienge) ───────────────────────────────────────────────
//
// `/v1/cost-centers` NÃO traz o nome da empresa, só o `idCompany`. Por isso as
// empresas nasciam todas como "Empresa <id>" (121 de 121 assim em 2026-08-30) e
// o agrupamento por empresa da tela de Alçadas ficava ilegível: o admin escolhia
// entre "Empresa 104" e "Empresa 108" sem saber qual era qual. `/v1/companies`
// tem nome e CNPJ.
export async function syncCompaniesFromSienge({ limit = 200 } = {}) {
  let offset = 0;
  let total = null;
  let vistas = 0;
  let nomeados = 0;

  do {
    const { data } = await apiSienge.get('/v1/companies', { params: { offset, limit } });
    const results = Array.isArray(data?.results) ? data.results : [];
    if (total == null) total = Number(data?.resultSetMetadata?.count) || results.length;
    if (!results.length) break;

    for (const it of results) {
      const id = toInt(it.id);
      const name = cleanStr(it.name) || cleanStr(it.tradeName);
      if (!id || !name) continue;
      vistas++;

      const existente = await db.OrgCompany.findByPk(id);
      // Nome de verdade sempre ganha do provisório "Empresa <id>".
      if (!existente || existente.name !== name) nomeados++;
      await db.OrgCompany.upsert({
        id, name, cnpj: cleanStr(it.cnpj, 20), last_seen_at: new Date(),
      });
    }
    offset += limit;
  } while (offset < (total ?? 0));

  return { source: 'companies', total, vistas, nomeados };
}

// ── Sync CV (CRM) ────────────────────────────────────────────────────────────
export async function syncFromCv() {
  const resp = await apiCv.get('/v1/cadastros/empreendimentos');
  const list = Array.isArray(resp.data) ? resp.data : [];

  // `idempreendimento_int` deveria ser o CENTRO DE CUSTO do Sienge, mas parte do
  // cadastro traz a EMPRESA (ver corrigirVinculoEmpresaDoCv). Distingue pelo que
  // o Sienge JÁ PROVOU existir: o id que veio DENTRO do payload da API.
  // Ler a coluna `erp_cost_center_id` aqui não serviria — é justamente ela que
  // pode estar sobrescrita com o número da empresa, e o teste se autoconfirmaria.
  const ccReais = new Set((await sequelize.query(
    `SELECT DISTINCT NULLIF(erp_payload->>'id', '')::int AS id FROM enterprises
      WHERE erp_payload IS NOT NULL`, Q
  )).map(r => Number(r.id)).filter(n => Number.isFinite(n) && n > 0));
  const empresas = new Set((await sequelize.query(`SELECT id FROM companies`, Q)).map(r => Number(r.id)));

  let created = 0;
  let comoEmpresa = 0;
  for (const it of list) {
    const cvId = toInt(it.idempreendimento);
    if (!cvId) continue;

    const numeroInt = toInt(it.idempreendimento_int);
    const ehEmpresa = numeroInt != null && !ccReais.has(numeroInt) && empresas.has(numeroInt);
    if (ehEmpresa) comoEmpresa++;

    const r = await upsertEnterprise({
      cv_id: cvId,
      erp_cost_center_id: ehEmpresa ? null : numeroInt,
      // undefined preserva a empresa já gravada; só define quando é o caso.
      company_id: ehEmpresa ? numeroInt : undefined,
      name: cleanStr(it.nome),
      city: cleanStr(it.cidade, 120),
      uf: cleanStr(it.estado, 2),
      cv_payload: it,
    });
    if (r.created) created++;
  }
  return { source: 'cv', seen: list.length, created, comoEmpresa };
}

// ── Sync Sienge (ERP) ────────────────────────────────────────────────────────
export async function syncFromSienge({ limit = 200, maxCount } = {}) {
  let offset = 0;
  let total = null;
  let pages = 0;
  let seen = 0;
  let matched = 0;
  let created = 0;
  let skipped = 0;
  const companiesSeen = new Map();
  // TODOS os centros de custo devolvidos pela API, inclusive os que não viram
  // empreendimento (sem "CIDADE/UF - " no nome). É a lista autoritativa usada
  // depois para desmascarar vínculo falso — ver corrigirVinculoEmpresaDoCv().
  const ccIdsDoSienge = new Set();

  do {
    pages += 1;
    const { data } = await apiSienge.get('/v1/cost-centers', { params: { offset, limit } });
    const meta = data?.resultSetMetadata || {};
    const results = Array.isArray(data?.results) ? data.results : [];
    if (total == null) total = Number(meta.count) || results.length;

    for (const it of results) {
      if (maxCount && matched >= maxCount) break;
      seen++;

      const erpId = toInt(it.id);
      const name = cleanStr(String(it.name || '').replace(/\s+/g, ' '));
      const { city, uf } = parseCityFromCostCenterName(name || '');
      const companyId = toInt(it.idCompany);
      if (erpId) ccIdsDoSienge.add(erpId);

      // Sem cidade no padrão "CIDADE/UF - ..." = CC administrativo/genérico,
      // não é empreendimento → ignora (mesma regra do sync antigo).
      if (!erpId || !city) { skipped++; continue; }
      matched++;

      if (companyId && !companiesSeen.has(companyId)) {
        companiesSeen.set(companyId, cleanStr(it.companyName) || `Empresa ${companyId}`);
      }

      const r = await upsertEnterprise({
        cv_id: null,
        erp_cost_center_id: erpId,
        name,
        city: cleanStr(city, 120),
        uf: cleanStr(uf, 2),
        company_id: companyId,
        erp_payload: it,
      }, { soft: true });
      if (r.created) created++;
    }

    if (maxCount && matched >= maxCount) break;
    offset += limit;
  } while (offset < (total ?? 0));

  // Empresas vistas nos CCs + complemento dos contratos sincronizados
  for (const [id, name] of companiesSeen) {
    await db.OrgCompany.upsert({ id, name, last_seen_at: new Date() });
  }
  const fromContracts = await sequelize.query(
    `SELECT company_id AS id, MAX(company_name) AS name, MAX(updated_at) AS seen
       FROM contracts WHERE company_id IS NOT NULL GROUP BY 1`, Q
  );
  for (const c of fromContracts) {
    const id = toInt(c.id);
    if (!id || companiesSeen.has(id)) continue;
    const exists = await db.OrgCompany.findByPk(id);
    if (!exists) await db.OrgCompany.create({ id, name: cleanStr(c.name) || `Empresa ${id}`, last_seen_at: c.seen });
  }

  // Listagem completa? Só então dá para afirmar que um id NÃO é centro de custo.
  const listagemCompleta = !maxCount && total != null && ccIdsDoSienge.size >= total;
  const corrigidos = listagemCompleta ? await corrigirVinculoEmpresaDoCv(ccIdsDoSienge) : 0;

  return {
    source: 'sienge', pages, totalReported: total, seen, matched, created, skipped,
    companies: companiesSeen.size, vinculosCorrigidos: corrigidos, listagemCompleta,
  };
}

/**
 * O campo `idempreendimento_int` do CV deveria trazer o CENTRO DE CUSTO do
 * Sienge, mas em parte do cadastro veio a EMPRESA (medido em 2026-08-30: 10 de
 * 31 empreendimentos). Como o sync gravava esse número direto em
 * `erp_cost_center_id`, o empreendimento ficava "pareado" com um centro de custo
 * inexistente — e o centro de custo VERDADEIRO virava uma segunda linha. É a
 * origem do mesmo empreendimento aparecendo duas vezes na tela de Alçadas.
 *
 * A lista de centros de custo vinda da API manda. Dois desfechos:
 *
 *   1. O `erp_payload` da linha guarda o centro de custo real (o Sienge já
 *      passou por ela antes de o número ser sobrescrito): restaura o vínculo e,
 *      se o centro real tiver virado outra linha, FUNDE as duas. Os grants da
 *      linha absorvida migram — ninguém perde acesso.
 *   2. Não há centro de custo conhecido: o número vira `company_id` e o vínculo
 *      falso é apagado. O empreendimento passa a aparecer UMA vez, dentro da
 *      empresa dele, marcado como "só CV" até alguém parear de verdade.
 *
 * Idempotente: na segunda rodada não há o que corrigir.
 */
async function corrigirVinculoEmpresaDoCv(ccIdsDoSienge) {
  const suspeitos = await sequelize.query(
    `SELECT e.id, e.name, e.erp_cost_center_id,
            NULLIF(e.erp_payload->>'id', '')::int AS cc_do_payload
       FROM enterprises e
       JOIN companies c ON c.id = e.erp_cost_center_id
      WHERE e.erp_cost_center_id IS NOT NULL AND e.cv_id IS NOT NULL`, Q
  );

  let corrigidos = 0;
  for (const linha of suspeitos) {
    const numero = Number(linha.erp_cost_center_id);
    // É centro de custo de verdade? Então o vínculo está certo, não toca.
    if (ccIdsDoSienge.has(numero)) continue;

    const ccReal = Number(linha.cc_do_payload) || null;
    const temCcReal = ccReal != null && ccIdsDoSienge.has(ccReal);

    await sequelize.transaction(async (t) => {
      if (!temCcReal) {
        await sequelize.query(
          `UPDATE enterprises
              SET company_id = COALESCE(company_id, :numero),
                  erp_cost_center_id = NULL,
                  pair_status = 'cv_only',
                  updated_at = NOW()
            WHERE id = :id`,
          { replacements: { numero, id: linha.id }, transaction: t }
        );
        console.warn(`[orgRegistry] "${linha.name}": idempreendimento_int=${numero} é EMPRESA no Sienge, não centro de custo. `
          + 'Vínculo falso desfeito e empresa aplicada. Preencha o centro de custo no cadastro do CV para parear.');
        return;
      }

      // O centro de custo real pode ter virado uma segunda linha do mesmo
      // empreendimento — funde antes de reassumir o número (a coluna é única).
      const outraLinha = await db.OrgEnterprise.findOne({
        where: { erp_cost_center_id: ccReal }, transaction: t,
      });
      if (outraLinha && Number(outraLinha.id) !== Number(linha.id)) {
        await mergeEnterpriseRows(linha.id, outraLinha.id, t);
      }
      await sequelize.query(
        `UPDATE enterprises
            SET erp_cost_center_id = :ccReal,
                company_id = COALESCE(company_id, :numero),
                pair_status = 'paired',
                updated_at = NOW()
          WHERE id = :id`,
        { replacements: { ccReal, numero, id: linha.id }, transaction: t }
      );
      console.warn(`[orgRegistry] "${linha.name}": centro de custo restaurado para ${ccReal} `
        + `(estava com ${numero}, que é a EMPRESA)${outraLinha && Number(outraLinha.id) !== Number(linha.id) ? ' e a linha duplicada foi fundida' : ''}.`);
    });
    corrigidos++;
  }
  return corrigidos;
}

// ── Catálogo de cidades (user_cities) alimentado pelo registro ───────────────
// O cadastro manual de cidades foi aposentado (2026-07-29): toda cidade/UF
// vista nos empreendimentos sincronizados vira opção automaticamente (usada no
// formulário de primeiro acesso e nas audiências de Mural/Academy). Nunca
// remove nem sobrescreve cidades existentes — só completa o que falta.
export async function syncUserCitiesFromRegistry() {
  const rows = await sequelize.query(
    `SELECT DISTINCT TRIM(city) AS city, MAX(uf) AS uf
       FROM enterprises
      WHERE active = true AND NULLIF(TRIM(city), '') IS NOT NULL
      GROUP BY TRIM(city)`, Q
  );
  const existing = await db.UserCity.findAll({ attributes: ['id', 'name', 'uf'], raw: true });
  const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const byName = new Map(existing.map(c => [normName(c.name), c]));

  let created = 0;
  for (const r of rows) {
    const found = byName.get(normName(r.city));
    if (found) {
      if (!found.uf && r.uf) await db.UserCity.update({ uf: r.uf }, { where: { id: found.id } });
      continue;
    }
    await db.UserCity.create({ name: r.city, uf: r.uf || null, active: true });
    created++;
  }
  return { created };
}

/** Sync completo (usado pelo scheduler diário e pelo botão Consolidar). */
export async function syncAll({ log = console.log } = {}) {
  // Ordem: EMPRESAS → CV → Sienge.
  // As empresas vêm primeiro porque o passo do CV precisa delas para saber se o
  // `idempreendimento_int` é empresa ou centro de custo (e por causa da FK).
  // O CV vem antes do Sienge para que as linhas do CV já existam quando o passo
  // do Sienge desfaz vínculo falso — assim empreendimento novo fica certo na
  // MESMA rodada. A ordem não muda nome/cidade: o passo do Sienge é `soft` e só
  // preenche lacunas.
  const companies = await syncCompaniesFromSienge();
  const cv = await syncFromCv();
  const erp = await syncFromSienge();
  const cities = await syncUserCitiesFromRegistry();
  log(`[orgRegistry] sync diário: ${companies.vistas} empresa(s) (${companies.nomeados} com nome atualizado), `
    + `Sienge ${erp.matched} CC(s), CV ${cv.seen} empreendimento(s), ${cities.created} cidade(s) nova(s) no catálogo, `
    + `${erp.vinculosCorrigidos || 0} vínculo(s) empresa×centro de custo corrigido(s).`);
  return { companies, erp, cv, cities };
}

// ── Semente legada (enterprise_cities) — roda só enquanto a tabela existir ───
export async function consolidateRegistry({ log = console.log } = {}) {
  const [tbl] = await sequelize.query(
    `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='enterprise_cities'`, Q
  ) || [];
  if (!tbl) return { skipped: true, reason: 'enterprise_cities não existe mais' };

  const ecRows = await sequelize.query(
    `SELECT source, crm_id,
            NULLIF(regexp_replace(COALESCE(erp_id, ''), '[^0-9]', '', 'g'), '')::bigint AS erp_num,
            enterprise_name, default_city, city_override, raw_payload,
            first_seen_at, last_seen_at
       FROM enterprise_cities`, Q
  );
  const cvRows = await sequelize.query(
    `SELECT idempreendimento, nome, cidade, estado FROM cv_enterprises`, Q
  );
  const cvById = new Map(cvRows.map(r => [Number(r.idempreendimento), r]));

  let created = 0;
  // 1) CRM primeiro (nome/cidade do CV mandam)
  for (const r of ecRows.filter(x => x.source === 'crm')) {
    const cvId = toInt(r.crm_id);
    if (!cvId) continue;
    const cv = cvById.get(cvId);
    const res = await upsertEnterprise({
      cv_id: cvId,
      erp_cost_center_id: toInt(r.erp_num),
      name: cleanStr(cv?.nome) || cleanStr(r.enterprise_name),
      city: cleanStr(cv?.cidade, 120) || cleanStr(r.default_city, 120) || cleanStr(r.city_override, 120),
      uf: cleanStr(cv?.estado, 2),
      cv_payload: r.raw_payload || null,
      first_seen_at: r.first_seen_at,
    });
    if (res.created) created++;
  }
  // 2) ERP por cima, soft (só preenche lacunas + company)
  for (const r of ecRows.filter(x => x.source === 'erp')) {
    const erpId = toInt(r.erp_num);
    if (!erpId) continue;
    const companyId = toInt(r.raw_payload?.idCompany);
    if (companyId) {
      await db.OrgCompany.upsert({
        id: companyId,
        name: cleanStr(r.raw_payload?.companyName) || `Empresa ${companyId}`,
        last_seen_at: r.last_seen_at,
      });
    }
    const res = await upsertEnterprise({
      cv_id: null,
      erp_cost_center_id: erpId,
      name: cleanStr(r.enterprise_name),
      city: cleanStr(r.default_city, 120) || cleanStr(r.city_override, 120),
      company_id: companyId,
      erp_payload: r.raw_payload || null,
      first_seen_at: r.first_seen_at,
    }, { soft: true });
    if (res.created) created++;
  }

  await syncUserCitiesFromRegistry();
  log(`[orgRegistry] semente legada: ${ecRows.length} linha(s) de enterprise_cities processadas (${created} novas).`);
  return { seeded: ecRows.length, created };
}

// ── Pareamento manual (tela Sincronização de empresas) ───────────────────────
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

// Colunas ordenáveis pela tela (whitelist — nunca interpolar entrada do usuário).
const SORTABLE = {
  name: 'name',
  city: 'city',
  cv_id: 'cv_id',
  erp_cost_center_id: 'erp_cost_center_id',
  pair_status: 'pair_status',
  active: 'active',
};

export async function listRegistry({
  q = '', status = '', companyId = null, active = '',
  sortBy = 'name', sortDir = 'asc', page = 1, pageSize = 50,
} = {}) {
  const where = {};
  if (status) where.pair_status = status;
  if (companyId) where.company_id = Number(companyId);
  if (active === 'true' || active === true) where.active = true;
  if (active === 'false' || active === false) where.active = false;
  if (q) {
    where[Sequelize.Op.or] = [
      { name: { [Sequelize.Op.iLike]: `%${q}%` } },
      { city: { [Sequelize.Op.iLike]: `%${q}%` } },
    ];
  }

  const col = SORTABLE[sortBy] || 'name';
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // NULLS LAST nos dois sentidos: linha sem CV/CC não polui o topo da lista.
  const order = [[db.Sequelize.literal(`"OrgEnterprise"."${col}" ${dir} NULLS LAST`)]];

  const { rows, count } = await db.OrgEnterprise.findAndCountAll({
    where,
    include: [{ model: db.OrgCompany, as: 'company', attributes: ['id', 'name'] }],
    order,
    limit: Math.min(Number(pageSize) || 50, 3000),
    offset: (Math.max(Number(page) || 1, 1) - 1) * (Number(pageSize) || 50),
  });
  return { items: rows, total: count };
}

export default {
  syncFromCv, syncFromSienge, syncCompaniesFromSienge, syncAll,
  consolidateRegistry, pairEnterprises, listRegistry,
};
