// services/microsoft/MicrosoftGraphService.js
//
// Cliente base para a Microsoft Graph API.
// Todos os módulos futuros (SharePoint, Teams, Gravações) usam este serviço.
// Gerencia token automaticamente via MicrosoftAuthService.getValidToken().

import axios from 'axios';
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
            if (status === 403) throw new Error(`Permissão insuficiente para esta operação Microsoft. Código: ${graphError?.code || 'Forbidden'}`);
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
            if (status === 403) throw new Error(`Permissão insuficiente para esta operação Microsoft. Código: ${err?.response?.data?.error?.code || 'Forbidden'}`);
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
}

export default new MicrosoftGraphService();
