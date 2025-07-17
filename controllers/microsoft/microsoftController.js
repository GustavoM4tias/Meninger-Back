import { getAuthUrl, exchangeCodeForToken, refreshToken } from '../../services/microsoftService.js';
import db from '../../models/sequelize/index.js';
import axios from 'axios';

export const loginMicrosoft = (req, res) => {
    const authUrl = getAuthUrl();
    console.log('🔗 URL de login:', authUrl);
    res.redirect(authUrl);
};

export const callbackMicrosoft = async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('❌ Code ausente na URL.');

    try {
        const data = await exchangeCodeForToken(code);

        // ⚠️ Aqui definimos qual user está logado (por enquanto hardcoded para o teste)
        const user = await db.User.findOne({ where: { email: 'gustavo.diniz@menin.com.br' } });

        if (!user) return res.status(404).send('Usuário não encontrado.');

        await user.update({
            microsoft_access_token: data.access_token,
            microsoft_refresh_token: data.refresh_token,
            microsoft_token_expiry: new Date(Date.now() + data.expires_in * 1000)
        });

        console.log('✅ Tokens salvos para o usuário.');

        res.send('✅ Autenticado com sucesso. Pode fechar esta aba.');
    } catch (err) {
        console.error('❌ Erro ao processar callback:', err.response?.data || err.message);
        res.status(500).send('Erro ao autenticar.');
    }
};

export const getMicrosoftMe = async (req, res) => {
    const user = await db.User.findOne({ where: { email: 'gustavo.diniz@menin.com.br' } });

    if (!user || !user.microsoft_access_token) {
        return res.status(401).send('Usuário não autenticado com a Microsoft.');
    }

    let token = user.microsoft_access_token;

    // Se expirado, faz refresh
    if (!user.microsoft_token_expiry || new Date() > user.microsoft_token_expiry) {
        console.log('🔄 Token expirado. Fazendo refresh...');
        const refreshed = await refreshToken(user.microsoft_refresh_token);

        await user.update({
            microsoft_access_token: refreshed.access_token,
            microsoft_refresh_token: refreshed.refresh_token,
            microsoft_token_expiry: new Date(Date.now() + refreshed.expires_in * 1000)
        });

        token = refreshed.access_token;
    }

    try {
        const response = await axios.get('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('📥 /me retornado:', response.data);
        res.json(response.data);
    } catch (err) {
        console.error('❌ Erro ao buscar /me:', err.response?.data || err.message);
        res.status(500).send('Erro ao consultar Microsoft Graph.');
    }
};
