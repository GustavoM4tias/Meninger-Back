// services/mktExpenseService.js
import db from '../models/sequelize/index.js';

const { MktExpense, SiengeBill, Sequelize } = db;
const { Op } = Sequelize;

export default class MktExpenseService {
  /**
   * Adiciona um gasto de MKT
   * { costCenterId, competenceMonth: "2025-10", billId?, amount, description? }
   */
  async addExpense({ costCenterId, competenceMonth, billId, amount, description }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const expense = await MktExpense.create({
      cost_center_id: costCenterId,
      competence_month: compDate,
      bill_id: billId || null,
      amount,
      description,
    });

    return expense;
  }

  /**
   * Lista gastos de UM centro de custo no mês (usado quando costCenterId é passado)
   */
  async listMonth({ costCenterId, competenceMonth }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const rows = await MktExpense.findAll({
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

  /**
   * Resumo do mês para UM centro de custo
   */
  async summarizeMonth({ costCenterId, competenceMonth }) {
    const expenses = await this.listMonth({ costCenterId, competenceMonth });
    const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    return {
      costCenterId,
      competenceMonth,
      total,
      expenses: expenses.map(e => ({
        id: e.id,
        amount: Number(e.amount),
        description: e.description,
        billId: e.bill_id,
        bill: e.bill ? {
          id: e.bill.id,
          issueDate: e.bill.issue_date,
          totalInvoiceAmount: Number(e.bill.total_invoice_amount),
          mainDepartmentName: e.bill.main_department_name,
          notes: e.bill.notes,
        } : null
      }))
    };
  }

  /**
   * 🔹 NOVO: lista TODOS os gastos do mês (todos os centros de custo)
   * e agrupa por cost_center_id
   */
  async summarizeAllMonth({ competenceMonth }) {
    const [y, m] = competenceMonth.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const compDate = monthStart.toISOString().slice(0, 10);

    const rows = await MktExpense.findAll({
      where: { competence_month: compDate },
      include: [
        {
          model: SiengeBill,
          as: 'bill',
        }
      ],
      order: [['cost_center_id', 'ASC'], ['id', 'ASC']],
    });

    // agrupar por cost_center_id
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

      groups.push({
        costCenterId,
        total,
        expenses: expenses.map(e => ({
          id: e.id,
          amount: Number(e.amount),
          description: e.description,
          billId: e.bill_id,
          bill: e.bill ? {
            id: e.bill.id,
            issueDate: e.bill.issue_date,
            totalInvoiceAmount: Number(e.bill.total_invoice_amount),
            mainDepartmentName: e.bill.main_department_name,
            notes: e.bill.notes,
          } : null
        })),
      });
    }

    return {
      competenceMonth,
      total: totalAll,
      groups,
    };
  }
}
