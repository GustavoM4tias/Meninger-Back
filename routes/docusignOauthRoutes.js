// routes/docusignOauthRoutes.js
// Callback PÚBLICO do login DocuSign ("Conectar com DocuSign").
// Sem authenticate: o navegador chega aqui redirecionado pelo DocuSign, sem JWT
// do Office. A segurança vem do `state` assinado (emitido só para admins pelo
// endpoint autenticado /api/conditions/docusign/oauth-url, expira em 15min).
import express from 'express';
import { oauthCallback } from '../controllers/comercial/docusignController.js';

const router = express.Router();

router.get('/callback', oauthCallback);

export default router;
