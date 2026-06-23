// src/controllers/sienge/billsController.js
//
// Tela "Títulos" — agora lê AO VIVO do backup do Sienge (payableLiveService),
// não mais da API/Auto-Sync. Mantém a regra de permissão por cidade para não-admin.
import { listBills } from '../../services/sienge/payableLiveService.js';
import db from '../../models/sequelize/index.js';

// helper de normalização de cidade igual aos outros controllers
const CITY_EQ = (col) => `
  unaccent(upper(regexp_replace(${col}, '[^A-Z0-9]+',' ','g')))
`;

export default class BillsController {
    /**
     * GET /api/sienge/bills?costCenterId=80001,80002&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD[&debtorId=80]
     *
     * Regras:
     * - 🔒 Requer usuário autenticado (middleware authenticate na rota)
     * - admin  → pode consultar qualquer costCenterId
     * - não-admin → só pode consultar costCenterId mapeado para sua cidade em enterprise_cities
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

            const isAdmin = req.user.role === 'admin';

            if (!isAdmin) {
                const userCity = (req.user.city || '').trim();

                if (!userCity) {
                    return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
                }

                // valida **cada** centro de custo para a cidade do user
                const sql = `
        SELECT DISTINCT ec.erp_id::int AS id
        FROM enterprise_cities ec
        WHERE ec.erp_id IS NOT NULL
          AND ec.erp_id::int = ANY(:ids)
          AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
      `;

                const rows = await db.sequelize.query(sql, {
                    replacements: { ids, userCity },
                    type: db.Sequelize.QueryTypes.SELECT,
                });

                const allowed = new Set(rows.map(r => r.id));
                const denied = ids.filter(id => !allowed.has(id));

                if (denied.length) {
                    return res.status(403).json({
                        error: `Centro(s) de custo não permitido(s) para sua cidade: ${denied.join(', ')}`,
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
