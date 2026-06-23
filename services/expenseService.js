// services/expenseService.js
//
// Tela "Custos" — agora lê AO VIVO do backup do Sienge (payableLiveService), não
// mais da tabela `expenses` populada pelo Auto-Sync. Cada "expense" é uma parcela
// (ecpgparcela) atribuída ao centro de custo principal do título. Departamento vem
// sempre do Sienge; categoria + observação são personalizações do Office,
// guardadas em `expense_personalizations` (chave nutitulo+nuparcela) e mescladas
// por cima dos dados ao vivo.

import db from '../models/sequelize/index.js';
import { getHiddenDepartmentsForUser } from './permissions/departmentVisibilityService.js';
import { listExpenseRows, listLinkRows } from './sienge/payableLiveService.js';

const { ExpensePersonalization, Sequelize, sequelize } = db;
const { Op } = Sequelize;

// Decodifica o id sintético "<nutitulo>-<nuparcela>" usado pelas linhas ao vivo.
function parseSyntheticId(id) {
  const [t, p] = String(id).split('-');
  const nutitulo = Number(t);
  const nuparcela = Number(p);
  if (!Number.isFinite(nutitulo) || !Number.isFinite(nuparcela)) return null;
  return { nutitulo, nuparcela };
}

export default class expenseService {
  /**
   * Resolve o nome de exibição dos empreendimentos (cost_center_id = cdempreendview).
   * Ordem de prioridade (idêntica ao comportamento anterior):
   *   0) cost_center_overrides.display_name (admin sobrepôs) — MÁXIMA
   *   1) enterprise_cities, match direto (preferência source='crm')
   *   2) enterprise_cities, match pelo "CC base" (sub-CC herda do pai)
   * @returns {Promise<Map<number,string>>}
   */
  async resolveCostCenterNames(costCenterIds) {
    const ids = [...new Set((costCenterIds || []).map(Number).filter(Number.isFinite))];
    const nameByCc = new Map();
    if (!ids.length) return nameByCc;

    // Passo 0 — overrides admin (mais alta prioridade)
    const overrides = await sequelize.query(
      `SELECT cost_center_id, display_name FROM cost_center_overrides WHERE cost_center_id IN (:ids)`,
      { replacements: { ids }, type: Sequelize.QueryTypes.SELECT }
    );
    for (const o of overrides) nameByCc.set(Number(o.cost_center_id), o.display_name);

    // Passo 1 — match direto
    const directRows = await sequelize.query(
      `SELECT DISTINCT ON (ec.erp_id::int) ec.erp_id::int AS erp_id, ec.enterprise_name
         FROM enterprise_cities ec
        WHERE ec.erp_id IS NOT NULL AND ec.erp_id ~ '^[0-9]+$' AND ec.erp_id::int IN (:ids)
          AND COALESCE(NULLIF(TRIM(ec.enterprise_name), ''), NULL) IS NOT NULL
        ORDER BY ec.erp_id::int, CASE ec.source WHEN 'crm' THEN 1 ELSE 2 END, ec.id`,
      { replacements: { ids }, type: Sequelize.QueryTypes.SELECT }
    );
    for (const r of directRows) {
      if (!nameByCc.has(Number(r.erp_id))) nameByCc.set(Number(r.erp_id), r.enterprise_name);
    }

    // Passo 2 — CC base (heurística de sub-CC: 80101 → 80001)
    const stillMissing = ids.filter(cc => !nameByCc.has(Number(cc)));
    if (stillMissing.length) {
      const baseToOriginals = new Map();
      for (const cc of stillMissing) {
        const base = Math.floor(Number(cc) / 100) * 100 + 1;
        if (base === Number(cc)) continue;
        if (!baseToOriginals.has(base)) baseToOriginals.set(base, []);
        baseToOriginals.get(base).push(Number(cc));
      }
      const baseIds = [...baseToOriginals.keys()];
      if (baseIds.length) {
        const baseRows = await sequelize.query(
          `SELECT DISTINCT ON (ec.erp_id::int) ec.erp_id::int AS erp_id, ec.enterprise_name
             FROM enterprise_cities ec
            WHERE ec.erp_id IS NOT NULL AND ec.erp_id ~ '^[0-9]+$' AND ec.erp_id::int IN (:ids)
              AND COALESCE(NULLIF(TRIM(ec.enterprise_name), ''), NULL) IS NOT NULL
            ORDER BY ec.erp_id::int, CASE ec.source WHEN 'crm' THEN 1 ELSE 2 END, ec.id`,
          { replacements: { ids: baseIds }, type: Sequelize.QueryTypes.SELECT }
        );
        for (const r of baseRows) {
          for (const original of (baseToOriginals.get(Number(r.erp_id)) || [])) {
            nameByCc.set(original, r.enterprise_name);
          }
        }
      }
    }
    return nameByCc;
  }

  /** Busca as personalizações (categoria/observação) das parcelas presentes. */
  async loadPersonalizations(billIds) {
    const ids = [...new Set((billIds || []).map(Number).filter(Number.isFinite))];
    if (!ids.length) return new Map();
    const rows = await ExpensePersonalization.findAll({ where: { nutitulo: { [Op.in]: ids } } });
    const map = new Map();
    for (const r of rows) map.set(`${r.nutitulo}-${r.nuparcela}`, r);
    return map;
  }

