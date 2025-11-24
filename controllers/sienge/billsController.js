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
    list = async (req, res) => {
        try {
            // precisa do usuário autenticado (middleware deve ter preenchido req.user)
            if (!req.user) {
                return res.status(401).json({ error: 'Usuário não autenticado.' });
            }

            const { costCenterId, startDate, endDate, debtorId } = req.query;

            if (!costCenterId) {
                return res.status(400).json({ error: 'costCenterId é obrigatório' });
            }

            const isAdmin = req.user.role === 'admin';

            // 🔒 Não-admin: restringe por cidade (enterprise_cities.source = 'erp')
            if (!isAdmin) {
                const userCity = (req.user.city || '').trim();

                if (!userCity) {
                    return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
                }

                const sql = `
          SELECT 1
          FROM enterprise_cities ec
          WHERE ec.source = 'erp'
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

            // ✅ Passou na validação → chama service (que fala com o Sienge)
            const rows = await this.service.listFromSiengeWithDepartments({
                costCenterId: Number(costCenterId),
                startDate,
                endDate,
                debtorId: debtorId ? Number(debtorId) : undefined,
            });

            return res.json(rows);
        } catch (e) {
            // Log bem detalhado pra debug
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
          WHERE ec.source = 'erp'
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
