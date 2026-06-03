// controllers/shortLink/shortLinkController.js
import ShortLinkService from '../../services/shortLink/ShortLinkService.js';

/**
 * Endpoint público: GET /s/:slug
 * Resolve o slug e faz redirect 302 pra target_url. Incrementa contador
 * de cliques fire-and-forget. Sem autenticação — é o caminho do cliente
 * final que recebeu o link.
 */
export async function publicRedirect(req, res) {
    const { slug } = req.params;
    try {
        const row = await ShortLinkService.resolve(slug);
        if (!row) {
            return res.status(404).type('text/plain').send('Link não encontrado.');
        }
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
            return res.status(410).type('text/plain').send('Link expirado.');
        }

        // Fire-and-forget: bumpClicks não bloqueia o redirect.
        ShortLinkService.bumpClicks(row.id);

        // 302 (temporário) — se um dia mudarmos o target_url, clients respeitam.
        return res.redirect(302, row.target_url);
    } catch (err) {
        console.error(`[ShortLink] redirect ${slug} falhou:`, err.message);
        return res.status(500).type('text/plain').send('Erro ao processar link.');
    }
}
