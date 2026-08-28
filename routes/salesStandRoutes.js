// routes/salesStandRoutes.js
// Stand de Vendas: stands modelo (categorias) + stands reais com custo ao vivo
// do Sienge (plano financeiro 20207 — Despesas com Stand).
//
// Permissão em dois níveis:
//   - AÇÃO: capacidades da tela (lib/screenCapabilities.js) — view (ler),
//     manage (cuidar do stand) e configure (modelos e categorias, admin);
//   - DADO: o service corta pelos grants de empreendimento do req.user, então
//     ninguém enxerga (nem edita) stand de empreendimento fora da sua alçada.
import express from 'express';
import multer from 'multer';
import ctrl from '../controllers/marketing/salesStandController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

const ROUTE = '/marketing/stand-vendas';
const canView = [authenticate, requireInternal, requireCapability(ROUTE, 'view')];
const canManage = [authenticate, requireInternal, requireCapability(ROUTE, 'manage')];
const canConfigure = [authenticate, requireInternal, requireCapability(ROUTE, 'configure')];

// Fotos do stand: só imagem, direto para o bucket (sem disco local). A tela
// reduz e comprime antes de enviar, então o normal é chegar aqui com algumas
// centenas de KB; o teto folgado existe para o arquivo que o navegador não
// conseguiu tratar chegar e receber uma recusa explicada, em vez de ser cortado
// pelo multer com um erro seco.
const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 2 },
    fileFilter: (_req, file, cb) => {
        if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.mimetype || '')) {
            return cb(new Error('Envie uma imagem (JPG, PNG, WEBP ou HEIC).'));
        }
        cb(null, true);
    },
});

// ── Coleções específicas (antes de /:id) ──
router.get('/cost-centers', ...canView, ctrl.listCostCenters);
router.get('/contas', ...canView, ctrl.listContas);

// ── Configuração do módulo (o que conta como gasto de stand) ──
// Ler faz parte de entender o número da tela; MUDAR reescreve o custo de todos
// os stands da empresa, então é admin.
router.get('/settings', ...canView, ctrl.getSettings);
router.get('/conferencia', ...canView, ctrl.getDepartmentAudit);
// Bate na API do Sienge (uma chamada por título): ação de quem cuida do stand,
// não de todo leitor da tela.
router.post('/conferencia/revalidar', ...canManage, ctrl.revalidateDepartmentAudit);
router.patch('/settings', ...canConfigure, ctrl.updateSettings);

// ── Stands modelo (categorias) ──
router.get('/models', ...canView, ctrl.listModels);
router.post('/models', ...canConfigure, ctrl.createModel);
router.patch('/models/:id(\\d+)', ...canConfigure, ctrl.updateModel);
router.delete('/models/:id(\\d+)', ...canConfigure, ctrl.deleteModel);

// ── Categorias de gasto (construção × recorrência por conta) ──
router.get('/categories', ...canView, ctrl.listCategories);
router.post('/categories', ...canConfigure, ctrl.createCategory);
router.patch('/categories/:id(\\d+)', ...canConfigure, ctrl.updateCategory);
router.delete('/categories/:id(\\d+)', ...canConfigure, ctrl.deleteCategory);

// ── Stands reais ──
router.get('/', ...canView, ctrl.listStands);
router.post('/', ...canManage, ctrl.createStand);
router.get('/:id(\\d+)', ...canView, ctrl.getStand);
router.get('/:id(\\d+)/spend', ...canView, ctrl.getStandSpend);
router.patch('/:id(\\d+)', ...canManage, ctrl.updateStand);
router.delete('/:id(\\d+)', ...canManage, ctrl.deleteStand);
router.post('/:id(\\d+)/define', ...canManage, ctrl.defineStand);
router.post('/:id(\\d+)/undefine', ...canManage, ctrl.undefineStand);

// Classificação dos lançamentos e itens do stand
router.post('/:id(\\d+)/expenses/classify', ...canManage, ctrl.classifyExpenses);
router.put('/:id(\\d+)/items', ...canManage, ctrl.updateStandItems);

// Fotos
router.get('/:id(\\d+)/images', ...canView, ctrl.listImages);
router.post('/:id(\\d+)/images', ...canManage,
    imageUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
    ctrl.addImage);
// Reordenar = definir a capa: a primeira foto e a que aparece no cartao.
router.patch('/:id(\\d+)/images/order', ...canManage, ctrl.reorderImages);
router.patch('/:id(\\d+)/images/:imageId(\\d+)', ...canManage, ctrl.updateImage);
router.delete('/:id(\\d+)/images/:imageId(\\d+)', ...canManage, ctrl.deleteImage);

export default router;
