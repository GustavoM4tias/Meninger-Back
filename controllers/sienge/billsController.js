// src/controllers/sienge/billsController.js
import BillsService from '../../services/sienge/billsService.js';
import db from '../../models/sequelize/index.js';

// helper de normalização de cidade igual aos outros controllers
const CITY_EQ = (col) => `
  unaccent(upper(regexp_replace(${col}, '[^A-Z0-9]+',' ','g')))
`;

export default class BillsController {
    constructor() {
        this.service = new BillsService();
        this.isRunning = false;
    }

    /**
     * GET /api/sienge/bills
     * Exemplo:
     *   /api/sienge/bills?costCenterId=80001&startDate=2025-08-01&endDate=2025-10-31&debtorId=80
     *
     * Regras:
     * - 🔒 Requer usuário autenticado (middleware authenticate na rota)
     * - admin  → pode consultar qualquer costCenterId
     * - não-admin → só pode consultar costCenterId mapeado para sua cidade em enterprise_cities (source='erp')
     */
    // src/controllers/sienge/billsController.js
    list = async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Usuário não autenticado.' });
            }

            const { costCenterId, startDate, endDate, debtorId } = req.query;

            if (!costCenterId) {
                return res.status(400).json({ error: 'costCenterId é obrigatório' });
            }

            // 👇 aceita "80001" ou "80001,80002,83001"
            const ids = String(costCenterId)
                .split(',')
                .map(v => Number(v.trim()))
                .filter(n => Number.isFinite(n));

            if (!ids.length) {
                return res.status(400).json({ error: 'costCenterId inválido.' });
            }

            if (ids.length > 3) {
                return res.status(400).json({ error: 'Máximo de 3 centros de custo por consulta.' });
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

            // ✅ chama o service para cada centro de custo e concatena resultados
            let allRows = [];

            for (const id of ids) {
                const rows = await this.service.listFromSiengeWithDepartments({
                    costCenterId: id,
                    startDate,
                    endDate,
                    debtorId: debtorId ? Number(debtorId) : undefined,
                });
                allRows = allRows.concat(rows);
            }

            return res.json(allRows);
        } catch (e) {
            console.error('❌ [BillsController] Erro ao listar títulos');
            console.error('   Mensagem:', e?.message);
            console.error('   Response status:', e?.response?.status);
            console.error('   Response data:', e?.response?.data);

            const status = e.response?.status || 500;
            const providerMsg =
                e.response?.data?.clientMessage ||
                e.response?.data?.developerMessage ||
                e.response?.data?.message ||
                e.response?.data?.error ||
                e.message;

            return res.status(status).json({
                error: providerMsg || 'Erro ao listar títulos do Sienge',
            });
        }
    };

    /**
     * (opcional) POST /api/sienge/bills/sync
     * Pode ser usada para sincronização em lote, se você ainda quiser manter.
     * Também segue regra de cidade para não-admin.
     */
    sync = async (req, res) => {
        // precisa estar autenticado
        if (!req.user) {
            return res.status(401).json({ error: 'Usuário não autenticado.' });
        }

        const isAdmin = req.user.role === 'admin';

        if (this.isRunning) {
            return res.status(429).send('Já em execução');
        }

        this.isRunning = true;

        try {
            const { costCenterId, startDate, endDate, debtorId } = req.body;

            if (!costCenterId || !startDate || !endDate) {
                return res.status(400).json({
                    error: 'costCenterId, startDate e endDate são obrigatórios'
                });
            }

            // não-admin também precisa estar autorizado pela cidade
            if (!isAdmin) {
                const userCity = (req.user.city || '').trim();

                if (!userCity) {
                    return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
                }

                const sql = `
          SELECT 1
          FROM enterprise_cities ec
          WHERE ec.erp_id IS NOT NULL
            AND ec.erp_id::int = :costCenterId
            AND ${CITY_EQ(`COALESCE(ec.city_override, ec.default_city)`)} = ${CITY_EQ(`:userCity`)}
          LIMIT 1;
        `;

                const rows = await db.sequelize.query(sql, {
                    replacements: {
                        costCenterId: Number(costCenterId),
                        userCity
                    },
                    type: db.Sequelize.QueryTypes.SELECT,
                });

                if (!rows.length) {
                    return res.status(403).json({ error: 'Centro de custo não permitido para sua cidade.' });
                }
            }

            const count = await this.service.syncBills({
                costCenterId,
                startDate,
                endDate,
                debtorId,
            });

            return res.json({ synced: count });
        } catch (e) {
            console.error('❌ [BillsController] Erro ao sincronizar títulos');
            console.error('   Mensagem:', e?.message);
            console.error('   Response status:', e?.response?.status);
            console.error('   Response data:', e?.response?.data);

            const status = e.response?.status || 500;
            const providerMsg =
                e.response?.data?.clientMessage ||
                e.response?.data?.developerMessage ||
                e.response?.data?.message ||
                e.response?.data?.error ||
                e.message;

            return res.status(status).json({
                error: providerMsg || 'Erro ao sincronizar títulos do Sienge',
            });
        } finally {
            this.isRunning = false;
        }
    };
}
