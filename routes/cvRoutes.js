import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import db from '../models/sequelize/index.js';

import { fetchRepasses, fetchRepasseWorkflow } from '../controllers/cv/repasses.js'
import { fetchReservas, fetchReservaPagamentos, fetchReservaWorkflow } from '../controllers/cv/reservas.js'
import { fetchEmpreendimentos, fetchBuildings, fetchBuildingById } from '../controllers/cv/empreendimentos.js'
import { fetchFilas, getLeads } from '../controllers/cv/leads.js'
import { fetchBanners } from '../controllers/cv/banner.js'

import bulkDataController from '../services/bulkData/cv/bulkDataController.js';
import RepassesSyncController from '../controllers/cv/repassesSyncController.js';
import ReservasSyncController from '../controllers/cv/reservasSyncController.js';
import PrecadastrosSyncController from '../controllers/cv/precadastrosSyncController.js';
import { listPrecadastros, getPrecadastro } from '../controllers/cv/precadastros.js';
import { listReservasReport, getReservaReport } from '../controllers/cv/reservasReport.js';

import { fetchBuildingsFromDb, fetchBuildingByIdFromDb, fetchBuildingUnitsSummaryFromDb } from '../controllers/cv/empreendimentosDb.js';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

import { fetchWorkflowGroups, createOrUpdateWorkflowGroup, removeWorkflowGroup, fetchListSegments  } from '../controllers/cv/workflowGroups.js';
// routes/cvRoutes.js
import { fetchGroupProjections } from '../controllers/cv/workflowGroupQueries.js';

import PriceTableSyncService from '../services/bulkData/cv/PriceTableSyncService.js';
import RealtorSyncService from '../services/bulkData/cv/RealtorSyncService.js';
import CorrespondentSyncService from '../services/bulkData/cv/CorrespondentSyncService.js';
import { RELATORIO_SCREENS } from '../lib/relatorioScreens.js';

const router = express.Router();
const cvLeads = new bulkDataController();
const cvRepasses = new RepassesSyncController();
const cvReservas = new ReservasSyncController();
const cvEnterprises = new EnterprisesSyncController();
const cvPrecadastros = new PrecadastrosSyncController();

// ── Alçadas por tela (requireRoutePermission) ─────────────────────────────────
// Cada endpoint exige que o usuário tenha AO MENOS UMA das telas que o
// consomem. Admin tem bypass. Endpoints de sync manual são admin-only (o cron
// roda em processo pelos schedulers).
// Ação `sync` da tela de Empreendimentos (lib/screenCapabilities.js).
const sincronizarTabelas = requireCapability('/comercial/buildings', 'sync');

const WORKFLOW_SCREENS = ['/comercial/workflow/groups', ...RELATORIO_SCREENS, '/validator'];
const ENTERPRISE_SCREENS = ['/comercial/buildings', '/comercial/conditions', '/comercial/projections', ...RELATORIO_SCREENS, '/comercial/reservas-report', '/comercial/precadastros', '/marketing/plano-eventos'];

router.get('/repasses', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchRepasses);
router.get('/repasse-workflow', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchRepasseWorkflow);

router.get('/reservas', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchReservas);
// ⬇️ NOVO: workflow de reservas + grupos paralelos
router.get('/reserva-workflow', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchReservaWorkflow)
router.get('/reserva-pagamentos', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchReservaPagamentos);

router.get('/listagem-empreendimentos', authenticate, requireRoutePermission([...ENTERPRISE_SCREENS, '/marketing/leads']), fetchEmpreendimentos);
router.get('/filas', authenticate, requireRoutePermission(['/marketing/leads']), fetchFilas);
// PÚBLICO de propósito: os banners aparecem na TELA DE LOGIN (usuário ainda
// não autenticado). Só imagens/links de campanha — sem dado de negócio.
// Registrado na allowlist do validador de integridade.
router.get('/banners', fetchBanners);

router.post('/leads/sync/full', authenticate, requireAdmin, cvLeads.fullSync.bind(cvLeads));
router.post('/leads/sync/delta', authenticate, requireAdmin, cvLeads.deltaSync.bind(cvLeads));
router.post('/leads/sync/cancel-reasons', authenticate, requireAdmin, cvLeads.cancelReasonSync.bind(cvLeads));

router.get('/leads', authenticate, requireRoutePermission(['/marketing/leads']), getLeads);

