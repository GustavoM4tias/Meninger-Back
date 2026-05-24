import questionBankService from '../../services/academy/questionBankService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const questionBankController = {
    async list(req, res) {
        try {
            const { q = '', tags, difficulty = '', status = '', page = '1', pageSize = '20' } = req.query;
            const tagsArr = tags
                ? (Array.isArray(tags) ? tags : String(tags).split(',').map(s => s.trim()).filter(Boolean))
                : [];

            const data = await questionBankService.list({
                q,
                tags: tagsArr,
                difficulty,
                status,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar perguntas.' });
        }
    },

    async getById(req, res) {
        try {
            // admin pode pedir o gabarito via ?withAnswerKey=true
            const includeAnswerKey = String(req.query.withAnswerKey || '').toLowerCase() === 'true';
            const data = await questionBankService.getById({
                id: req.params.id,
                includeAnswerKey,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.getById]', err);
            return res.status(404).json({ message: err.message || 'Pergunta não encontrada.' });
        }
    },

    async create(req, res) {
        try {
            const data = await questionBankService.create({
                userId: resolveUserId(req),
                payload: req.body || {},
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.questionBank.create]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar pergunta.' });
        }
    },

    async update(req, res) {
        try {
            const data = await questionBankService.update({
                id: req.params.id,
                userId: resolveUserId(req),
                payload: req.body || {},
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.update]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar pergunta.' });
        }
    },

    async archive(req, res) {
        try {
            const data = await questionBankService.archive({ id: req.params.id });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.archive]', err);
            return res.status(400).json({ message: err.message || 'Erro ao arquivar pergunta.' });
        }
    },

    // Liga pergunta a um quiz item
    async attach(req, res) {
        try {
            const data = await questionBankService.attachToItem({
                itemId: req.params.itemId,
                questionId: req.body?.questionId,
                orderIndex: req.body?.orderIndex,
                points: req.body?.points ?? 1,
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.questionBank.attach]', err);
            return res.status(400).json({ message: err.message || 'Erro ao vincular pergunta.' });
        }
    },

    async detach(req, res) {
        try {
            const data = await questionBankService.detachFromItem({
                itemId: req.params.itemId,
                questionId: req.params.questionId,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.detach]', err);
            return res.status(400).json({ message: err.message || 'Erro ao desvincular pergunta.' });
        }
    },

    async listByItem(req, res) {
        try {
            // admin sempre vê com gabarito
            const data = await questionBankService.listByItem({
                itemId: req.params.itemId,
                includeAnswerKey: true,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.questionBank.listByItem]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar perguntas do item.' });
        }
    },
};

export default questionBankController;
