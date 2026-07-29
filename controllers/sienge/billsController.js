// src/controllers/sienge/billsController.js
//
// Tela "Títulos" — agora lê AO VIVO do backup do Sienge (payableLiveService),
// não mais da API/Auto-Sync. Mantém a regra de permissão por escopo para não-admin.
import { listBills } from '../../services/sienge/payableLiveService.js';
import { getScope, isErpAllowed } from '../../services/permissions/accessScopeService.js';

export default class BillsController {
    /**
     * GET /api/sienge/bills?costCenterId=80001,80002&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD[&debtorId=80]
     *
     * Regras:
     * - 🔒 Requer usuário autenticado (middleware authenticate na rota)
     * - admin  → pode consultar qualquer costCenterId
     * - não-admin → só pode consultar costCenterId dentro do seu escopo de
     *   acesso (accessScopeService/isErpAllowed, cobre sub-CC 80104 → 80001)
     */
    list = async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Usuário não autenticado.' });
            }

            const { costCenterId, startDate, endDate, debtorId } = req.query;

            if (!costCenterId) {
                return res.status(400).json({ error: 'costCenterId é obrigatório' });
            }

            // aceita "80001" ou "80001,80002,83001"
            const ids = String(costCenterId)
                .split(',')
                .map(v => Number(v.trim()))
                .filter(n => Number.isFinite(n));

            if (!ids.length) {
                return res.status(400).json({ error: 'costCenterId inválido.' });
            }

            const scope = await getScope(req.user);

            if (!scope.all) {
                // fail-closed: escopo vazio → resultado vazio (sem erro)
                if (!scope.erpIds.length) {
                    return res.json([]);
                }

                // valida **cada** centro de custo pedido contra o escopo
                const denied = ids.filter(id => !isErpAllowed(scope, id));

                if (denied.length) {
                    return res.status(403).json({
                        error: `Centro(s) de custo fora do seu escopo: ${denied.join(', ')}`,
                    });
                }
            }

            const rows = await listBills({
                costCenterIds: ids,
                startDate,
                endDate,
                debtorId: debtorId ? Number(debtorId) : undefined,
            });

            return res.json(rows);
        } catch (e) {
            console.error('❌ [BillsController] Erro ao listar títulos:', e?.message);
            return res.status(500).json({
                error: e?.message || 'Erro ao listar títulos do Sienge',
            });
        }
    };
}
