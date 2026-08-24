// routes/microsoftAuthRoutes.js
import express from 'express';
import MicrosoftChatController from '../controllers/microsoft/MicrosoftChatController.js';
import MicrosoftAuthController from '../controllers/microsoft/MicrosoftAuthController.js';
import MicrosoftSharepointController from '../controllers/microsoft/MicrosoftSharepointController.js';
import MicrosoftTeamsController from '../controllers/microsoft/MicrosoftTeamsController.js';
import MicrosoftTranscriptController from '../controllers/microsoft/MicrosoftTranscriptController.js';
import MicrosoftOrgUsersController from '../controllers/microsoft/MicrosoftOrgUsersController.js';
import MicrosoftPlannerController from '../controllers/microsoft/MicrosoftPlannerController.js';
import MicrosoftOutlookController from '../controllers/microsoft/MicrosoftOutlookController.js';
import MicrosoftWebhookController from '../controllers/microsoft/MicrosoftWebhookController.js';
import InPersonMeetingController from '../controllers/InPersonMeetingController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

// ── Parser do upload ──────────────────────────────────────────────────────────
// Arquivo pequeno continua chegando como Buffer (caminho de sempre, PUT direto
// no Graph). Acima disso o body parser NÃO roda: o `req` chega intacto no
// controller e é consumido como stream pela sessão de upload, em pedaços — o
// arquivo nunca fica inteiro na memória do processo.
const SMALL_UPLOAD_BYTES = 4 * 1024 * 1024; // teto do upload simples do Graph
const rawSmallUpload = express.raw({ type: '*/*', limit: SMALL_UPLOAD_BYTES });
const uploadBodyParser = (req, res, next) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > SMALL_UPLOAD_BYTES) return next();
    return rawSmallUpload(req, res, next);
};
const authController = new MicrosoftAuthController();
const sharepointController = new MicrosoftSharepointController();
const teamsController = MicrosoftTeamsController;

// ── Auth: Públicas ────────────────────────────────────────────────────────────
router.get('/auth/login', authController.login);
router.get('/auth/callback', authController.callback);
router.post('/auth/exchange', authController.exchange);

// ── Webhook do Graph (PÚBLICA por obrigação) ─────────────────────────────────
// É a Microsoft que chama, e ela não carrega o JWT do Office. A autenticação é
// o clientState conferido no controller. O handshake de validação precisa
// devolver o token como text/plain em até 10 segundos.
router.post('/webhook', MicrosoftWebhookController.receive);

// ── Assinaturas de mudança (admin) ───────────────────────────────────────────
router.get('/subscriptions',        authenticate, requireAdmin, MicrosoftWebhookController.list);
router.post('/subscriptions',       authenticate, requireAdmin, MicrosoftWebhookController.create);
router.delete('/subscriptions/:id', authenticate, requireAdmin, MicrosoftWebhookController.remove);

// ── Auth: Autenticadas ────────────────────────────────────────────────────────
// link/start é POST de propósito: o redirect do navegador não carrega o
// Authorization, e o backend precisa saber QUEM está vinculando a conta.
router.post('/auth/link/start', authenticate, authController.linkStart);
router.get('/auth/status', authenticate, authController.status);
router.post('/auth/refresh', authenticate, authController.refresh);
router.delete('/auth/unlink', authenticate, authController.unlink);

// A tela de diagnóstico da integração e o Laboratório do Outlook saíram em
// 24/08/2026. A configuração continua existindo e vale pelo padrão do
// MicrosoftSettingsService - ela não muda, e tela para isso era peso sem uso.
// O que precisa ser liberado no portal do Azure está em
// _estudo/microsoft/PERMISSOES-AZURE.md.

// ── Gestão de Usuários da Org Microsoft (admin only) ─────────────────────────
router.get('/org-users',        authenticate, requireAdmin, MicrosoftOrgUsersController.listOrgUsers);
router.post('/org-users/import', authenticate, requireAdmin, MicrosoftOrgUsersController.importOrgUsers);

