// src/controllers/sienge/cefConsultaController.js
//
// Consulta de nº CEF (Financeiro > Contas a Receber).
// Expõe o "número da instituição financeira" (contracts.financial_institution_number)
// dos contratos sincronizados do Sienge - na prática, o nº do contrato/título na
// Caixa Econômica Federal - com filtro por empreendimento e busca geral
// (cliente, nº do contrato, unidade, empreendimento ou o próprio nº CEF).
//
// Alçada: admin enxerga tudo; não-admin enxerga apenas empreendimentos cujo
// centro de custo (contracts.enterprise_id) está no seu escopo de acesso
// (accessScopeService) - mesmo gate usado em contratos/faturamento.
import db from '../../models/sequelize/index.js'
import { getScope } from '../../services/permissions/accessScopeService.js'

// Filtro de escopo por id ERP direto na tabela de contratos.
const SCOPE_WHERE = `
  AND sc.enterprise_id IN (:erpIds)`

// Nº CEF "preenchido" = string não vazia após TRIM.
const HAS_CEF = `NULLIF(TRIM(sc.financial_institution_number), '') IS NOT NULL`

function parseIds(raw) {
    return typeof raw === 'string'
        ? raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
        : []
}

/** Resolve a alçada do usuário via accessScopeService (fail-closed). */
async function resolveScope(req) {
    const scope = await getScope(req.user)
    if (scope.all) return { isAdmin: true, erpIds: null }
    return { isAdmin: false, erpIds: scope.erpIds || [] }
}

/**
 * GET /api/sienge/cef/enterprises
 * Empreendimentos disponíveis para o usuário (admin: todos; não-admin: do seu escopo).
 */
