// routes/microsoftAuthRoutes.js
import express from 'express';
import MicrosoftAuthController from '../controllers/microsoft/MicrosoftAuthController.js';
import MicrosoftSharepointController from '../controllers/microsoft/MicrosoftSharepointController.js';
import MicrosoftTeamsController from '../controllers/microsoft/MicrosoftTeamsController.js';
import MicrosoftTranscriptController from '../controllers/microsoft/MicrosoftTranscriptController.js';
import MicrosoftOrgUsersController from '../controllers/microsoft/MicrosoftOrgUsersController.js';
import MicrosoftPlannerController from '../controllers/microsoft/MicrosoftPlannerController.js';
import InPersonMeetingController from '../controllers/InPersonMeetingController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();
const authController = new MicrosoftAuthController();
const sharepointController = new MicrosoftSharepointController();
const teamsController = MicrosoftTeamsController;

// ── Auth: Públicas ────────────────────────────────────────────────────────────
router.get('/auth/login', authController.login);
router.get('/auth/callback', authController.callback);

// ── Auth: Autenticadas ────────────────────────────────────────────────────────
router.get('/auth/status', authenticate, authController.status);
router.post('/auth/refresh', authenticate, authController.refresh);
router.delete('/auth/unlink', authenticate, authController.unlink);

// ── Gestão de Usuários da Org Microsoft (admin only) ─────────────────────────
router.get('/org-users',        authenticate, requireAdmin, MicrosoftOrgUsersController.listOrgUsers);
router.post('/org-users/import', authenticate, requireAdmin, MicrosoftOrgUsersController.importOrgUsers);

// ── Planner ───────────────────────────────────────────────────────────────────
const pc = MicrosoftPlannerController;
router.get('/planner/groups',                               authenticate, pc.getGroups);
router.get('/planner/groups/:groupId/plans',                authenticate, pc.getGroupPlans);
router.get('/planner/plans/:planId/full',                   authenticate, pc.getPlanFull);
router.post('/planner/plans',                               authenticate, pc.createPlan);
router.patch('/planner/plans/:planId',                      authenticate, pc.updatePlan);
router.delete('/planner/plans/:planId',                     authenticate, pc.deletePlan);
router.post('/planner/buckets',                             authenticate, pc.createBucket);
router.patch('/planner/buckets/:bucketId',                  authenticate, pc.updateBucket);
router.delete('/planner/buckets/:bucketId',                 authenticate, pc.deleteBucket);
router.post('/planner/tasks',                               authenticate, pc.createTask);
router.patch('/planner/tasks/:taskId',                      authenticate, pc.updateTask);
router.delete('/planner/tasks/:taskId',                     authenticate, pc.deleteTask);
router.get('/planner/tasks/:taskId/details',                authenticate, pc.getTaskDetails);
router.patch('/planner/tasks/:taskId/details',              authenticate, pc.updateTaskDetails);

// ── SharePoint: Leitura ───────────────────────────────────────────────────────
router.get('/sharepoint/sites', authenticate, sharepointController.sites);
router.get('/sharepoint/sites/:siteId/drives', authenticate, sharepointController.drives);
router.get('/sharepoint/drives/:driveId/root', authenticate, sharepointController.driveRoot);
router.get('/sharepoint/drives/:driveId/items/:itemId/children', authenticate, sharepointController.folderChildren);
router.get('/sharepoint/drives/:driveId/items/:itemId/content', authenticate, sharepointController.itemContent);
router.get('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.item);
router.get('/sharepoint/drives/:driveId/search', authenticate, sharepointController.search);

// ── SharePoint: Escrita ───────────────────────────────────────────────────────
router.delete('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.deleteItem);
router.patch('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.updateItem);
router.post('/sharepoint/drives/:driveId/items/:itemId/link', authenticate, sharepointController.createLink);
router.put(
    '/sharepoint/drives/:driveId/folders/:folderId/upload/:filename',
    authenticate,
    express.raw({ type: '*/*', limit: '100mb' }),
    sharepointController.upload
);

// ── Teams / Calendário ────────────────────────────────────────────────────────
router.get('/teams/calendar',                           authenticate, teamsController.calendarView.bind(teamsController));
router.get('/teams/events/:eventId',                    authenticate, teamsController.event.bind(teamsController));
router.post('/teams/meetings',                          authenticate, teamsController.createScheduledMeeting.bind(teamsController));
router.post('/teams/meetings/instant',                  authenticate, teamsController.createInstantMeeting.bind(teamsController));
router.patch('/teams/events/:eventId',                  authenticate, teamsController.updateEvent.bind(teamsController));
router.post('/teams/events/:eventId/cancel',            authenticate, teamsController.cancelEvent.bind(teamsController));
router.delete('/teams/events/:eventId',                 authenticate, teamsController.deleteEvent.bind(teamsController));

// ── Transcrições & Relatórios IA ──────────────────────────────────────────────
const tc = MicrosoftTranscriptController;
router.get('/transcripts/meetings',                             authenticate, tc.listMeetings.bind(tc));
router.get('/transcripts/check',                                authenticate, tc.checkTranscripts.bind(tc));
router.get('/transcripts/diagnose',                             authenticate, tc.diagnose.bind(tc));
router.get('/transcripts/reports',                              authenticate, tc.listReports.bind(tc));
router.get('/transcripts/reports/:id',                          authenticate, tc.getReport.bind(tc));
router.post('/transcripts/reports/:id/email',                   authenticate, tc.emailReport.bind(tc));
router.get('/transcripts/:meetingId/:transcriptId',             authenticate, tc.getTranscript.bind(tc));
router.post('/transcripts/:meetingId/:transcriptId/report',     authenticate, tc.generateReport.bind(tc));

// ── Reuniões Presenciais ──────────────────────────────────────────────────────
const ipc = InPersonMeetingController;
router.get('/inperson/meetings',                authenticate, ipc.list.bind(ipc));
router.post('/inperson/meetings',               authenticate, ipc.create.bind(ipc));
router.get('/inperson/meetings/:id',            authenticate, ipc.get.bind(ipc));
router.put('/inperson/meetings/:id',            authenticate, ipc.update.bind(ipc));
router.delete('/inperson/meetings/:id',         authenticate, ipc.remove.bind(ipc));
router.post('/inperson/meetings/:id/report',    authenticate, ipc.generateReport.bind(ipc));
router.post('/inperson/meetings/:id/email',     authenticate, ipc.emailReport.bind(ipc));

export default router;
