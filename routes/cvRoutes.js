import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import db from '../models/sequelize/index.js';

import { fetchRepasses, fetchRepasseWorkflow } from '../controllers/cv/repasses.js'
import { fetchReservas, fetchReservaPagamentos, fetchReservaWorkflow } from '../controllers/cv/reservas.js'
import { fetchEmpreendimentos, fetchBuildings, fetchBuildingById } from '../controllers/cv/empreendimentos.js'
import { fetchFilas, getLeads } from '../controllers/cv/leads.js'
import { fetchBanners } from '../controllers/cv/banner.js'

import bulkDataController from '../services/bulkData/cv/bulkDataController.js';
import RepassesSyncController from '../controllers/cv/repassesSyncController.js';
import ReservasSyncController from '../controllers/cv/reservasSyncController.js';

import { fetchBuildingsFromDb, fetchBuildingByIdFromDb, fetchBuildingUnitsSummaryFromDb } from '../controllers/cv/empreendimentosDb.js';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

import { fetchWorkflowGroups, createOrUpdateWorkflowGroup, removeWorkflowGroup, fetchListSegments  } from '../controllers/cv/workflowGroups.js';
// routes/cvRoutes.js
import { fetchGroupProjections } from '../controllers/cv/workflowGroupQueries.js';

import PriceTableSyncService from '../services/bulkData/cv/PriceTableSyncService.js';
import RealtorSyncService from '../services/bulkData/cv/RealtorSyncService.js';
import CorrespondentSyncService from '../services/bulkData/cv/CorrespondentSyncService.js';

const router = express.Router();
const cvLeads = new bulkDataController();
const cvRepasses = new RepassesSyncController();
const cvReservas = new ReservasSyncController();
const cvEnterprises = new EnterprisesSyncController();

router.get('/repasses', authenticate, fetchRepasses);
router.get('/repasse-workflow', authenticate, fetchRepasseWorkflow);

router.get('/reservas', authenticate, fetchReservas);
// ⬇️ NOVO: workflow de reservas + grupos paralelos
router.get('/reserva-workflow', authenticate, fetchReservaWorkflow)
router.get('/reserva-pagamentos', authenticate, fetchReservaPagamentos);

router.get('/listagem-empreendimentos', authenticate, fetchEmpreendimentos);
// router.get('/empreendimentos', authenticate, fetchBuildings);
// router.get('/empreendimento/:id', authenticate, fetchBuildingById);
router.get('/filas', authenticate, fetchFilas);
router.get('/banners', fetchBanners);

router.post('/leads/sync/full', authenticate, cvLeads.fullSync.bind(cvLeads));
router.post('/leads/sync/delta', authenticate, cvLeads.deltaSync.bind(cvLeads));
router.post('/leads/sync/cancel-reasons', authenticate, cvLeads.cancelReasonSync.bind(cvLeads));

router.get('/leads', authenticate, getLeads);

// NOVO: Repasses (backup + histórico)
router.post('/repasses/sync/full', authenticate, cvRepasses.fullSync.bind(cvRepasses));
router.post('/repasses/sync/delta', authenticate, cvRepasses.deltaSync.bind(cvRepasses));

// NOVO: Reservas (backup + histórico por status de repasse)
router.post('/reservas/sync/full', authenticate, cvReservas.fullSync.bind(cvReservas));
router.post('/reservas/sync/delta', authenticate, cvReservas.deltaSync.bind(cvReservas));

router.post('/empreendimentos/sync/full', authenticate, cvEnterprises.fullSync.bind(cvEnterprises));
router.post('/empreendimentos/sync/delta', authenticate, cvEnterprises.deltaSync.bind(cvEnterprises));

router.get('/empreendimentos', authenticate, fetchBuildingsFromDb);
router.get('/empreendimento/:id', authenticate, fetchBuildingByIdFromDb);
router.get('/empreendimento/:id/unidades', authenticate, fetchBuildingUnitsSummaryFromDb);

