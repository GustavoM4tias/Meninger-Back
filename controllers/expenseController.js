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
        month,
        billId,
        amount,
        description,
        departmentId,
        departmentName,
      } = req.body;

      if (!costCenterId || !month || !amount) {
        return res
          .status(400)
          .json({ error: 'costCenterId, month e amount são obrigatórios' });
      }

      const exp = await this.service.addExpense({
        costCenterId,
        costCenterName,
        competenceMonth: month,
        billId,
        amount,
        description,
        departmentId,
        departmentName,
      });

      res.json(exp);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao adicionar gastos');
    }
  };

  /** GET /api/expenses?month=2025-10[&costCenterId=80001] */
  listMonth = async (req, res) => {
    try {
      const { costCenterId, month } = req.query;
      if (!month) {
        return res
          .status(400)
          .json({ error: 'month é obrigatório no formato YYYY-MM' });
      }

      if (costCenterId) {
        const data = await this.service.summarizeMonth({
          costCenterId: Number(costCenterId),
          competenceMonth: month,
        });
        return res.json(data);
      }

      const data = await this.service.summarizeAllMonth({
        competenceMonth: month,
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
      res.status(500).send('Erro ao listar vínculos de custas');
    }
  };

  // PUT /api/expenses/:id
  update = async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, description, departmentId, departmentName } = req.body;

      const exp = await this.service.updateExpense({
        id: Number(id),
        amount,
        description,
        departmentId,
        departmentName,
      });

      res.json(exp);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao atualizar gasto');
    }
  };

  // DELETE /api/expenses/:id
  remove = async (req, res) => {
    try {
      const { id } = req.params;
      await this.service.deleteExpense({ id: Number(id) });
      res.json({ success: true });
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao remover gasto');
    }
  };
}
