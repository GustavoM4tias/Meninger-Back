// controllers/correspondentPublicController.js
//
// Auto-cadastro da equipe pela própria correspondente, via link do Office.
// Nada aqui confia no que chega: a empresa vem SEMPRE do convite (nunca do
// corpo da requisição) e a resposta não devolve id interno nem erro cru do CV.

import correspondentService from '../services/correspondent/correspondentService.js';
import { parsePessoas, cpfValido } from '../services/correspondent/correspondentParser.js';

const LIMITE_POR_ENVIO = 60;

const falha = (res, err) =>
    res.status(err?.statusCode || 500).json({ ok: false, error: err?.message || 'Erro inesperado.' });

/** Dados mínimos para a página pública se identificar. */
export async function getPublicInvite(req, res) {
    try {
        const convite = await correspondentService.resolverConvite(req.params.token);
        return res.json({
            ok: true,
            convite: {
                label: convite.label,
                empresa: convite.company?.nome || null,
                cidade: convite.company?.cidade || null,
                estado: convite.company?.estado || null,
                expira_em: convite.expires_at,
            },
        });
    } catch (err) {
        return falha(res, err);
    }
}

/** Prévia da colagem, para a correspondente conferir antes de enviar. */
export async function previewPublicInvite(req, res) {
    try {
        await correspondentService.resolverConvite(req.params.token);
        const { pessoas, ignorados } = parsePessoas(req.body?.texto);
        return res.json({ ok: true, pessoas, ignorados });
    } catch (err) {
        return falha(res, err);
    }
}

export async function submitPublicInvite(req, res) {
    try {
        // Honeypot: campo escondido no form; robô preenche, gente não.
        if (req.body?.website) return res.json({ ok: true, resultado: [] });

        const pessoas = Array.isArray(req.body?.pessoas) ? req.body.pessoas : [];
        if (!pessoas.length) {
            return res.status(400).json({ ok: false, error: 'Informe ao menos uma pessoa.' });
        }
        if (pessoas.length > LIMITE_POR_ENVIO) {
            return res.status(400).json({ ok: false, error: `Máximo de ${LIMITE_POR_ENVIO} pessoas por envio.` });
        }

        // Validação no servidor: a página pública não é fonte confiável.
        const limpas = [];
        for (const p of pessoas) {
            const nome = String(p?.nome || '').trim();
            const email = String(p?.email || '').trim().toLowerCase();
            const documento = String(p?.documento || '').replace(/\D/g, '');

            if (!nome || nome.length < 3) {
                return res.status(400).json({ ok: false, error: `Nome inválido em "${nome || 'linha sem nome'}".` });
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ ok: false, error: `E-mail inválido em "${nome}".` });
            }
            if (!cpfValido(documento)) {
                return res.status(400).json({ ok: false, error: `CPF inválido em "${nome}".` });
            }
            limpas.push({
                nome,
                email,
                documento,
                data_nasc: /^\d{4}-\d{2}-\d{2}$/.test(p?.data_nasc || '') ? p.data_nasc : null,
                gerente: p?.gerente !== false,
            });
        }

        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
        const out = await correspondentService.submeterConvite({ token: req.params.token, pessoas: limpas, ip });
        return res.json({ ok: true, ...out });
    } catch (err) {
        return falha(res, err);
    }
}

export default { getPublicInvite, previewPublicInvite, submitPublicInvite };
