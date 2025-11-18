// src/controllers/mktExpenseController.js
import MktExpenseService from '../services/mktExpenseService.js';

export default class MktExpenseController {
  constructor() {
    this.service = new MktExpenseService();
  }

  /** POST /api/mkt/expenses */
  add = async (req, res) => {
    try {
      const { costCenterId, month, billId, amount, description } = req.body;
      if (!costCenterId || !month || !amount) {
        return res.status(400).json({ error: 'costCenterId, month e amount são obrigatórios' });
      }

      const exp = await this.service.addExpense({
        costCenterId,
        competenceMonth: month,
        billId,
        amount,
        description,
      });

      res.json(exp);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao adicionar gasto de MKT');
    }
  }

  /** GET /api/mkt/expenses?month=2025-10[&costCenterId=80001] */
  listMonth = async (req, res) => {
    try {
      const { costCenterId, month } = req.query;
      if (!month) {
        return res.status(400).json({ error: 'month é obrigatório no formato YYYY-MM' });
      }

      // se informou centro de custo -> comportamento antigo (um CC só)
      if (costCenterId) {
        const data = await this.service.summarizeMonth({
          costCenterId: Number(costCenterId),
          competenceMonth: month,
        });
        return res.json(data);
      }

      // 🔹 se NÃO informou -> traz todos agrupados
      const data = await this.service.summarizeAllMonth({
        competenceMonth: month,
      });

      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao listar gastos de MKT');
    }
  }
}
