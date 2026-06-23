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

  // GET /api/expenses/links?billIds=1,2,3
  listLinks = async (req, res) => {
    try {
      const { billIds } = req.query;
      if (!billIds) {
        return res.status(400).json({ error: 'billIds é obrigatório' });
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

  // PUT /api/expenses/:id  (id sintético "<nutitulo>-<nuparcela>")
  // Edita só categoria + observação (personalização). Departamento vem do Sienge.
  update = async (req, res) => {
    try {
      const { id } = req.params;
      const { description, departmentCategoryId, departmentCategoryName } = req.body;

      const exp = await this.service.updateExpense({
        id,
        description,
        departmentCategoryId,
        departmentCategoryName,
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
