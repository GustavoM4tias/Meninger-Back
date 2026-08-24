// api/controllers/platformController.js
//
// Estado do MURAL DA PLATAFORMA para o usuário logado.
//
// O back não sabe o que é uma release nem quantas existem: o catálogo vive no
// front (`src/config/changelog.js`, o mesmo da tela /docs). Aqui só mora a
// resposta para "até onde essa pessoa já leu" — e é isso que faz o modal de
// novidades abrir uma vez só, em qualquer aparelho.
import db from '../models/sequelize/index.js';

const { User } = db;

/**
 * GET /api/platform/updates/state
 * → { lastSeenRelease: 'v3.12.0' | null }
 */
export const getUpdatesState = async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, { attributes: ['id', 'last_seen_release'] });
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
        return res.json({ lastSeenRelease: user.last_seen_release || null });
    } catch (err) {
        console.error('[platform/getUpdatesState]', err);
        return res.status(500).json({ error: 'Falha ao carregar o estado das novidades.' });
    }
};

/**
 * POST /api/platform/updates/seen  { version: 'v3.13.0' }
 *
 * Grava a versão como lida. Nunca ANDA PARA TRÁS: numa aba antiga aberta desde
 * antes da publicação, o "Entendi" mandaria uma versão velha e ressuscitaria o
 * modal na próxima abertura.
 */
export const markUpdatesSeen = async (req, res) => {
    try {
        const version = String(req.body?.version || '').trim();
        if (!version) return res.status(400).json({ error: 'version é obrigatório.' });
        if (version.length > 20) return res.status(400).json({ error: 'version inválida.' });

        const user = await User.findByPk(req.user.id, { attributes: ['id', 'last_seen_release'] });
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

        if (compareVersions(version, user.last_seen_release) > 0) {
            user.last_seen_release = version;
            await user.save();
        }

        return res.json({ lastSeenRelease: user.last_seen_release });
    } catch (err) {
        console.error('[platform/markUpdatesSeen]', err);
        return res.status(500).json({ error: 'Falha ao salvar as novidades como lidas.' });
    }
};

/**
 * Compara 'v3.13.0' com 'v3.9.0' NUMERICAMENTE, campo a campo. Comparar como
 * texto diria que v3.9.0 é maior que v3.13.0 — e o modal nunca mais apareceria.
 * @returns {number} >0 se a for maior, <0 se menor, 0 se iguais
 */
function compareVersions(a, b) {
    const partes = (v) => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const pa = partes(a);
    const pb = partes(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}
