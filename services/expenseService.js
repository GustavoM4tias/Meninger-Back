// services/expenseService.js
import db from '../models/sequelize/index.js';

const { Expense, SiengeBill, Sequelize, sequelize } = db;
const { Op } = Sequelize;

export default class expenseService {
  async addExpense({
    costCenterId,
    costCenterName,
    competenceMonth,
    billId,
    amount,
    description,
    departmentId,
    departmentName,
    departmentCategoryId,
    departmentCategoryName,

    // ✅ NOVO
    installmentNumber,
    installmentsNumber,
  }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const expense = await Expense.create({
      cost_center_id: costCenterId,
      cost_center_name: costCenterName || null,
      competence_month: compDate,
      bill_id: billId || null,
      amount,
      description,
      department_id: departmentId || null,
      department_name: departmentName || null,
      department_category_id: departmentCategoryId || null,
      department_category_name: departmentCategoryName || null,

      // ✅ NOVO
      installment_number: installmentNumber ?? null,
      installments_number: installmentsNumber ?? null,
    });

    return expense;
  }

  /** Lista gastos de UM centro de custo no mês */
  async listMonth({ costCenterId, competenceMonth }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const rows = await Expense.findAll({
      where: {
        cost_center_id: costCenterId,
        competence_month: compDate,
      },
      include: [
        {
          model: SiengeBill,
          as: 'bill',
        }
      ],
      order: [['id', 'ASC']],
    });

    return rows;
  }

  /** Resumo do mês para UM centro de custo */
  async summarizeMonth({ costCenterId, competenceMonth }) {
    const expenses = await this.listMonth({ costCenterId, competenceMonth });
    const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const costCenterName =
      expenses.length ? expenses[0].cost_center_name || null : null;

    return {
      costCenterId,
      costCenterName,
      competenceMonth,
      total,
      expenses: expenses.map(e => ({
        id: e.id,
        amount: Number(e.amount),
        description: e.description,
        competenceMonth: e.competence_month,
        dueDate: e.due_date,

        installmentNumber: e.installment_number ?? null,
        installmentsNumber: e.installments_number ?? null,

        departmentId: e.department_id,
        departmentName: e.department_name,
        departmentCategoryId: e.department_category_id,
        departmentCategoryName: e.department_category_name,

        status: e.status || 'open',
        paidAt: e.paid_at || null,

        costCenterId: e.cost_center_id,
        costCenterName: e.cost_center_name,
        billId: e.bill_id,
        bill: e.bill
          ? {
            id: e.bill.id,
            issueDate: e.bill.issue_date,
            totalInvoiceAmount: Number(e.bill.total_invoice_amount),
            mainDepartmentName: e.bill.main_department_name,
            notes: e.bill.notes,
            document_identification_id: e.bill.document_identification_id,
            document_number: e.bill.document_number,
            installmentNumber: Number(e.bill.installment_number || 0),
            installmentsNumber: Number(e.bill.installments_number || 0),
            creditor_json: e.bill.creditor_json,
            currentStatus: e.bill.current_status || 'open',
            isSettled: !!e.bill.is_settled,
          }
          : null,
      })),
    };
  }

