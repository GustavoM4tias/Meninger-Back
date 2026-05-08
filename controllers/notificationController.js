// api/controllers/notificationController.js
import NotificationService from '../services/notification/NotificationService.js';
import { listCatalog } from '../services/notification/notificationTypes.js';

/**
 * GET /api/notifications?unread=1&limit=30&offset=0
 */
export const list = async (req, res) => {
    try {
        const userId = req.user.id;
        const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
        const limit = Math.min(Number(req.query.limit) || 30, 100);
        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const result = await NotificationService.listForUser(userId, { unreadOnly, limit, offset });
        const unread = await NotificationService.unreadCount(userId);

        return res.json({ ...result, unread });
    } catch (err) {
        console.error('[notifications/list]', err);
        return res.status(500).json({ error: 'Falha ao listar notificações.' });
    }
};

/**
 * GET /api/notifications/unread-count
 */
export const unreadCount = async (req, res) => {
    try {
        const count = await NotificationService.unreadCount(req.user.id);
        return res.json({ count });
    } catch (err) {
        console.error('[notifications/unreadCount]', err);
        return res.status(500).json({ error: 'Falha ao contar notificações.' });
    }
};

/**
 * PATCH /api/notifications/:id/read
 */
export const markRead = async (req, res) => {
    try {
        const ok = await NotificationService.markRead(req.user.id, Number(req.params.id));
        if (!ok) return res.status(404).json({ error: 'Notificação não encontrada.' });
        return res.json({ success: true });
    } catch (err) {
        console.error('[notifications/markRead]', err);
        return res.status(500).json({ error: 'Falha ao marcar como lida.' });
    }
};

/**
 * POST /api/notifications/read-all
 */
export const markAllRead = async (req, res) => {
    try {
        const updated = await NotificationService.markAllRead(req.user.id);
        return res.json({ updated });
    } catch (err) {
        console.error('[notifications/markAllRead]', err);
        return res.status(500).json({ error: 'Falha ao marcar todas como lidas.' });
    }
};

/**
 * DELETE /api/notifications/:id
 */
export const removeOne = async (req, res) => {
    try {
        const removed = await NotificationService.removeOne(req.user.id, Number(req.params.id));
        if (!removed) return res.status(404).json({ error: 'Notificação não encontrada.' });
        return res.json({ success: true });
    } catch (err) {
        console.error('[notifications/removeOne]', err);
        return res.status(500).json({ error: 'Falha ao remover notificação.' });
    }
};

/**
 * GET /api/notifications/preferences
 * Retorna catálogo de tipos + preferências salvas do usuário (merge).
 */
export const getPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const stored = await NotificationService.getPreferences(userId);
        const storedMap = new Map(stored.map(s => [s.type, s]));

        const catalog = listCatalog().map(meta => {
            const saved = storedMap.get(meta.type);
            return {
                type: meta.type,
                label: meta.label,
                group: meta.group,
                description: meta.description,
                hasEmail: !!meta.emailType,
                hasWhatsapp: !!meta.whatsapp,
                userOptional: meta.userOptional !== false,
                inapp:    saved ? saved.inapp    : meta.defaults.inapp,
                email:    saved ? saved.email    : meta.defaults.email,
                whatsapp: saved ? saved.whatsapp : !!meta.defaults.whatsapp,
                isCustom: !!saved,
            };
        });

        return res.json({ preferences: catalog });
    } catch (err) {
        console.error('[notifications/getPreferences]', err);
        return res.status(500).json({ error: 'Falha ao carregar preferências.' });
    }
};

/**
 * PUT /api/notifications/preferences
 * body: { type, inapp?, email?, whatsapp? }
 */
export const setPreference = async (req, res) => {
    try {
        const { type, inapp, email, whatsapp } = req.body || {};
        if (!type) return res.status(400).json({ error: 'type é obrigatório.' });
        const updated = await NotificationService.setPreference(req.user.id, type, { inapp, email, whatsapp });
        return res.json({ preference: updated });
    } catch (err) {
        console.error('[notifications/setPreference]', err);
        return res.status(500).json({ error: 'Falha ao salvar preferência.' });
    }
};
