// controllers/aditivos/assinaturaPublicaController.js
//
// API PÚBLICA da assinatura de aditivo. Quem mostra a tela é a LP
// (lp.menin.com.br/aditivo/<token>) — o cliente nunca vê a URL do backend.
//
// Por que existe: no DocuSign o link do e-mail não é acessível por API, e o
// link do modo "embedded" vive poucos minutos. Aqui o token é fixo e a URL do
// DocuSign é gerada no clique, então o link mandado por WhatsApp nunca expira.
//
// Antes de liberar, o assinante confirma o CPF. Sem isso, qualquer um com o
// link assinaria no lugar dele.
import db from '../../models/sequelize/index.js';
import Docusign from '../../services/comercial/DocusignService.js';

const { AditivoSignature } = db;

const MAX_TENTATIVAS = 10;
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

// Base pública do link do cliente: é a LP, não o backend nem o Office.
export function basePublica() {
    const raw = process.env.ADITIVO_LINK_BASE || 'https://lp.menin.com.br';
    return String(raw).replace(/\/+$/, '');
}

// Token na raiz da LP para o link ficar curto no WhatsApp.
export const linkPublico = (token) => `${basePublica()}/${token}`;

// Varre os envelopes procurando o token. São dezenas de linhas por
// empreendimento — não vale índice em JSONB por enquanto.
async function acharPorToken(token) {
    if (!token || token.length < 12) return null;
    const linhas = await AditivoSignature.findAll({ order: [['id', 'DESC']] });
    for (const linha of linhas) {
        const idx = (linha.signers ?? []).findIndex((s) => s?.token === token);
        if (idx >= 0) return { linha, idx, signer: linha.signers[idx] };
    }
    return null;
}

async function gravarSigner(linha, idx, patch) {
    const signers = [...(linha.signers ?? [])];
    signers[idx] = { ...signers[idx], ...patch };
    await linha.update({ signers });
    return signers[idx];
}

// GET /api/aditivos/assinatura/:token — o que a LP precisa para montar a tela.
// Nunca devolve CPF, e-mail ou dados dos outros assinantes.
export async function consultar(req, res) {
    try {
        const achado = await acharPorToken(req.params.token);
        if (!achado) return res.status(404).json({ error: 'Link não encontrado.' });

        const { linha, idx, signer } = achado;
        await gravarSigner(linha, idx, {
            clicks: (signer.clicks ?? 0) + 1,
            opened_at: signer.opened_at ?? new Date().toISOString(),
        });

        return res.json({
            assinante: signer.nome,
            unidade: linha.unidade,
            empreendimento: linha.empreendimento,
            documento: 'Aditivo contratual - cláusula 13 (prazo de entrega)',
            assinado: signer.status === 'completed',
            cancelado: ['voided', 'declined'].includes(linha.status),
            bloqueado: (signer.cpf_fails ?? 0) >= MAX_TENTATIVAS,
        });
    } catch (e) {
        console.error('[aditivo/assinatura] consultar:', e);
        return res.status(500).json({ error: 'Não foi possível abrir o documento.' });
    }
}

// POST /api/aditivos/assinatura/:token/abrir { cpf } → { url }
export async function abrir(req, res) {
    try {
        const achado = await acharPorToken(req.params.token);
        if (!achado) return res.status(404).json({ error: 'Link não encontrado.' });

        const { linha, idx, signer } = achado;
        if (['voided', 'declined'].includes(linha.status)) {
            return res.status(410).json({ error: 'Este aditivo foi cancelado. Fale com o seu corretor.' });
        }

        const tentativas = signer.cpf_fails ?? 0;
        if (tentativas >= MAX_TENTATIVAS) {
            return res.status(429).json({ error: 'Muitas tentativas com CPF incorreto. Fale com o seu corretor para liberar o acesso.' });
        }

        if (soDigitos(req.body?.cpf) !== soDigitos(signer.cpf)) {
            const atualizado = await gravarSigner(linha, idx, { cpf_fails: tentativas + 1 });
            const restam = MAX_TENTATIVAS - (atualizado.cpf_fails ?? 0);
            return res.status(401).json({
                error: 'CPF não confere com o cadastro deste documento.',
                tentativas_restantes: restam,
            });
        }

        const url = await Docusign.createRecipientView({
            envelopeId: linha.envelope_id,
            clientUserId: signer.client_user_id,
            name: signer.nome,
            email: signer.email,
            returnUrl: `${linkPublico(req.params.token)}/pronto`,
        });

        await gravarSigner(linha, idx, { cpf_fails: 0, last_view_at: new Date().toISOString() });
        return res.json({ url });
    } catch (e) {
        console.error('[aditivo/assinatura] abrir:', e);
        return res.status(500).json({ error: 'Não foi possível abrir a assinatura. Tente de novo em alguns minutos.' });
    }
}

// POST /api/aditivos/assinatura/:token/retorno { event } — o DocuSign devolve o
// assinante para a LP e ela avisa aqui. O `event` é só uma pista: quem diz se
// assinou é o próprio DocuSign, consultado na hora.
export async function retorno(req, res) {
    try {
        const achado = await acharPorToken(req.params.token);
        if (!achado) return res.status(404).json({ error: 'Link não encontrado.' });

        const { linha, idx } = achado;
        const evento = String(req.body?.event || req.query.event || '');

        let assinado = false;
        try {
            const info = await Docusign.getEnvelopeStatus(linha.envelope_id);
            const signers = [...(linha.signers ?? [])];
            for (const s of signers) {
                const doDs = (info.signers ?? []).find((d) => d.email === s.email && d.name === s.nome);
                if (!doDs) continue;
                if (doDs.status === 'completed') {
                    s.status = 'completed';
                    s.signed_at = doDs.signed_at ?? s.signed_at ?? new Date().toISOString();
                } else if (doDs.status === 'declined') {
                    s.status = 'declined';
                }
            }
            assinado = signers[idx]?.status === 'completed';
            await linha.update({
                signers,
                status: info.status ?? linha.status,
                completed_at: info.status === 'completed' ? (info.completedDateTime ?? new Date()) : linha.completed_at,
            });
        } catch (e) {
            // DocuSign fora do ar não pode quebrar a página de retorno do cliente.
            console.error('[aditivo/assinatura] retorno/status:', e.message);
        }

        return res.json({ evento, assinado });
    } catch (e) {
        console.error('[aditivo/assinatura] retorno:', e);
        return res.status(500).json({ error: 'Erro ao registrar o retorno.' });
    }
}
