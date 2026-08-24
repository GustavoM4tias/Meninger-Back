// services/microsoft/MicrosoftGraphService.js
//
// Cliente base para a Microsoft Graph API.
// Todos os módulos futuros (SharePoint, Teams, Gravações) usam este serviço.
// Gerencia token automaticamente via MicrosoftAuthService.getValidToken().

import axios from 'axios';
import { marcarErroDePermissao } from '../../lib/microsoftPermissoes.js';
import microsoftAuthService from './MicrosoftAuthService.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

class MicrosoftGraphService {

    /**
     * Realiza uma chamada autenticada à Graph API em nome do usuário.
     * Faz refresh do token automaticamente se necessário.
     *
     * @param {object} user        - Instância Sequelize do User (com microsoft_* fields)
     * @param {string} method      - 'get' | 'post' | 'patch' | 'delete'
     * @param {string} path        - Caminho da Graph API (ex: '/me', '/me/drive/root/children')
     * @param {object} [options]
     * @param {object} [options.data]   - Corpo da requisição (POST/PATCH)
     * @param {object} [options.params] - Query string params
     * @throws {Error} Se usuário não tiver Microsoft conectado ou token inválido
     */
    async call(user, method, path, { data, params, headers: extraHeaders } = {}) {
        const token = await microsoftAuthService.getValidToken(user);

        if (!token) {
            throw new Error('Conta Microsoft não conectada ou sessão expirada. Faça login novamente.');
        }

        try {
            const { data: result } = await axios({
                method,
                url: `${GRAPH_BASE}${path}`,
                headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
                data,
                params,
            });
            return result;
        } catch (err) {
            const status = err?.response?.status;
            const graphError = err?.response?.data?.error;
            const innerCode  = graphError?.innerError?.code;

            if (status === 401) throw new Error('Sessão Microsoft expirada. Por favor, reconecte sua conta Microsoft.');
            if (status === 403) {
                // O 403 vira frase acionável: qual permissão falta, de que tipo
                // e o que ela destrava. O front avisa com isso toda vez que a
                // pessoa tentar - pedido de liberação só sai do papel quando
                // alguém vê o nome da permissão que falta.
                const e = new Error(`Permissão insuficiente para esta operação Microsoft. Código: ${graphError?.code || 'Forbidden'}`);
                throw marcarErroDePermissao(e, path, method);
            }
            if (status === 423 || innerCode === 'resourceLocked') {
                throw new Error('O arquivo está aberto no Office Online ou por outro usuário. Feche-o e tente novamente.');
            }
            if (graphError?.code === 'notAllowed' && innerCode === 'resourceLocked') {
                throw new Error('O arquivo está aberto no Office Online ou por outro usuário. Feche-o e tente novamente.');
            }

            throw err;
        }
    }

    // ── Atalhos por método ────────────────────────────────────────────────────

    /** GET /v1.0{path} */
    get(user, path, params, extraHeaders) {
        return this.call(user, 'get', path, { params, headers: extraHeaders });
    }

    /**
     * GET paginado: segue o @odata.nextLink até acabar a coleção ou bater o teto.
     *
     * O Graph devolve no máximo o que couber numa página ($top é sugestão, não
     * garantia) e o resto vem em @odata.nextLink. Sem seguir esse link, uma
     * biblioteca com 501 arquivos mostrava 500 e dizia que tinha acabado — corte
     * silencioso, que é justamente o que não pode acontecer.
     *
     * @returns {{ items: any[], truncated: boolean, pages: number }}
     *   `truncated` = bateu no teto e AINDA havia mais; quem chama precisa dizer
     *   isso na tela em vez de fingir que a lista está completa.
     */
    async getAllPages(user, path, params, { max = 5000, headers } = {}) {
        const items = [];
        let nextPath = path;
        let nextParams = params;
        let pages = 0;
        let truncated = false;

        while (nextPath) {
            const data = await this.call(user, 'get', nextPath, { params: nextParams, headers });
            pages++;

            if (Array.isArray(data?.value)) items.push(...data.value);
            else if (data) items.push(data);

            const nextLink = data?.['@odata.nextLink'];
            if (!nextLink) break;

            if (items.length >= max) { truncated = true; break; }

            // O nextLink vem absoluto e já carrega toda a query string original.
            nextPath = nextLink.replace(GRAPH_BASE, '');
            nextParams = undefined;
        }

        return { items: items.slice(0, max), truncated, pages };
    }

    /** POST /v1.0{path} */
    post(user, path, data) {
        return this.call(user, 'post', path, { data });
    }

    /** PATCH /v1.0{path} */
    patch(user, path, data) {
        return this.call(user, 'patch', path, { data });
    }

