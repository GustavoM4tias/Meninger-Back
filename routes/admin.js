// routes/admin.js
import express from 'express';
import db from '../models/sequelize/index.js';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
  syncCRM, syncERP, listCities, setOverride, resolveCityController
} from '../controllers/enterpriseCities.js';

import {
  listPositions,
  createPosition,
  updatePosition,
  deletePosition,
} from '../controllers/positionController.js';

import {
  listUserCities,
  createUserCity,
  updateUserCity,
  deleteUserCity,
} from '../controllers/userCityController.js';

import {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from '../controllers/departmentController.js';

import {
  listDepartmentCategories,
  createDepartmentCategory,
  updateDepartmentCategory,
  deleteDepartmentCategory,
} from '../controllers/departmentCategoryController.js';

const router = express.Router();

router.post('/admin/drop-legacy-sienge', authMiddleware, async (req, res) => {
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

// enterprise-cities
router.post('/enterprise-cities/sync/crm', authMiddleware, syncCRM);
router.post('/enterprise-cities/sync/erp', authMiddleware, syncERP);
router.get('/enterprise-cities', authMiddleware, listCities);
router.put('/enterprise-cities/:id/override', authMiddleware, setOverride);
router.get('/enterprise-cities/resolve', authMiddleware, resolveCityController);

// Positions (cargos) – APENAS ADMIN
router.get('/positions', authMiddleware, requireAdmin, listPositions);
router.post('/positions', authMiddleware, requireAdmin, createPosition);
router.put('/positions/:id', authMiddleware, requireAdmin, updatePosition);
router.delete('/positions/:id', authMiddleware, requireAdmin, deletePosition);

// UserCities (cidades) – APENAS ADMIN
router.get('/user-cities', authMiddleware, requireAdmin, listUserCities);
router.post('/user-cities', authMiddleware, requireAdmin, createUserCity);
router.put('/user-cities/:id', authMiddleware, requireAdmin, updateUserCity);
router.delete('/user-cities/:id', authMiddleware, requireAdmin, deleteUserCity);

// Departments – APENAS ADMIN
router.get('/departments', authMiddleware, requireAdmin, listDepartments);
router.post('/departments', authMiddleware, requireAdmin, createDepartment);
router.put('/departments/:id', authMiddleware, requireAdmin, updateDepartment);
router.delete('/departments/:id', authMiddleware, requireAdmin, deleteDepartment);

// Department Categories – APENAS ADMIN
router.get('/department-categories', authMiddleware, requireAdmin, listDepartmentCategories);
router.post('/department-categories', authMiddleware, requireAdmin, createDepartmentCategory);
router.put('/department-categories/:id', authMiddleware, requireAdmin, updateDepartmentCategory);
router.delete('/department-categories/:id', authMiddleware, requireAdmin, deleteDepartmentCategory);

export default router;
