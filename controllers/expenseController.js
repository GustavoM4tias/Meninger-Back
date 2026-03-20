// src/controllers/expenseController.js
import expenseService from '../services/expenseService.js';

export default class expenseController {

  constructor() {
    this.service = new expenseService();
  }

  /** POST /api/expenses */
  add = async (req, res) => {
    try {
      const {
        costCenterId,
        costCenterName,
        month, // YYYY-MM
        billId,
        amount,
        description,
        departmentId,
        departmentName,
        departmentCategoryId,
        departmentCategoryName,

        // ✅ NOVO (vem do front)
        installmentNumber,
        installmentsNumber,
      } = req.body;

      if (!costCenterId || !month || amount == null) {
        return res
          .status(400)
          .json({ error: 'costCenterId, month e amount são obrigatórios' });
      }

      // ✅ LOG 1: entrada do controller (antes do service)
      console.log('[ExpenseController.add] body', {
        costCenterId,
        month,
        billId,
        amount,
        installmentNumber,
        installmentsNumber,
        departmentName,
        departmentCategoryId,
      });

      const exp = await this.service.addExpense({
        costCenterId,
        costCenterName,
        competenceMonth: month, // service espera competenceMonth
        billId,
        amount,
        description,
        departmentId,
        departmentName,
        departmentCategoryId,
        departmentCategoryName,

        // ✅ repassa pro service gravar no Expense
        installmentNumber,
        installmentsNumber,
      });

      // ✅ LOG 2: retorno do service (após create)
      console.log('[ExpenseController.add] created', {
        id: exp?.id,
        billId: exp?.bill_id,
        competence_month: exp?.competence_month,
        installment_number: exp?.installment_number,
        installments_number: exp?.installments_number,
        amount: exp?.amount,
      });

      res.json(exp);
    } catch (e) {
      console.error('[ExpenseController.add] error', e);
      res.status(500).send('Erro ao adicionar gastos');
    }
  };

  /** GET /api/expenses?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD[&costCenterId=80001] */
  listMonth = async (req, res) => {
    try {
      const { costCenterId, startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return res
          .status(400)
          .json({ error: 'startDate e endDate são obrigatórios (YYYY-MM-DD)' });
      }

      const data = await this.service.summarizeAllMonth({
        startDate,
        endDate,
        costCenterId: costCenterId ? Number(costCenterId) : undefined,
      });

      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao listar gastos');
    }
  };

  // GET /api/expenses/links?billIds=1,2,3
  listLinks = async (req, res) => {
    try {
      const { billIds } = req.query;
      if (!billIds) {
        return res
          .status(400)
          .json({ error: 'billIds é obrigatório' });
      }

      const ids = billIds
        .split(',')
        .map(n => Number(n))
        .filter(Boolean);

      const data = await this.service.listLinksByBill({ billIds: ids });

      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao listar vínculos de custos');
    }
  };

  // PUT /api/expenses/:id 
  update = async (req, res) => {
    try {
      const { id } = req.params;
      const {
        amount,
        description,
        departmentId,
        departmentName,
        // 👇 NOVO
        departmentCategoryId,
        departmentCategoryName,
      } = req.body;

      const exp = await this.service.updateExpense({
        id: Number(id),
        amount,
        description,
        departmentId,
        departmentName,
        departmentCategoryId,
        departmentCategoryName,
      });

      res.json(exp);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao atualizar gasto');
    }
  };

  remove = async (req, res) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteExpense({ id: Number(id) });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao remover gasto');
    }
  };

}
