// controllers/microsoft/MicrosoftSharepointController.js
import sharepointService from '../../services/microsoft/MicrosoftSharepointService.js';
import settingsService from '../../services/microsoft/MicrosoftSettingsService.js';
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

    /**
     * Responde uma listagem paginada mantendo o CORPO como array puro (o que o
     * front já consome) e anunciando o corte no cabeçalho.
     *
     * As listagens não seguiam o @odata.nextLink: uma pasta com 501 arquivos
     * mostrava 500 e dizia que tinha acabado. Agora a lista vem completa até o
     * teto configurado, e quando o teto é atingido a tela avisa.
     */
    _sendList(res, result) {
        const items = Array.isArray(result) ? result : (result?.items || []);
        const truncated = Array.isArray(result) ? false : !!result?.truncated;
        res.set('X-Graph-Truncated', truncated ? '1' : '0');
        res.set('X-Graph-Count', String(items.length));
        res.set('Access-Control-Expose-Headers', 'X-Graph-Truncated, X-Graph-Count');
        return res.json(items);
    }

    // ── GET /api/microsoft/sharepoint/sites
    sites = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return this._sendList(res, await sharepointService.getSites(user));
        } catch (err) {
            console.error('❌ [SharePoint] sites:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── Planilha na nuvem ────────────────────────────────────────────────────

    // GET /sharepoint/drives/:driveId/items/:itemId/worksheets
    worksheets = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.listWorksheets(user, req.params.driveId, req.params.itemId));
        } catch (err) {
            const status = err?.response?.status;
            console.error('❌ [SharePoint] worksheets:', err?.response?.data || err.message);
            // 400/404 aqui costuma ser "não é .xlsx", não falha do Office.
            if (status === 400 || status === 404) {
                return res.status(422).json({ error: 'Este arquivo não é uma planilha do Excel (.xlsx) que a Microsoft consiga abrir na nuvem.' });
            }
            return res.status(status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // GET /sharepoint/drives/:driveId/items/:itemId/worksheets/:sheet?range=A1:F50
    worksheetRange = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const data = await sharepointService.readWorksheetRange(
                user, req.params.driveId, req.params.itemId,
                decodeURIComponent(req.params.sheet), req.query.range || null
            );
            return res.json(data);
        } catch (err) {
            console.error('❌ [SharePoint] worksheetRange:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/my-drive
    // A pasta pessoal (OneDrive) de quem pediu.
    myDrive = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await sharepointService.getMyDrive(user));
        } catch (err) {
            console.error('❌ [SharePoint] myDrive:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/shared-with-me
    sharedWithMe = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return this._sendList(res, await sharepointService.getSharedWithMe(user));
        } catch (err) {
            console.error('❌ [SharePoint] sharedWithMe:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/sites/:siteId/drives
    drives = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return this._sendList(res, await sharepointService.getSiteDrives(user, req.params.siteId));
        } catch (err) {
            console.error('❌ [SharePoint] drives:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/root
    driveRoot = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return this._sendList(res, await sharepointService.getDriveRoot(user, req.params.driveId));
        } catch (err) {
            console.error('❌ [SharePoint] driveRoot:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/items/:itemId/children
    folderChildren = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return this._sendList(res, await sharepointService.getFolderChildren(user, req.params.driveId, req.params.itemId));
        } catch (err) {
            console.error('❌ [SharePoint] folderChildren:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
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
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/drives/:driveId/search?q=...
    // Busca em tudo que a pessoa alcança, sem escolher biblioteca antes.
    searchAll = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { q, size } = req.query;
            if (!q?.trim()) return res.status(400).json({ error: "Parâmetro q é obrigatório." });
            return res.json(await sharepointService.searchEverywhere(user, q.trim(), { size }));
        } catch (err) {
            console.error("❌ [SharePoint] searchAll:", err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    search = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { q } = req.query;
            if (!q?.trim()) return res.status(400).json({ error: 'Parâmetro q é obrigatório.' });
            return this._sendList(res, await sharepointService.search(user, req.params.driveId, q.trim()));
        } catch (err) {
            console.error('❌ [SharePoint] search:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
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
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
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
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
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

            const limits = await settingsService.uploadLimits();
            const declared = Number(req.headers['content-length'] || 0);

            // Recusa ANTES de gastar a subida inteira: erro no fim da barra de
            // progresso é a pior forma de dizer "não cabe".
            if (declared > limits.maxBytes) {
                return res.status(413).json({
                    error: `Arquivo de ${(declared / 1024 / 1024).toFixed(1)} MB acima do limite de ${limits.maxMb} MB para envio ao SharePoint.`,
                });
            }

            // Arquivo pequeno: body parser rodou e entregou um Buffer (caminho
            // de sempre). Arquivo grande: o parser foi pulado e o `req` chega
            // intacto para ser consumido em pedaços pela sessão de upload.
            if (Buffer.isBuffer(req.body)) {
                if (req.body.length === 0) {
                    return res.status(400).json({ error: 'Corpo do arquivo vazio.' });
                }
                const item = await sharepointService.uploadFile(user, driveId, folderId, decodedName, req.body, contentType);
                return res.status(201).json(item);
            }

            const item = await sharepointService.uploadStream(
                user, driveId, folderId, decodedName, req, declared, limits.chunkBytes
            );
            return res.status(201).json(item);
        } catch (err) {
            console.error('❌ [SharePoint] upload:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };

    // ── GET /api/microsoft/sharepoint/upload-limits
    // A tela consulta antes de enviar para recusar o arquivo grande demais na
    // hora da escolha, em vez de deixar a pessoa esperar a subida inteira.
    uploadLimits = async (req, res) => {
        try {
            const limits = await settingsService.uploadLimits();
            return res.json({ maxMb: limits.maxMb, maxBytes: limits.maxBytes });
        } catch (err) {
            console.error('❌ [SharePoint] uploadLimits:', err.message);
            return res.status(500).json({ error: err.message, permissao: err.permissao || null });
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
            if (!res.headersSent) return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
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
            return res.status(err?.response?.status || 500).json({ error: err.message, permissao: err.permissao || null });
        }
    };
}
