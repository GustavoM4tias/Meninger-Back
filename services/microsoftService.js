import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const {
    MICROSOFT_TENANT_ID,
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI
} = process.env;

export const getAuthUrl = () => {
    return (
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?` +
        new URLSearchParams({
            client_id: MICROSOFT_CLIENT_ID,
            response_type: 'code',
            redirect_uri: MICROSOFT_REDIRECT_URI,
            response_mode: 'query',
            scope: 'User.Read offline_access',
            state: '12345',
        })
    );
};

export const exchangeCodeForToken = async (code) => {
    const params = new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        scope: 'User.Read offline_access',
        code,
        redirect_uri: MICROSOFT_REDIRECT_URI,
        grant_type: 'authorization_code',
        client_secret: MICROSOFT_CLIENT_SECRET
    });

    const response = await axios.post(
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return response.data;
};

export const refreshToken = async (refreshToken) => {
    const params = new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        scope: 'User.Read offline_access',
        refresh_token: refreshToken,
        redirect_uri: MICROSOFT_REDIRECT_URI,
        grant_type: 'refresh_token',
        client_secret: MICROSOFT_CLIENT_SECRET
    });

    const response = await axios.post(
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return response.data;
};
