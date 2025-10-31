// routes/admin.js (TEMPORÁRIO – remova depois)
import express from 'express';
import db from '../models/sequelize/index.js'; 
import authenticate from '../middlewares/authMiddleware.js';
import {
  syncCRM, syncERP, listCities, setOverride, resolveCityController
} from '../controllers/enterpriseCities.js';

const router = express.Router();

router.post('/admin/drop-legacy-sienge', authenticate, async (req, res) => {
    try {
        const sql = ` 
      DROP VIEW  IF EXISTS sales_contracts_v; 
 
      DROP TABLE IF EXISTS sales_contracts; 
    `;
        await db.sequelize.query(sql);
        return res.json({ ok: true, message: 'Tabelas/Views antigas removidas.' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

router.post('/enterprise-cities/sync/crm', authenticate, syncCRM);
router.post('/enterprise-cities/sync/erp', authenticate, syncERP);
router.get('/enterprise-cities', authenticate, listCities);
router.put('/enterprise-cities/:id/override', authenticate, setOverride);
router.get('/enterprise-cities/resolve', authenticate, resolveCityController);

export default router;
