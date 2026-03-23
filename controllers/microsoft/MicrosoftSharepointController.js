// controllers/microsoft/MicrosoftSharepointController.js
import sharepointService from '../../services/microsoft/MicrosoftSharepointService.js';
import db from '../../models/sequelize/index.js';

export default class MicrosoftSharepointController {

    async _getUser(userId) {
        return db.User.findByPk(userId, {
            attributes: ['id', 'microsoft_id', 'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
        });
    }

    _notConnected(res) {
        return res.status(401).json({ error: 'Conta Microsoft não conectada. Vincule sua conta em Minha Conta.' });
    }

    // ── GET /api/microsoft/sharepoint/sites
    sites = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getSites(user));
        } catch (err) {
            console.error('❌ [SharePoint] sites:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/sites/:siteId/drives
    drives = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getSiteDrives(user, req.params.siteId));
        } catch (err) {
            console.error('❌ [SharePoint] drives:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/root
    driveRoot = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getDriveRoot(user, req.params.driveId));
        } catch (err) {
            console.error('❌ [SharePoint] driveRoot:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/items/:itemId/children
    folderChildren = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getFolderChildren(user, req.params.driveId, req.params.itemId));
        } catch (err) {
            console.error('❌ [SharePoint] folderChildren:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/items/:itemId
    item = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getItem(user, req.params.driveId, req.params.itemId));
        } catch (err) {
            console.error('❌ [SharePoint] item:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/search?q=...
    search = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { q } = req.query;
            if (!q?.trim()) return res.status(400).json({ error: 'Parâmetro q é obrigatório.' });
            return res.json(await sharepointService.search(user, req.params.driveId, q.trim()));
        } catch (err) {
            console.error('❌ [SharePoint] search:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── DELETE /api/microsoft/sharepoint/drives/:driveId/items/:itemId
    deleteItem = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            await sharepointService.deleteItem(user, req.params.driveId, req.params.itemId);
            return res.status(204).end();
        } catch (err) {
            console.error('❌ [SharePoint] deleteItem:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── PATCH /api/microsoft/sharepoint/drives/:driveId/items/:itemId
    // Body: { name?, parentId? }
    updateItem = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { name, parentId } = req.body;
            if (!name && !parentId) return res.status(400).json({ error: 'Informe name ou parentId.' });
            const item = await sharepointService.updateItem(user, req.params.driveId, req.params.itemId, { name, parentId });
            return res.json(item);
        } catch (err) {
            console.error('❌ [SharePoint] updateItem:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── PUT /api/microsoft/sharepoint/drives/:driveId/folders/:folderId/upload/:filename
    upload = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);

            const { driveId, folderId, filename } = req.params;
            const decodedName = decodeURIComponent(filename);
            const contentType = req.headers['content-type'] || 'application/octet-stream';

            // req.body is a Buffer when express.raw() middleware is used
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ error: 'Corpo do arquivo vazio.' });
            }

            const item = await sharepointService.uploadFile(user, driveId, folderId, decodedName, req.body, contentType);
            return res.status(201).json(item);
        } catch (err) {
            console.error('❌ [SharePoint] upload:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/items/:itemId/content?dl=1
    // dl=1  → força download (Content-Disposition: attachment)
    // dl=0  → inline / preview (Content-Disposition: inline)
    itemContent = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);

            const { driveId, itemId } = req.params;
            const forceDownload = req.query.dl === '1';

            // Busca metadados (nome, mimeType) e stream em paralelo
            const [item, { stream, contentType, contentLength }] = await Promise.all([
                sharepointService.getItem(user, driveId, itemId),
                sharepointService.streamItemContent(user, driveId, itemId),
            ]);

            const encoded = encodeURIComponent(item.name);
            const disposition = forceDownload
                ? `attachment; filename*=UTF-8''${encoded}`
                : `inline; filename*=UTF-8''${encoded}`;

            res.setHeader('Content-Type', contentType || item.mimeType || 'application/octet-stream');
            res.setHeader('Content-Disposition', disposition);
            if (contentLength) res.setHeader('Content-Length', contentLength);
            res.setHeader('Cache-Control', 'private, max-age=300');

            stream.pipe(res);
            stream.on('error', (err) => {
                console.error('❌ [SharePoint] stream error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: 'Erro ao transmitir arquivo.' });
            });
        } catch (err) {
            console.error('❌ [SharePoint] itemContent:', err?.response?.data || err.message);
            if (!res.headersSent) return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── POST /api/microsoft/sharepoint/drives/:driveId/items/:itemId/link
    createLink = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const link = await sharepointService.createSharingLink(user, req.params.driveId, req.params.itemId);
            return res.json({ link });
        } catch (err) {
            console.error('❌ [SharePoint] createLink:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };
}