// ── Planner ───────────────────────────────────────────────────────────────────
const pc = MicrosoftPlannerController;
router.get('/planner/people',                               authenticate, pc.getPeople);
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
// Rotas de caminho fixo vêm ANTES das que têm :param, senão /my-drive cairia
// como se fosse um siteId.
router.get('/sharepoint/my-drive', authenticate, sharepointController.myDrive);
router.get('/sharepoint/shared-with-me', authenticate, sharepointController.sharedWithMe);
// Busca global: uma chamada no índice do SharePoint, em vez de varrer
// biblioteca por biblioteca. Vem ANTES das rotas com :param.
router.get('/sharepoint/search', authenticate, sharepointController.searchAll);
router.get('/sharepoint/sites', authenticate, sharepointController.sites);
router.get('/sharepoint/sites/:siteId/drives', authenticate, sharepointController.drives);
router.get('/sharepoint/drives/:driveId/root', authenticate, sharepointController.driveRoot);
router.get('/sharepoint/drives/:driveId/items/:itemId/children', authenticate, sharepointController.folderChildren);
router.get('/sharepoint/drives/:driveId/items/:itemId/content', authenticate, sharepointController.itemContent);
// Planilha na nuvem (Workbook API) — lê célula e intervalo sem baixar o arquivo.
router.get('/sharepoint/drives/:driveId/items/:itemId/worksheets', authenticate, sharepointController.worksheets);
router.get('/sharepoint/drives/:driveId/items/:itemId/worksheets/:sheet', authenticate, sharepointController.worksheetRange);
router.get('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.item);
router.get('/sharepoint/drives/:driveId/search', authenticate, sharepointController.search);

// ── SharePoint: Escrita ───────────────────────────────────────────────────────
router.delete('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.deleteItem);
router.patch('/sharepoint/drives/:driveId/items/:itemId', authenticate, sharepointController.updateItem);
router.post('/sharepoint/drives/:driveId/items/:itemId/link', authenticate, sharepointController.createLink);
router.put(
    '/sharepoint/drives/:driveId/folders/:folderId/upload/:filename',
    authenticate,
    uploadBodyParser,
    sharepointController.upload
);
router.get('/sharepoint/upload-limits', authenticate, sharepointController.uploadLimits);

// ── Outlook ───────────────────────────────────────────────────────────────────
// ATENÇÃO: este módulo usa token de APLICAÇÃO, não o token delegado da pessoa.
// O Graph aceitaria a caixa de qualquer um; quem amarra à caixa de quem pediu é
// o _resolveMailbox do controller. Por isso, diferente do resto de /api/microsoft,
// aqui TEM enforcement de alçada — a exceção do integrityCheck não cobre este caso.
const oc = MicrosoftOutlookController;
const olVer      = [authenticate, requireCapability('/microsoft/outlook', 'view')];
const olOrganiza = [authenticate, requireCapability('/microsoft/outlook', 'organize')];
const olEnvia    = [authenticate, requireCapability('/microsoft/outlook', 'send')];

router.get('/outlook/folders',                    ...olVer, oc.folders);
router.get('/outlook/unread',                     ...olVer, oc.unread);
router.get('/outlook/categories',                 ...olVer, oc.categories);
router.get('/outlook/mailbox-settings',           ...olVer, oc.mailboxSettings);
router.get('/outlook/messages',                   ...olVer, oc.list);
router.get('/outlook/messages/:id',               ...olVer, oc.get);
router.get('/outlook/messages/:id/attachments/:attachmentId', ...olVer, oc.attachment);

router.patch('/outlook/messages/:id/read',        ...olOrganiza, oc.setRead);
router.patch('/outlook/messages/:id/flag',        ...olOrganiza, oc.setFlag);
router.patch('/outlook/messages/:id/categories',  ...olOrganiza, oc.setCategories);
router.post('/outlook/messages/:id/move',         ...olOrganiza, oc.move);
router.delete('/outlook/messages/:id',            ...olOrganiza, oc.remove);

router.post('/outlook/drafts',                    ...olEnvia, oc.createDraft);
router.patch('/outlook/drafts/:id',               ...olEnvia, oc.updateDraft);
router.post('/outlook/messages/:id/:kind(reply|replyAll|forward)', ...olEnvia, oc.replyDraft);
router.post('/outlook/drafts/:id/attachments',    ...olEnvia, oc.addAttachment);
router.delete('/outlook/drafts/:id/attachments/:attachmentId', ...olEnvia, oc.removeAttachment);
router.post('/outlook/drafts/:id/send',           ...olEnvia, oc.send);
router.post('/outlook/send',                      ...olEnvia, oc.send);

// ── Teams / Calendário ────────────────────────────────────────────────────────
router.get('/teams/calendar',                           authenticate, teamsController.calendarView.bind(teamsController));
router.post('/teams/schedule',                          authenticate, teamsController.schedule.bind(teamsController));
router.get('/teams/events/:eventId',                    authenticate, teamsController.event.bind(teamsController));
router.post('/teams/meetings',                          authenticate, teamsController.createScheduledMeeting.bind(teamsController));
router.post('/teams/meetings/instant',                  authenticate, teamsController.createInstantMeeting.bind(teamsController));
router.patch('/teams/events/:eventId',                  authenticate, teamsController.updateEvent.bind(teamsController));
router.post('/teams/events/:eventId/cancel',            authenticate, teamsController.cancelEvent.bind(teamsController));
router.delete('/teams/events/:eventId',                 authenticate, teamsController.deleteEvent.bind(teamsController));

// ── Conversas do Teams ────────────────────────────────────────────────────────
// Token DELEGADO: a conversa é a da própria pessoa e a mensagem sai no nome
// dela. Nenhuma rota aceita 'de quem'.
const cc = MicrosoftChatController;
router.get('/teams/chats',                              authenticate, cc.list.bind(cc));
router.post('/teams/chats',                             authenticate, cc.start.bind(cc));
router.get('/teams/chats/:chatId/messages',             authenticate, cc.messages.bind(cc));
router.post('/teams/chats/:chatId/messages',            authenticate, cc.send.bind(cc));
router.post('/teams/chats/:chatId/read',                authenticate, cc.read.bind(cc));

// Presença e salas: leitura pura, com o token da própria pessoa.
router.get('/teams/presence',                            authenticate, teamsController.presence.bind(teamsController));
router.get('/teams/rooms',                               authenticate, teamsController.rooms.bind(teamsController));

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
// Áudio da gravação do navegador (MediaRecorder). Chega como binário puro; o
// teto real é conferido no controller, com mensagem que diz o tamanho.
router.post('/inperson/meetings/:id/audio',
    authenticate,
    express.raw({ type: '*/*', limit: '25mb' }),
    ipc.transcribeAudio.bind(ipc));
router.post('/inperson/meetings/:id/report',    authenticate, ipc.generateReport.bind(ipc));
router.post('/inperson/meetings/:id/email',     authenticate, ipc.emailReport.bind(ipc));

export default router;
