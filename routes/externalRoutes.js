// routes/externalRoutes.js
import express from 'express';
import landDataController from '../controllers/external/landDataController.js';

const router = express.Router();
const ctl = new landDataController();

router.post('/land/sync', (req, res) => ctl.run(req, res));

export default router;
