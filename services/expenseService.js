// services/expenseService.js
import db from '../models/sequelize/index.js';

const { Expense, SiengeBill, Sequelize } = db;
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
        departmentId: e.department_id,
        departmentName: e.department_name,

        // 👇 NOVO
        departmentCategoryId: e.department_category_id,
        departmentCategoryName: e.department_category_name,

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
            creditor_json: e.bill.creditor_json,
          }
          : null,
      })),
    };
  }

  /**
   * Lista TODOS os gastos do mês (todos os centros de custo)
   * e agrupa por cost_center_id
   */
  async summarizeAllMonth({ competenceMonth }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const rows = await Expense.findAll({
      where: { competence_month: compDate },
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

    const groups = [];
    let totalAll = 0;

    for (const [costCenterId, expenses] of groupsMap.entries()) {
      const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      totalAll += total;

      const costCenterName =
        expenses.length ? expenses[0].cost_center_name || null : null;

      groups.push({
        costCenterId,
        costCenterName,
        total,
        expenses: expenses.map(e => ({
          id: e.id,
          amount: Number(e.amount),
          description: e.description,
          departmentId: e.department_id,
          departmentName: e.department_name,

          // 👇 NOVO
          departmentCategoryId: e.department_category_id,
          departmentCategoryName: e.department_category_name,

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
              creditor_json: e.bill.creditor_json,
            }
            : null,
        })),
      });
    }

    return {
      competenceMonth,
      total: totalAll,
      groups,
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

  async updateExpense({
    id,
    amount,
    description,
    departmentId,
    departmentName,
    // 👇 NOVO
    departmentCategoryId,
    departmentCategoryName,
  }) {
    const exp = await Expense.findByPk(id);
    if (!exp) {
      throw new Error('Despesa não encontrada');
    }

    await exp.update({
      amount,
      description,
      department_id: departmentId ?? exp.department_id,
      department_name: departmentName ?? exp.department_name,

      // 👇 NOVO
      department_category_id: departmentCategoryId ?? exp.department_category_id,
      department_category_name: departmentCategoryName ?? exp.department_category_name,
    });

    return exp;
  }

  async deleteExpense({ id }) {
    await Expense.destroy({ where: { id } });
  }
}
