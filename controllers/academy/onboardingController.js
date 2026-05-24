import onboardingService from '../../services/academy/onboardingService.js';

const onboardingController = {
    async list(req, res) {
        try {
            return res.json(await onboardingService.list());
        } catch (err) {
            console.error('[academy.onboarding.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar regras.' });
        }
    },

    async create(req, res) {
        try {
            return res.status(201).json(await onboardingService.create({ payload: req.body || {} }));
        } catch (err) {
            console.error('[academy.onboarding.create]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar regra.' });
        }
    },

    async update(req, res) {
        try {
            return res.json(await onboardingService.update({
                id: req.params.id,
                payload: req.body || {},
            }));
        } catch (err) {
            console.error('[academy.onboarding.update]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar regra.' });
        }
    },

    async remove(req, res) {
        try {
            return res.json(await onboardingService.remove({ id: req.params.id }));
        } catch (err) {
            console.error('[academy.onboarding.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover regra.' });
        }
    },

    // Disparo manual (force-apply) — útil pra admin testar
    async applyNow(req, res) {
        try {
            return res.json(await onboardingService.applyAll());
        } catch (err) {
            console.error('[academy.onboarding.applyNow]', err);
            return res.status(400).json({ message: err.message || 'Erro ao aplicar.' });
        }
    },
};

export default onboardingController;