  /**
   * Lista TODOS os custos no período (todos os centros de custo, ou um só) e agrupa
   * por cost_center_id. startDate/endDate: 'YYYY-MM-DD' (competência = mês do vencimento).
   * Mesmo shape de antes: { startDate, endDate, total, groups[], hiddenDepartments }.
   */
  async summarizeAllMonth({ startDate, endDate, costCenterId, user }) {
    // 1) Dados ao vivo (uma linha por parcela)
    const rows = await listExpenseRows({ startDate, endDate, costCenterId });

    // 2) Departamentos ocultos (cascata global → cargo → usuário). Admin vê tudo.
    //    department_name NULL nunca é "oculto".
    const hiddenDepartments = await getHiddenDepartmentsForUser(user);
    const hiddenSet = new Set(hiddenDepartments);
    const visible = hiddenSet.size
      ? rows.filter(r => !r.departmentName || !hiddenSet.has(r.departmentName))
      : rows;

    // 3) Personalizações (categoria/observação) por parcela
    const persMap = await this.loadPersonalizations(visible.map(r => r.billId));

    // 4) Nomes de empreendimento
    const ccIds = [...new Set(visible.map(r => r.costCenterId).filter(Number.isFinite))];
    const nameByCc = await this.resolveCostCenterNames(ccIds);

    // 5) Agrupa por cost_center_id
    const groupsMap = new Map();
    for (const r of visible) {
      if (!groupsMap.has(r.costCenterId)) groupsMap.set(r.costCenterId, []);
      groupsMap.get(r.costCenterId).push(r);
    }

    const groups = [];
    let totalAll = 0;
    for (const [cc, list] of groupsMap.entries()) {
      const total = list.reduce((s, e) => s + Number(e.amount || 0), 0);
      totalAll += total;
      const costCenterName = nameByCc.get(Number(cc)) || null;
      groups.push({
        costCenterId: cc,
        costCenterName,
        total,
        expenses: list.map(e => {
          const pers = persMap.get(e.id);
          return {
            id: e.id,
            amount: Number(e.amount),
            description: pers?.description ?? null,
            competenceMonth: e.competenceMonth,
            dueDate: e.dueDate,
            installmentNumber: e.installmentNumber ?? null,
            installmentsNumber: e.installmentsNumber ?? null,
            departmentId: e.departmentId,
            departmentName: e.departmentName,
            departmentCategoryId: pers?.department_category_id ?? null,
            departmentCategoryName: pers?.department_category_name ?? null,
            status: e.status || 'open',
            paidAt: e.paidAt || null,
            costCenterId: e.costCenterId,
            costCenterName,
            billId: e.billId,
            bill: e.bill,
          };
        }),
      });
    }

    return {
      startDate,
      endDate,
      total: totalAll,
      groups,
      hiddenDepartments,
    };
  }

  /** Vínculos por título (tela Títulos): contagem/soma de parcelas + categoria representativa. */
  async listLinksByBill({ billIds }) {
    const links = await listLinkRows({ billIds });
    // categoria representativa por título (qualquer parcela personalizada)
    const ids = [...new Set((billIds || []).map(Number).filter(Number.isFinite))];
    const catByBill = new Map();
    if (ids.length) {
      const pers = await ExpensePersonalization.findAll({
        where: { nutitulo: { [Op.in]: ids }, department_category_id: { [Op.ne]: null } },
      });
      for (const p of pers) {
        if (!catByBill.has(p.nutitulo)) {
          catByBill.set(p.nutitulo, {
            departmentCategoryId: p.department_category_id,
            departmentCategoryName: p.department_category_name,
          });
        }
      }
    }
    return links.map(l => ({
      billId: l.billId,
      count: l.count,
      total: l.total,
      departmentCategoryId: catByBill.get(l.billId)?.departmentCategoryId ?? null,
      departmentCategoryName: catByBill.get(l.billId)?.departmentCategoryName ?? null,
    }));
  }

  /**
   * Atualiza a personalização (categoria + observação) de UMA parcela. O id é o
   * sintético "<nutitulo>-<nuparcela>". Departamento NÃO é editável (vem do Sienge),
   * então departmentId/departmentName são ignorados se vierem no payload.
   */
  async updateExpense({ id, description, departmentCategoryId, departmentCategoryName, updatedBy }) {
    const parsed = parseSyntheticId(id);
    if (!parsed) throw new Error('Identificador de custo inválido.');
    const { nutitulo, nuparcela } = parsed;

    const [row] = await ExpensePersonalization.findOrCreate({
      where: { nutitulo, nuparcela },
      defaults: { nutitulo, nuparcela },
    });

    await row.update({
      description: description !== undefined ? description : row.description,
      department_category_id: departmentCategoryId !== undefined ? departmentCategoryId : row.department_category_id,
      department_category_name: departmentCategoryName !== undefined ? departmentCategoryName : row.department_category_name,
      updated_by: updatedBy || row.updated_by,
    });

    return {
      id: `${nutitulo}-${nuparcela}`,
      billId: nutitulo,
      installmentNumber: nuparcela,
      description: row.description,
      departmentCategoryId: row.department_category_id,
      departmentCategoryName: row.department_category_name,
    };
  }

  /** "Remove" = limpa a personalização daquela parcela (não apaga dado do Sienge). */
  async deleteExpense({ id }) {
    const parsed = parseSyntheticId(id);
    if (!parsed) return { cleared: 0 };
    const { nutitulo, nuparcela } = parsed;
    const cleared = await ExpensePersonalization.destroy({ where: { nutitulo, nuparcela } });
    return { cleared };
  }
}
