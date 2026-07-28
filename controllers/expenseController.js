// src/controllers/expenseController.js
import expenseService from '../services/expenseService.js';

export default class expenseController {

  constructor() {
    this.service = new expenseService();
  }

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
        user: req.user,
      });

      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao listar gastos');
    }
  };

  // PUT /api/expenses/:id  (id sintético "<nutitulo>-<nuparcela>")
  // Edita só a observação (personalização). Departamento vem do Sienge.
  update = async (req, res) => {
    try {
      const { id } = req.params;
      const { description } = req.body;

      const exp = await this.service.updateExpense({
        id,
        description,
        updatedBy: req.user?.name || req.user?.email || null,
      });

      res.json(exp);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao atualizar gasto');
    }
  };

  // DELETE /api/expenses/:id  → limpa a personalização daquela parcela
  remove = async (req, res) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteExpense({ id });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao remover gasto');
    }
  };

}