  /**
   * Lista TODOS os gastos no período (todos os centros de custo)
   * e agrupa por cost_center_id.
   * startDate e endDate: 'YYYY-MM-DD' (competence_month BETWEEN startDate AND endDate)
   */
  async summarizeAllMonth({ competenceMonth, startDate, endDate, costCenterId }) {
    let whereClause;

    if (startDate && endDate) {
      whereClause = { competence_month: { [Op.between]: [startDate, endDate] } };
    } else {
      // fallback: compatibilidade com código legado que passa competenceMonth
      const [y, m] = (competenceMonth || '').split('-').map(Number);
      const compDate = new Date(y, m - 1, 1).toISOString().slice(0, 10);
      whereClause = { competence_month: compDate };
    }

    // Filtro opcional por centro de custo
    if (costCenterId) {
      whereClause.cost_center_id = costCenterId;
    }

    // ── Departamentos ocultos pelo admin ─────────────────────────────────────
    // Carrega ANTES da query principal para excluir os gastos desses departamentos
    // direto da fonte — o dropdown do front filtrar não bastava (sem filtro o
    // usuário via tudo, incluindo o que estava desativado em configurações).
    const hiddenRows = await sequelize.query(
      `SELECT name FROM expense_department_visibility WHERE hidden = true`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const hiddenDepartments = hiddenRows.map(r => r.name).filter(Boolean);

    if (hiddenDepartments.length) {
      // department_name NULL não é "oculto" (admin nem tinha como desativar) → mantém visível
      whereClause[Op.and] = [
        ...(whereClause[Op.and] || []),
        {
          [Op.or]: [
            { department_name: null },
            { department_name: { [Op.notIn]: hiddenDepartments } },
          ],
        },
      ];
    }

    const rows = await Expense.findAll({
      where: whereClause,
      include: [
        {
          model: SiengeBill,
          as: 'bill',
        }
      ],
      order: [['cost_center_id', 'ASC'], ['id', 'ASC']],
    });

    const groupsMap = new Map();

    for (const e of rows) {
      const cc = e.cost_center_id;
      if (!groupsMap.has(cc)) {
        groupsMap.set(cc, []);
      }
      groupsMap.get(cc).push(e);
    }

    // ── Resolve nome de empreendimento para os cost_center_ids que apareceram ───
    //
    // Identidade do empreendimento = cost_center_id (perpetuado pelo CC, não pelo nome).
    // O nome exibido é apenas uma label; fontes em ordem de prioridade:
    //   0) cost_center_overrides.display_name (admin sobrepôs manualmente) — MÁXIMA
    //   1) enterprise_cities, match direto, preferência source='crm'
    //   2) enterprise_cities, match pelo "CC base" (sub-CC herda do pai)
    const costCenterIdsInUse = [...groupsMap.keys()].filter(Number.isFinite);
    const nameByCc = new Map();

    if (costCenterIdsInUse.length) {
      // Passo 0 — overrides admin (mais alta prioridade)
      const overrides = await sequelize.query(
        `SELECT cost_center_id, display_name FROM cost_center_overrides
         WHERE cost_center_id IN (:ids)`,
        { replacements: { ids: costCenterIdsInUse }, type: Sequelize.QueryTypes.SELECT }
      );
      for (const o of overrides) {
        nameByCc.set(Number(o.cost_center_id), o.display_name);
      }
      // Passo 1 — match direto
      const directRows = await sequelize.query(
        `SELECT DISTINCT ON (ec.erp_id::int)
            ec.erp_id::int AS erp_id,
            ec.enterprise_name
         FROM enterprise_cities ec
         WHERE ec.erp_id IS NOT NULL
           AND ec.erp_id ~ '^[0-9]+$'
           AND ec.erp_id::int IN (:ids)
           AND COALESCE(NULLIF(TRIM(ec.enterprise_name), ''), NULL) IS NOT NULL
         ORDER BY ec.erp_id::int, CASE ec.source WHEN 'crm' THEN 1 ELSE 2 END, ec.id`,
        { replacements: { ids: costCenterIdsInUse }, type: Sequelize.QueryTypes.SELECT }
      );
      for (const r of directRows) {
        // não sobrescreve override admin já setado no Passo 0
        if (!nameByCc.has(Number(r.erp_id))) {
          nameByCc.set(Number(r.erp_id), r.enterprise_name);
        }
      }

      // Passo 2 — para CCs sem match, busca pelo "CC base" (heurística de sub-CC)
      const stillMissing = costCenterIdsInUse.filter(cc => !nameByCc.has(Number(cc)));
      if (stillMissing.length) {
        const baseToOriginals = new Map();
        for (const cc of stillMissing) {
          const base = Math.floor(Number(cc) / 100) * 100 + 1;
          if (base === Number(cc)) continue; // já tentamos o exato no passo 1
          if (!baseToOriginals.has(base)) baseToOriginals.set(base, []);
          baseToOriginals.get(base).push(Number(cc));
        }
        const baseIds = [...baseToOriginals.keys()];
        if (baseIds.length) {
          const baseRows = await sequelize.query(
            `SELECT DISTINCT ON (ec.erp_id::int)
                ec.erp_id::int AS erp_id,
                ec.enterprise_name
             FROM enterprise_cities ec
             WHERE ec.erp_id IS NOT NULL
               AND ec.erp_id ~ '^[0-9]+$'
               AND ec.erp_id::int IN (:ids)
               AND COALESCE(NULLIF(TRIM(ec.enterprise_name), ''), NULL) IS NOT NULL
             ORDER BY ec.erp_id::int, CASE ec.source WHEN 'crm' THEN 1 ELSE 2 END, ec.id`,
            { replacements: { ids: baseIds }, type: Sequelize.QueryTypes.SELECT }
          );
          for (const r of baseRows) {
            const originals = baseToOriginals.get(Number(r.erp_id)) || [];
            for (const original of originals) {
              nameByCc.set(original, r.enterprise_name);
            }
          }
        }
      }
    }

    const groups = [];
    let totalAll = 0;

    for (const [costCenterId, expenses] of groupsMap.entries()) {
      const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      totalAll += total;

      // Ordem: 1) enterprise_cities (preferência ERP) 2) cost_center_name salvo no Expense 3) null
      const costCenterName =
        nameByCc.get(Number(costCenterId))
        || (expenses.length ? expenses[0].cost_center_name || null : null);

      groups.push({
        costCenterId,
        costCenterName,
        total,
        expenses: expenses.map(e => ({
          id: e.id,
          amount: Number(e.amount),
          description: e.description,
          competenceMonth: e.competence_month,
          dueDate: e.due_date,

          installmentNumber: e.installment_number ?? null,
          installmentsNumber: e.installments_number ?? null,

          departmentId: e.department_id,
          departmentName: e.department_name,
          departmentCategoryId: e.department_category_id,
          departmentCategoryName: e.department_category_name,

          status: e.status || 'open',
          paidAt: e.paid_at || null,

          costCenterId: e.cost_center_id,
          costCenterName: e.cost_center_name,
          billId: e.bill_id,
          bill: e.bill
            ? {
              id: e.bill.id,
              issueDate: e.bill.issue_date,
              totalInvoiceAmount: Number(e.bill.total_invoice_amount),
              mainDepartmentName: e.bill.main_department_name,
              notes: e.bill.notes,
              document_identification_id: e.bill.document_identification_id,
              document_number: e.bill.document_number,
              installmentNumber: Number(e.bill.installment_number || 0),
              installmentsNumber: Number(e.bill.installments_number || 0),
              creditor_json: e.bill.creditor_json,
              currentStatus: e.bill.current_status || 'open',
              isSettled: !!e.bill.is_settled,
            }
            : null,
        })),
      });
    }

    // hiddenDepartments já foi carregado no topo da função e usado no WHERE.
    // Retornamos no metadata também para o front continuar filtrando o dropdown
    // (consistência: lista do dropdown == backend está filtrando).
    return {
      startDate: startDate || competenceMonth,
      endDate: endDate || competenceMonth,
      total: totalAll,
      groups,
      hiddenDepartments,
    };
  }

  // services/expenseService.js
  async listLinksByBill({ billIds }) {
    const rows = await Expense.findAll({
      where: { bill_id: { [Op.in]: billIds } },
      attributes: [
        'bill_id',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
        [Sequelize.fn('SUM', Sequelize.col('amount')), 'total'],
        // 👇 pega uma categoria "representativa" (MAX serve pra isso)
        [Sequelize.fn('MAX', Sequelize.col('department_category_id')), 'departmentCategoryId'],
        [Sequelize.fn('MAX', Sequelize.col('department_category_name')), 'departmentCategoryName'],
      ],
      group: ['bill_id'],
    });

    return rows.map(r => ({
      billId: r.bill_id,
      count: Number(r.get('count') || 0),
      total: Number(r.get('total') || 0),
      departmentCategoryId: r.get('departmentCategoryId')
        ? Number(r.get('departmentCategoryId'))
        : null,
      departmentCategoryName: r.get('departmentCategoryName') || null,
    }));
  }

  // 'amount' não é atualizável — vem do Sienge e é fonte da verdade
  async updateExpense({
    id,
    description,
    departmentId,
    departmentName,
    departmentCategoryId,
    departmentCategoryName,
  }) {
    const exp = await Expense.findByPk(id);
    if (!exp) {
      throw new Error('Despesa não encontrada');
    }

    // Se o departamento foi informado explicitamente, marca como override manual.
    // Isso blinda o campo contra qualquer sobrescrita do re-sync (presente e futura).
    const departmentTouched =
      (departmentName !== undefined && departmentName !== null) ||
      (departmentId !== undefined && departmentId !== null);

    await exp.update({
      description,
      department_id: departmentId ?? exp.department_id,
      department_name: departmentName ?? exp.department_name,
      department_category_id: departmentCategoryId ?? exp.department_category_id,
      department_category_name: departmentCategoryName ?? exp.department_category_name,
      department_overridden: departmentTouched ? true : exp.department_overridden,
    });

    return exp;
  }
  async deleteExpense({ id }) {
    const exp = await Expense.findByPk(id);
    if (!exp) return;

    // se tem vínculo com título, apaga tudo daquele título (todas as parcelas)
    if (exp.bill_id) {
      await Expense.destroy({ where: { bill_id: exp.bill_id } });
      return;
    }

    // sem título vinculado: apaga só o registro
    await Expense.destroy({ where: { id } });
  }

}