export async function listCefEnterprises(req, res) {
    try {
        const scope = await resolveScope(req)

        // fail-closed: escopo vazio → lista vazia
        if (!scope.isAdmin && !scope.erpIds.length) {
            return res.json({ count: 0, results: [], isAdmin: false })
        }

        const sql = `
      SELECT DISTINCT ON (sc.enterprise_id)
        sc.enterprise_id   AS id,
        sc.enterprise_name AS name
      FROM contracts sc
      WHERE sc.enterprise_id IS NOT NULL
        ${scope.isAdmin ? '' : SCOPE_WHERE}
      ORDER BY sc.enterprise_id, sc.id DESC;
    `

        const rows = await db.sequelize.query(sql, {
            replacements: scope.isAdmin ? {} : { erpIds: scope.erpIds },
            type: db.Sequelize.QueryTypes.SELECT,
        })

        const results = rows
            .map((r) => ({ id: r.id, name: r.name }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'))

        return res.json({ count: results.length, results, isAdmin: scope.isAdmin })
    } catch (err) {
        console.error('[cef] listCefEnterprises', err)
        return res.status(500).json({ error: 'Erro ao listar empreendimentos.' })
    }
}

// Colunas ordenáveis (whitelist para o ORDER BY).
const SORTABLE = {
    financial_institution_date: 'b.financial_institution_date',
    contract_date: 'b.contract_date',
    number: 'b.number',
    enterprise_name: 'b.enterprise_name',
    customer_name: 'b.customer_name',
    value: 'b.value',
}

/**
 * GET /api/sienge/cef/search
 * ?enterpriseIds=1,2&q=texto&cef=com|sem&page=1&pageSize=50&sort=financial_institution_date&dir=desc
 */
export async function searchCef(req, res) {
    try {
        const scope = await resolveScope(req)

        const enterpriseIds = parseIds(req.query.enterpriseIds)
        const qRaw = String(req.query.q || '').trim()
        const cef = ['com', 'sem'].includes(req.query.cef) ? req.query.cef : ''

        // Consulta dirigida: sem busca nem empreendimento selecionado não varre a
        // base inteira — o front instrui o usuário a filtrar primeiro.
        if (!qRaw && !enterpriseIds.length) {
            return res.json({
                page: 1,
                pageSize: Math.min(200, Math.max(1, Number(req.query.pageSize) || 50)),
                total: 0,
                isAdmin: scope.isAdmin,
                needsFilter: true,
                summary: { total: 0, withCef: 0, withoutCef: 0 },
                rows: [],
            })
        }

        const page = Math.max(1, Number(req.query.page) || 1)
        const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50))
        const sortCol = SORTABLE[req.query.sort] || SORTABLE.financial_institution_date
        const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

        // fail-closed: escopo vazio → resultado vazio
        if (!scope.isAdmin && !scope.erpIds.length) {
            return res.json({
                page,
                pageSize,
                total: 0,
                isAdmin: false,
                summary: { total: 0, withCef: 0, withoutCef: 0 },
                rows: [],
            })
        }

        const replacements = {}
        if (!scope.isAdmin) replacements.erpIds = scope.erpIds

        let enterpriseClause = ''
        if (enterpriseIds.length) {
            replacements.enterpriseIds = enterpriseIds
            enterpriseClause = ' AND sc.enterprise_id IN (:enterpriseIds)'
        }

        // Busca geral: nº CEF, nº do contrato, empreendimento, qualquer cliente ou unidade.
        let qClause = ''
        if (qRaw) {
            replacements.q = `%${qRaw}%`
            qClause = `
        AND (
          unaccent(upper(COALESCE(sc.financial_institution_number, ''))) LIKE unaccent(upper(:q))
          OR unaccent(upper(sc.number)) LIKE unaccent(upper(:q))
          OR unaccent(upper(sc.enterprise_name)) LIKE unaccent(upper(:q))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(sc.customers, '[]'::jsonb)) c
            WHERE unaccent(upper(COALESCE(c ->> 'name', ''))) LIKE unaccent(upper(:q))
          )
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(sc.units, '[]'::jsonb)) u
            WHERE unaccent(upper(COALESCE(u ->> 'name', ''))) LIKE unaccent(upper(:q))
          )
        )`
        }

        const cefClause = cef === 'com' ? ` AND ${HAS_CEF}` : cef === 'sem' ? ` AND NOT (${HAS_CEF})` : ''

        const scopedWhere = `
      WHERE 1=1
        ${scope.isAdmin ? '' : SCOPE_WHERE}
        ${enterpriseClause}
        ${qClause}`

        const sqlRows = `
      WITH base AS (
        SELECT
          sc.id,
          sc.number,
          sc.enterprise_id,
          sc.enterprise_name,
          sc.company_id,
          sc.company_name,
          sc.situation,
          sc.contract_date,
          sc.value,
          sc.financial_institution_number,
          sc.financial_institution_date,
          COALESCE(
            (SELECT c ->> 'name' FROM jsonb_array_elements(COALESCE(sc.customers, '[]'::jsonb)) c
              WHERE (c ->> 'main')::boolean = true LIMIT 1),
            (SELECT c ->> 'name' FROM jsonb_array_elements(COALESCE(sc.customers, '[]'::jsonb)) c
              ORDER BY (c ->> 'id')::int NULLS LAST LIMIT 1)
          ) AS customer_name,
          COALESCE(
            (SELECT u ->> 'name' FROM jsonb_array_elements(COALESCE(sc.units, '[]'::jsonb)) u
              WHERE (u ->> 'main')::boolean = true LIMIT 1),
            (SELECT u ->> 'name' FROM jsonb_array_elements(COALESCE(sc.units, '[]'::jsonb)) u LIMIT 1)
          ) AS unit_name
        FROM contracts sc
        ${scopedWhere}
          ${cefClause}
      )
      SELECT b.*, COUNT(*) OVER()::int AS total_count
      FROM base b
      ORDER BY ${sortCol} ${dir} NULLS LAST, b.id DESC
      LIMIT :limit OFFSET :offset;
    `

        // Resumo (respeita empreendimento/busca, ignora o recorte com/sem para
        // mostrar o panorama dos dois lados).
        const sqlSummary = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${HAS_CEF})::int AS with_cef
      FROM contracts sc
      ${scopedWhere};
    `

        const [rows, summaryRows] = await Promise.all([
            db.sequelize.query(sqlRows, {
                replacements: { ...replacements, limit: pageSize, offset: (page - 1) * pageSize },
                type: db.Sequelize.QueryTypes.SELECT,
            }),
            db.sequelize.query(sqlSummary, {
                replacements,
                type: db.Sequelize.QueryTypes.SELECT,
            }),
        ])

        const total = rows.length ? Number(rows[0].total_count) : 0
        const summary = summaryRows[0] || { total: 0, with_cef: 0 }

        return res.json({
            page,
            pageSize,
            total,
            isAdmin: scope.isAdmin,
            summary: {
                total: Number(summary.total || 0),
                withCef: Number(summary.with_cef || 0),
                withoutCef: Number(summary.total || 0) - Number(summary.with_cef || 0),
            },
            rows: rows.map((r) => ({
                id: r.id,
                number: r.number,
                enterprise_id: r.enterprise_id,
                enterprise_name: r.enterprise_name,
                company_name: r.company_name,
                situation: r.situation,
                contract_date: r.contract_date,
                value: r.value,
                customer_name: r.customer_name,
                unit_name: r.unit_name,
                financial_institution_number: r.financial_institution_number,
                financial_institution_date: r.financial_institution_date,
            })),
        })
    } catch (err) {
        console.error('[cef] searchCef', err)
        return res.status(500).json({ error: 'Erro ao consultar contratos.' })
    }
}