router.get('/workflow-grupos', authenticate, fetchWorkflowGroups);
// ?tipo=repasses
router.post('/workflow-grupos', authenticate, createOrUpdateWorkflowGroup);
router.delete('/workflow-grupos/:id', authenticate, removeWorkflowGroup);
router.get('/workflow-grupos/segments', fetchListSegments);
// ...
router.get('/workflow-grupos/:id/projecoes', authenticate, fetchGroupProjections);

// ─── Sync extras ──────────────────────────────────────────────────────────────
router.post('/price-tables/sync', authenticate, async (req, res) => {
    try {
        const svc = new PriceTableSyncService();
        await svc.syncAll();
        return res.json({ ok: true, message: 'Sync de tabelas de preço concluído.' });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

router.post('/price-tables/sync/:idempreendimento', authenticate, async (req, res) => {
    try {
        const svc = new PriceTableSyncService();
        const n = await svc.syncForEnterprise(Number(req.params.idempreendimento));
        return res.json({ ok: true, synced: n });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// Debug: inspeciona resposta bruta do CV + o que está no banco
router.get('/price-tables/debug/:idempreendimento', authenticate, async (req, res) => {
    const eid = Number(req.params.idempreendimento);
    try {
        const apiCv = (await import('../lib/apiCv.js')).default;

        // 1) Chama o CV
        let cvStatus, cvData, cvError;
        try {
            const result = await apiCv.get(
                `/v1/cadastros/empreendimentos/${eid}/tabelasdepreco/detalhada`,
                { params: { resetar: 'S', tabelasemjson: true, aprovado: 'S' } }
            );
            cvStatus = result.status;
            cvData   = result.data;
        } catch (e) {
            cvStatus = e?.response?.status ?? 0;
            cvError  = { message: e?.message, response: e?.response?.data };
        }

        // 2) Analisa a resposta
        const rawLinks   = Array.isArray(cvData?.links)   ? cvData.links   :
                           Array.isArray(cvData?.dados)   ? cvData.dados   :
                           Array.isArray(cvData?.tabelas) ? cvData.tabelas :
                           Array.isArray(cvData?.data)    ? cvData.data    : null;

        const httpLinks  = rawLinks?.filter(l => typeof l === 'string' && l.startsWith('http')) ?? [];
        const textLinks  = rawLinks?.filter(l => typeof l === 'string' && !l.startsWith('http')) ?? [];

        // 3) O que está no banco atualmente
        const { CvEnterprisePriceTable } = db;
        const tablesInDb = await CvEnterprisePriceTable.findAll({
            where: { idempreendimento: eid },
            attributes: ['idtabela', 'nome', 'ativo_painel', 'aprovado', 'data_vigencia_de', 'data_vigencia_ate', 'content_hash'],
            order: [['idtabela', 'ASC']],
        });

        return res.json({
            empreendimento: eid,
            cv: {
                status: cvStatus,
                error: cvError ?? null,
                topLevelKeys: cvData ? Object.keys(cvData) : null,
                linksFieldDetected: rawLinks ? (
                    cvData?.links !== undefined ? 'links' :
                    cvData?.dados !== undefined ? 'dados' :
                    cvData?.tabelas !== undefined ? 'tabelas' : 'data'
                ) : null,
                totalItems:  rawLinks?.length ?? 0,
                httpLinks:   httpLinks.length,
                textLinks:   textLinks.length,
                httpSample:  httpLinks.slice(0, 3),
                textSample:  textLinks.slice(0, 5),
                rawDataSample: cvData,   // resposta completa (cuidado: pode ser grande)
            },
            banco: {
                totalTabelas: tablesInDb.length,
                tabelas: tablesInDb.map(t => t.toJSON()),
            },
        });
    } catch (e) {
        return res.status(500).json({ error: e?.message, stack: e?.stack });
    }
});

router.post('/correspondents/sync', authenticate, async (req, res) => {
    try {
        const svc = new CorrespondentSyncService();
        const n = await svc.syncAll();
        return res.json({ ok: true, synced: n });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

export default router;