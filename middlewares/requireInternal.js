// src/middlewares/requireInternal.js
//
// Bloqueia usuários EXTERNOS (corretor/imobiliária/correspondente que entram
// pelo login do Academy via código de e-mail). Funcionários Menin são internos
// — independente de terem logado por senha ('INTERNAL') ou SSO ('MICROSOFT').
//
// Sinal de externo: auth_provider 'CVCRM' OU external_kind preenchido
// (definidos em authExternalController). Qualquer outro provider é interno.
export default function requireInternal(req, res, next) {
    const provider = String(req.user?.auth_provider || 'INTERNAL').toUpperCase();
    const externalKind = req.user?.external_kind;
    const isExternal = provider === 'CVCRM' || !!externalKind;

    if (isExternal) {
        return res.status(403).json({
            success: false,
            message: 'Acesso restrito ao Office (apenas usuários internos).',
        });
    }
    next();
}