// NOVO: Repasses (backup + histórico)
router.post('/repasses/sync/full', authenticate, requireAdmin, cvRepasses.fullSync.bind(cvRepasses));
router.post('/repasses/sync/delta', authenticate, requireAdmin, cvRepasses.deltaSync.bind(cvRepasses));

// NOVO: Reservas (backup + histórico por status de repasse)
router.post('/reservas/sync/full', authenticate, requireAdmin, cvReservas.fullSync.bind(cvReservas));
router.post('/reservas/sync/delta', authenticate, requireAdmin, cvReservas.deltaSync.bind(cvReservas));
// VARREDURA ID-A-ID (manual): pega reservas que a listagem global oculta
// (Cancelada/Vencida/Distrato). Aceita body { fromId, toId, skipDead }.
router.post('/reservas/sync/full-sweep', authenticate, requireAdmin, cvReservas.fullSweep.bind(cvReservas));

router.post('/empreendimentos/sync/full', authenticate, requireAdmin, cvEnterprises.fullSync.bind(cvEnterprises));
router.post('/empreendimentos/sync/delta', authenticate, requireAdmin, cvEnterprises.deltaSync.bind(cvEnterprises));

// NOVO: Pré-cadastros (backup completo: listar + documentos + mensagens)
router.post('/precadastros/sync/full', authenticate, requireAdmin, cvPrecadastros.fullSync.bind(cvPrecadastros));
router.post('/precadastros/sync/delta', authenticate, requireAdmin, cvPrecadastros.deltaSync.bind(cvPrecadastros));
router.get('/precadastros', authenticate, requireRoutePermission(['/comercial/precadastros']), listPrecadastros);
router.get('/precadastros/:id', authenticate, requireRoutePermission(['/comercial/precadastros']), getPrecadastro);

// Reservas — relatório (lê do banco, não confundir com `GET /reservas` que é read-through na API CV)
router.get('/reservas/report', authenticate, requireRoutePermission(['/comercial/reservas-report']), listReservasReport);
router.get('/reservas/report/:id', authenticate, requireRoutePermission(['/comercial/reservas-report']), getReservaReport);

router.get('/empreendimentos', authenticate, requireRoutePermission(ENTERPRISE_SCREENS), fetchBuildingsFromDb);
router.get('/empreendimento/:id', authenticate, requireRoutePermission(ENTERPRISE_SCREENS), fetchBuildingByIdFromDb);
router.get('/empreendimento/:id/unidades', authenticate, requireRoutePermission(ENTERPRISE_SCREENS), fetchBuildingUnitsSummaryFromDb);

router.get('/workflow-grupos', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchWorkflowGroups);
// ?tipo=repasses
router.post('/workflow-grupos', authenticate, requireRoutePermission(['/comercial/workflow/groups']), createOrUpdateWorkflowGroup);
router.delete('/workflow-grupos/:id', authenticate, requireRoutePermission(['/comercial/workflow/groups']), removeWorkflowGroup);
router.get('/workflow-grupos/segments', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchListSegments);
// ...
router.get('/workflow-grupos/:id/projecoes', authenticate, requireRoutePermission(WORKFLOW_SCREENS), fetchGroupProjections);

// ─── Sync extras ──────────────────────────────────────────────────────────────
router.post('/price-tables/sync', authenticate, sincronizarTabelas, async (req, res) => {
    try {
        const svc = new PriceTableSyncService();
        await svc.syncAll();
        return res.json({ ok: true, message: 'Sync de tabelas de preço concluído.' });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

router.post('/price-tables/sync/:idempreendimento', authenticate, sincronizarTabelas, async (req, res) => {
    try {
        const svc = new PriceTableSyncService();
        const n = await svc.syncForEnterprise(Number(req.params.idempreendimento));
        return res.json({ ok: true, synced: n });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// Debug: inspeciona resposta bruta do CV + o que está no banco
router.get('/price-tables/debug/:idempreendimento', authenticate, sincronizarTabelas, async (req, res) => {
    const eid = Number(req.params.idempreendimento);
    try {
        const apiCv = (await import('../lib/apiCv.js')).default;

        // 1) Chama o CV
        let cvStatus, cvData, cvError;
        try {
            const result = await apiCv.get(
                `/v1/cadastros/empreendimentos/${eid}/tabelasdepreco/detalhada`,
                { params: { resetar: 'S', tabelasemjson: true } }
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

router.post('/correspondents/sync', authenticate, requireAdmin, async (req, res) => {
    try {
        const svc = new CorrespondentSyncService();
        const n = await svc.syncAll();
        return res.json({ ok: true, synced: n });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

export default router;