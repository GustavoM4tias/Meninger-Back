// routes/admin.js (TEMPORÁRIO – remova depois)
import express from 'express';
import db from '../models/sequelize/index.js'; 

const router = express.Router();

router.post('/admin/drop-legacy-sienge', async (req, res) => {
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

export default router;
