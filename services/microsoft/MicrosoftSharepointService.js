// services/microsoft/MicrosoftSharepointService.js
import axios from 'axios';
import graphService from './MicrosoftGraphService.js';
import settingsService from './MicrosoftSettingsService.js';

const ITEM_SELECT = 'id,name,size,folder,file,webUrl,lastModifiedDateTime,parentReference,@microsoft.graph.downloadUrl';

// Busca é caso à parte: ninguém rola 5.000 resultados de busca, e paginar tudo
// deixaria a caixa de busca lenta. O teto é baixo DE PROPÓSITO e continua sendo
// anunciado na resposta (truncated), então a tela avisa em vez de fingir.
const SEARCH_CAP = 200;

// Página do Graph. O $top é sugestão, não garantia — quem completa a lista é o
// @odata.nextLink, seguido por graphService.getAllPages().
const PAGE_SIZE = 200;

class MicrosoftSharepointService {

    // ── Sites ─────────────────────────────────────────────────────────────────
    async getSites(user) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graphService.getAllPages(user,
            `/sites?search=*&$select=id,name,displayName,webUrl,description&$top=${PAGE_SIZE}`,
            undefined,
            { max: cap }
        );
        return {
            items: items.map(s => ({
                id: s.id,
                name: s.displayName || s.name,
                webUrl: s.webUrl,
                description: s.description || null,
            })),
            truncated,
        };
    }

    /**
     * A pasta pessoal (OneDrive) de quem está pedindo.
     *
     * Só os sites estavam expostos, e é no OneDrive que mora o documento em
     * rascunho - o que a pessoa ainda não publicou em biblioteca de time.
     */
    async getMyDrive(user) {
        const d = await graphService.get(user, '/me/drive?$select=id,name,driveType,webUrl,quota');
        return {
            id: d.id,
            name: 'Meus arquivos (OneDrive)',
            driveType: d.driveType,
            webUrl: d.webUrl,
            quota: d.quota ? { usado: d.quota.used, total: d.quota.total } : null,
        };
    }

    /**
     * Arquivos que outras pessoas compartilharam com quem está pedindo.
     *
     * Cada item traz o driveId de ORIGEM (a biblioteca de quem compartilhou),
     * porque abrir/baixar depende dele, não do drive de quem recebeu.
     */
    async getSharedWithMe(user) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graphService.getAllPages(
            user, '/me/drive/sharedWithMe', undefined, { max: Math.min(cap, 200) }
        );

        return {
            items: items.map(item => {
                const normal = this._normalizeItem(item);
                const origem = item.remoteItem || item;
                return {
                    ...normal,
                    id: origem.id || normal.id,
                    driveId: origem.parentReference?.driveId || normal.driveId,
                    isFolder: !!origem.folder,
                    size: origem.size || 0,
                    lastModified: origem.lastModifiedDateTime || normal.lastModified,
                    webUrl: origem.webUrl || normal.webUrl,
                    compartilhadoPor: item.createdBy?.user?.displayName
                        || origem.createdBy?.user?.displayName
                        || null,
                };
            }),
            truncated,
        };
    }

    // ── Drives ────────────────────────────────────────────────────────────────
    async getSiteDrives(user, siteId) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graphService.getAllPages(user,
            `/sites/${siteId}/drives?$select=id,name,driveType,webUrl,description`,
            undefined,
            { max: cap }
        );
        return {
            items: items.map(d => ({
                id: d.id,
                name: d.name,
                driveType: d.driveType,
                webUrl: d.webUrl,
            })),
            truncated,
        };
    }

    // ── Itens ─────────────────────────────────────────────────────────────────
    async getDriveRoot(user, driveId) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graphService.getAllPages(user,
            `/drives/${driveId}/root/children?$select=${ITEM_SELECT}&$top=${PAGE_SIZE}`,
            undefined,
            { max: cap }
        );
        return { items: this._normalizeItems(items), truncated };
    }

    async getFolderChildren(user, driveId, itemId) {
        const cap = await settingsService.listCap();
        const { items, truncated } = await graphService.getAllPages(user,
            `/drives/${driveId}/items/${itemId}/children?$select=${ITEM_SELECT}&$top=${PAGE_SIZE}`,
            undefined,
            { max: cap }
        );
        return { items: this._normalizeItems(items), truncated };
    }

    async getItem(user, driveId, itemId) {
        const result = await graphService.get(user,
            `/drives/${driveId}/items/${itemId}?$select=${ITEM_SELECT}`
        );
        return this._normalizeItem(result);
    }

    async search(user, driveId, query) {
        const { items, truncated } = await graphService.getAllPages(user,
            `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')?$select=${ITEM_SELECT}&$top=50`,
            undefined,
            { max: SEARCH_CAP }
        );
        return { items: this._normalizeItems(items), truncated };
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
     * Arquivos maiores vão por uploadStream() — sessão em pedaços.
     */
    async uploadFile(user, driveId, parentId, filename, buffer, contentType) {
        const path = `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(filename)}:/content`;
        const result = await graphService.put(user, path, buffer, contentType || 'application/octet-stream');
        return this._normalizeItem(result);
    }

    /**
     * Upload de arquivo GRANDE por sessão do Graph, lendo direto do stream da
     * requisição — o arquivo nunca é carregado inteiro na memória do Node.
     *
     * Antes só existia o PUT direto: a rota aceitava 100 MB, o buffer inteiro
     * atravessava o processo e o Graph recusava qualquer coisa acima do limite
     * do upload simples. O usuário esperava a barra encher para receber um erro
     * opaco no fim.
     *
     * @param {Readable} stream    - o próprio `req` (não consumido por body parser)
     * @param {number}   totalBytes - Content-Length da requisição (obrigatório:
     *   o Graph exige Content-Range com o tamanho total em cada pedaço)
     * @param {number}   chunkBytes - múltiplo de 320 KiB
     */
    async uploadStream(user, driveId, parentId, filename, stream, totalBytes, chunkBytes) {
        if (!totalBytes || totalBytes <= 0) {
            throw new Error('Tamanho do arquivo não informado pelo navegador. Tente enviar novamente.');
        }

        const sessionPath = `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(filename)}:/createUploadSession`;
        const session = await graphService.post(user, sessionPath, {
            item: { '@microsoft.graph.conflictBehavior': 'rename' },
        });

        const uploadUrl = session?.uploadUrl;
        if (!uploadUrl) throw new Error('A Microsoft não devolveu a sessão de upload.');

        let sent = 0;
        let pending = [];
        let pendingBytes = 0;
        let finalItem = null;

        // A uploadUrl já vem pré-autenticada pelo Graph: mandar o Authorization
        // junto faz a Microsoft recusar o pedaço.
        const putChunk = async (buf) => {
            const start = sent;
            const end = sent + buf.length - 1;
            const { data, status } = await axios.put(uploadUrl, buf, {
                headers: {
                    'Content-Length': buf.length,
                    'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                validateStatus: (st) => st === 200 || st === 201 || st === 202,
            });
            sent = end + 1;
            if (status === 200 || status === 201) finalItem = data;
        };

        try {
            for await (const piece of stream) {
                pending.push(piece);
                pendingBytes += piece.length;

                while (pendingBytes >= chunkBytes) {
                    const merged = Buffer.concat(pending, pendingBytes);
                    await putChunk(merged.subarray(0, chunkBytes));
                    const rest = merged.subarray(chunkBytes);
                    pending = rest.length ? [rest] : [];
                    pendingBytes = rest.length;
                }
            }

            if (pendingBytes > 0) {
                await putChunk(Buffer.concat(pending, pendingBytes));
            }
        } catch (err) {
            // Sessão pendurada no SharePoint vira arquivo fantasma: cancela.
            await axios.delete(uploadUrl).catch(() => {});
            const graphMsg = err?.response?.data?.error?.message;
            throw new Error(graphMsg || err.message || 'Falha no envio do arquivo.');
        }

        if (sent !== totalBytes) {
            await axios.delete(uploadUrl).catch(() => {});
            throw new Error('O envio foi interrompido antes do fim do arquivo. Tente novamente.');
        }

        // O último pedaço devolve o driveItem pronto.
        return finalItem ? this._normalizeItem(finalItem) : null;
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

    // ── Planilha na nuvem (Workbook API) ─────────────────────────────────────
    //
    // Dado que hoje entra no Office por planilha trocada em anexo pode passar a
    // ser lido da fonte: o Graph abre o .xlsx que está no SharePoint e devolve
    // célula e intervalo, sem baixar o arquivo e sem biblioteca de Excel aqui.
    //
    // Só funciona em .xlsx (não em .xls nem em planilha do Google).

    async listWorksheets(user, driveId, itemId) {
        const data = await graphService.get(user,
            `/drives/${driveId}/items/${itemId}/workbook/worksheets?$select=id,name,position,visibility`
        );
        return (data.value || []).map(w => ({
            id: w.id,
            name: w.name,
            position: w.position,
            visible: w.visibility === 'Visible',
        }));
    }

    /**
     * Lê um intervalo (ex.: 'A1:F50'). Sem intervalo, devolve a região usada da
     * aba - que é o que se quer em 90% dos casos e evita varrer 1M de linhas
     * vazias que o Excel considera parte da planilha.
     */
    async readWorksheetRange(user, driveId, itemId, sheetName, range = null) {
        const base = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`;
        const path = range
            ? `${base}/range(address='${encodeURIComponent(range)}')`
            : `${base}/usedRange(valuesOnly=true)`;

        const data = await graphService.get(user, `${path}?$select=address,rowCount,columnCount,values,text`);

        return {
            sheet: sheetName,
            address: data.address || null,
            rows: data.rowCount ?? 0,
            columns: data.columnCount ?? 0,
            // `values` traz o valor bruto (número/data como serial) e `text` o que
            // aparece na tela. Os dois vão: número serve para conta, texto para ler.
            values: data.values || [],
            text: data.text || [],
        };
    }

    /** Nomes definidos da pasta de trabalho — atalho para intervalo nomeado. */
    async listWorkbookNames(user, driveId, itemId) {
        const data = await graphService.get(user,
            `/drives/${driveId}/items/${itemId}/workbook/names?$select=name,value,comment`
        );
        return (data.value || []).map(n => ({ name: n.name, value: n.value, comment: n.comment || null }));
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
