// services/microsoft/MicrosoftSharepointService.js
import graphService from './MicrosoftGraphService.js';

const ITEM_SELECT = 'id,name,size,folder,file,webUrl,lastModifiedDateTime,parentReference,@microsoft.graph.downloadUrl';

class MicrosoftSharepointService {

    // ── Sites ─────────────────────────────────────────────────────────────────
    async getSites(user) {
        const result = await graphService.get(user,
            '/sites?search=*&$select=id,name,displayName,webUrl,description&$top=50'
        );
        return (result.value || []).map(s => ({
            id: s.id,
            name: s.displayName || s.name,
            webUrl: s.webUrl,
            description: s.description || null,
        }));
    }

    // ── Drives ────────────────────────────────────────────────────────────────
    async getSiteDrives(user, siteId) {
        const result = await graphService.get(user,
            `/sites/${siteId}/drives?$select=id,name,driveType,webUrl,description`
        );
        return (result.value || []).map(d => ({
            id: d.id,
            name: d.name,
            driveType: d.driveType,
            webUrl: d.webUrl,
        }));
    }

    // ── Itens ─────────────────────────────────────────────────────────────────
    async getDriveRoot(user, driveId) {
        const result = await graphService.get(user,
            `/drives/${driveId}/root/children?$select=${ITEM_SELECT}&$top=500`
        );
        return this._normalizeItems(result.value || []);
    }

    async getFolderChildren(user, driveId, itemId) {
        const result = await graphService.get(user,
            `/drives/${driveId}/items/${itemId}/children?$select=${ITEM_SELECT}&$top=500`
        );
        return this._normalizeItems(result.value || []);
    }

    async getItem(user, driveId, itemId) {
        const result = await graphService.get(user,
            `/drives/${driveId}/items/${itemId}?$select=${ITEM_SELECT}`
        );
        return this._normalizeItem(result);
    }

    async search(user, driveId, query) {
        const result = await graphService.get(user,
            `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')?$select=${ITEM_SELECT}&$top=30`
        );
        return this._normalizeItems(result.value || []);
    }

    // ── Mutações ──────────────────────────────────────────────────────────────

    /** Exclui um item (arquivo ou pasta) permanentemente */
    async deleteItem(user, driveId, itemId) {
        await graphService.delete(user, `/drives/${driveId}/items/${itemId}`);
    }

    /**
     * Atualiza um item: renomear ({ name }) e/ou mover ({ parentId }).
     * Aceita body: { name?, parentId? }
     */
    async updateItem(user, driveId, itemId, { name, parentId } = {}) {
        const body = {};
        if (name) body.name = name;
        if (parentId) body.parentReference = { id: parentId };
        const result = await graphService.patch(user, `/drives/${driveId}/items/${itemId}`, body);
        return this._normalizeItem(result);
    }

    /**
     * Faz upload de um arquivo pequeno (< 4 MB) via conteúdo binário.
     * Para arquivos maiores, seria necessário usar upload em sessão (resumable).
     */
    async uploadFile(user, driveId, parentId, filename, buffer, contentType) {
        const path = `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(filename)}:/content`;
        const result = await graphService.put(user, path, buffer, contentType || 'application/octet-stream');
        return this._normalizeItem(result);
    }

    /** Cria um link de compartilhamento para o item */
    async createSharingLink(user, driveId, itemId) {
        const result = await graphService.post(user,
            `/drives/${driveId}/items/${itemId}/createLink`,
            { type: 'view', scope: 'organization' }
        );
        return result.link?.webUrl || null;
    }

    /**
     * Transmite o conteúdo binário de um arquivo via Graph API.
     * O endpoint /content do Graph redireciona para o Azure Blob Storage;
     * axios segue o redirect e retorna o stream final.
     */
    async streamItemContent(user, driveId, itemId) {
        const response = await graphService.stream(user, `/drives/${driveId}/items/${itemId}/content`);
        return {
            stream: response.data,
            contentType: response.headers['content-type'] || 'application/octet-stream',
            contentLength: response.headers['content-length'] || null,
        };
    }

    // ── Normalização ──────────────────────────────────────────────────────────
    _normalizeItems(items) {
        return items.map(item => this._normalizeItem(item));
    }

    _normalizeItem(item) {
        const isFolder = !!item.folder;
        const ext = isFolder ? null : (item.name || '').split('.').pop()?.toLowerCase() || null;
        return {
            id: item.id,
            name: item.name,
            isFolder,
            ext,
            mimeType: item.file?.mimeType || null,
            size: item.size || 0,
            webUrl: item.webUrl,
            downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
            lastModified: item.lastModifiedDateTime || null,
            childCount: item.folder?.childCount ?? null,
            parentId: item.parentReference?.id || null,
            driveId: item.parentReference?.driveId || null,
        };
    }
}

export default new MicrosoftSharepointService();