    /** PUT /v1.0{path} — para uploads binários */
    async put(user, path, body, contentType = 'application/octet-stream') {
        const token = await microsoftAuthService.getValidToken(user);
        if (!token) throw new Error('Conta Microsoft não conectada ou sessão expirada. Faça login novamente.');
        try {
            const { data: result } = await axios.put(`${GRAPH_BASE}${path}`, body, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            return result;
        } catch (err) {
            const status = err?.response?.status;
            if (status === 401) throw new Error('Sessão Microsoft expirada. Por favor, reconecte sua conta Microsoft.');
            if (status === 403) {
                const e = new Error(`Permissão insuficiente para esta operação Microsoft. Código: ${err?.response?.data?.error?.code || 'Forbidden'}`);
                throw marcarErroDePermissao(e, path, 'put');
            }
            throw err;
        }
    }

    /** DELETE /v1.0{path} */
    delete(user, path) {
        return this.call(user, 'delete', path);
    }

    /**
     * Streaming GET — retorna o response axios com responseType:'stream'.
     * Usado para proxy de arquivos binários (download, preview).
     */
    async stream(user, path) {
        const token = await microsoftAuthService.getValidToken(user);
        if (!token) throw new Error('Conta Microsoft não conectada ou sessão expirada.');
        const response = await axios.get(`${GRAPH_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'stream',
            maxRedirects: 10,
        });
        return response;
    }

    // ── Helpers comuns ────────────────────────────────────────────────────────

    /** Retorna o perfil do usuário logado na Microsoft (/me) */
    getMyProfile(user) {
        return this.get(user, '/me');
    }

    /** Retorna foto do perfil como buffer (para exibir no frontend) */
    async getMyPhoto(user) {
        const token = await microsoftAuthService.getValidToken(user);
        if (!token) return null;

        try {
            const { data } = await axios.get(`${GRAPH_BASE}/me/photo/$value`, {
                headers: { Authorization: `Bearer ${token}` },
                responseType: 'arraybuffer',
            });
            return Buffer.from(data).toString('base64');
        } catch {
            return null; // sem foto cadastrada: retorna null sem erro
        }
    }

    // ── App-only (sem usuário delegado) ───────────────────────────────────────
    // Usa token de aplicação (client credentials) via getAppToken(). Necessário
    // para operar em nome de QUALQUER usuário em /users/{microsoft_id}/... — é o
    // caminho do módulo To Do (Tasks.ReadWrite.All já consentido pelo admin).

    async appCall(method, path, { data, params, headers: extraHeaders } = {}) {
        const token = await microsoftAuthService.getAppToken();
        try {
            const { data: result } = await axios({
                method,
                url: `${GRAPH_BASE}${path}`,
                headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
                data,
                params,
            });
            return result;
        } catch (err) {
            const status = err?.response?.status;
            const graphError = err?.response?.data?.error;
            if (status === 401) throw new Error('Falha de autenticação da aplicação Microsoft (app token).');
            if (status === 403) {
                const e = new Error(`Permissão de aplicação insuficiente para esta operação. Código: ${graphError?.code || 'Forbidden'}`);
                throw marcarErroDePermissao(e, path, method);
            }
            if (status === 404) throw new Error(graphError?.message || 'Recurso Microsoft não encontrado.');
            throw err;
        }
    }

    /** GET app-only /v1.0{path} */
    appGet(path, params) { return this.appCall('get', path, { params }); }

    /** GET app-only paginado — mesma mecânica de getAllPages, sem usuário. */
    async appGetAllPages(path, params, { max = 5000, headers } = {}) {
        const items = [];
        let nextPath = path;
        let nextParams = params;
        let truncated = false;

        while (nextPath) {
            const data = await this.appCall('get', nextPath, { params: nextParams, headers });
            if (Array.isArray(data?.value)) items.push(...data.value);
            else if (data) items.push(data);

            const nextLink = data?.['@odata.nextLink'];
            if (!nextLink) break;
            if (items.length >= max) { truncated = true; break; }

            nextPath = nextLink.replace(GRAPH_BASE, '');
            nextParams = undefined;
        }

        return { items: items.slice(0, max), truncated };
    }

    /**
     * Streaming GET app-only — usado para baixar anexo de e-mail sem carregar o
     * arquivo inteiro na memória do processo.
     */
    async appStream(path) {
        const token = await microsoftAuthService.getAppToken();
        return axios.get(`${GRAPH_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'stream',
            maxRedirects: 10,
        });
    }
    /** POST app-only /v1.0{path} */
    appPost(path, data) { return this.appCall('post', path, { data }); }
    /** PATCH app-only /v1.0{path} */
    appPatch(path, data) { return this.appCall('patch', path, { data }); }
    /** DELETE app-only /v1.0{path} */
    appDelete(path) { return this.appCall('delete', path); }
}

export default new MicrosoftGraphService();
