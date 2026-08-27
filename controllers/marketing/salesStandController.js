// controllers/marketing/salesStandController.js
// Camada fina sobre o salesStandService. O escopo de dados (quais stands esta
// pessoa enxerga) é resolvido no service a partir de req.user — nenhuma rota
// aceita empreendimento por parâmetro.
import svc from '../../services/marketing/salesStandService.js';

function fail(res, err, fallback = 'Erro interno.') {
    const status = err?.httpStatus || 500;
    if (status >= 500) console.error('[salesStand]', err);
    return res.status(status).json({ message: err?.message || fallback, code: err?.code || undefined });
}

export default {
    // Só os centros de custo que ESTE usuário enxerga: a lista alimenta o
    // select de cadastro, e a lista inteira seria um índice dos empreendimentos
    // da empresa para quem não tem alcada neles.
    async listCostCenters(req, res) {
        try { res.json(await svc.listCostCentersForUser(req.user)); }
        catch (err) { fail(res, err); }
    },

    // Configuração do módulo: o que conta como gasto de stand.
    async getSettings(req, res) {
        try {
            const [settings, departments] = await Promise.all([
                svc.getSettings(),
                svc.listDepartments().catch(() => []),
            ]);
            res.json({ settings, departments });
        } catch (err) { fail(res, err); }
    },

    async updateSettings(req, res) {
        try { res.json(await svc.updateSettings({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    // Conferência do departamento: o que está certo e o que falta o
    // administrativo acertar no Sienge, nos stands que esta pessoa enxerga.
    async getDepartmentAudit(req, res) {
        try { res.json(await svc.getDepartmentAudit({ user: req.user })); }
        catch (err) { fail(res, err); }
    },

    // Confere na API do Sienge, ao vivo, se os títulos divergentes já foram
    // corrigidos. Só leitura no ERP.
    async revalidateDepartmentAudit(req, res) {
        try {
            res.json(await svc.revalidateDepartmentAudit({
                user: req.user,
                limit: Number(req.body?.limit) || undefined,
                offset: Number(req.body?.offset) || 0,
            }));
        } catch (err) { fail(res, err); }
    },

    // Contas do plano 2.02.07 — insumo da tela de categorias.
    async listContas(req, res) {
        try { res.json({ items: await svc.listContas() }); }
        catch (err) { fail(res, err); }
    },

    // Stands modelo (categorias)
    async listModels(req, res) {
        try { res.json({ items: await svc.listModels() }); }
        catch (err) { fail(res, err); }
    },

    async createModel(req, res) {
        try { res.status(201).json(await svc.createModel({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async updateModel(req, res) {
        try { res.json(await svc.updateModel({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async deleteModel(req, res) {
        try { res.json(await svc.deleteModel({ id: req.params.id })); }
        catch (err) { fail(res, err); }
    },

    // Categorias de gasto (construção × recorrência por conta do Sienge)
    async listCategories(req, res) {
        try { res.json({ items: await svc.listCategories() }); }
        catch (err) { fail(res, err); }
    },

    async createCategory(req, res) {
        try { res.status(201).json(await svc.createCategory({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async updateCategory(req, res) {
        try { res.json(await svc.updateCategory({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async deleteCategory(req, res) {
        try { res.json(await svc.deleteCategory({ id: req.params.id })); }
        catch (err) { fail(res, err); }
    },

    // Stands reais
    async listStands(req, res) {
        try { res.json(await svc.listStands({ user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async getStand(req, res) {
        try { res.json(await svc.getStandDetail({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async getStandSpend(req, res) {
        try { res.json(await svc.getStandSpend({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async classifyExpenses(req, res) {
        try {
            res.json(await svc.classifyExpenses({
                id: req.params.id, payload: req.body, userId: req.user.id, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },

    async updateStandItems(req, res) {
        try {
            res.json(await svc.updateStandItems({
                id: req.params.id, payload: req.body, userId: req.user.id, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },

    async createStand(req, res) {
        try { res.status(201).json(await svc.createStand({ payload: req.body, userId: req.user.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async updateStand(req, res) {
        try {
            res.json(await svc.updateStand({
                id: req.params.id, payload: req.body, userId: req.user.id, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },

    async deleteStand(req, res) {
        try { res.json(await svc.deleteStand({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async defineStand(req, res) {
        try { res.json(await svc.defineStand({ id: req.params.id, userId: req.user.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async undefineStand(req, res) {
        try { res.json(await svc.undefineStand({ id: req.params.id, userId: req.user.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    // Fotos do stand
    async listImages(req, res) {
        try { res.json(await svc.listStandImages({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async addImage(req, res) {
        try {
            res.status(201).json(await svc.addStandImage({
                id: req.params.id, file: req.file, caption: req.body?.caption,
                userId: req.user.id, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },

    async updateImage(req, res) {
        try {
            res.json(await svc.updateStandImage({
                id: req.params.id, imageId: req.params.imageId, payload: req.body, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },

    async deleteImage(req, res) {
        try {
            res.json(await svc.deleteStandImage({
                id: req.params.id, imageId: req.params.imageId, user: req.user,
            }));
        } catch (err) { fail(res, err); }
    },
};
