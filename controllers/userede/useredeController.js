// controllers/userede/useredeController.js
//
// Configurações do Link de Cartão (Userede).
//
// Regra de ouro das credenciais: elas ENTRAM por aqui (cifradas antes de tocar
// o banco) e NUNCA saem. O GET devolve só `usuario_set`/`senha_set`, do mesmo
// jeito que o boleto faz com a senha do Ecobrança.
import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { withSession, marcarPrecisaHumano } from '../../services/userede/UseredeSessionService.js';
import { abrirLinkPagamento } from '../../playwright/modules/userede/navegacao.js';

// Limites FÍSICOS do portal, medidos na tela (20/08/2026). Não são preferência
// nossa: acima disto o formulário da Rede simplesmente não aceita.
const REDE_MAX_PARCELAS = 12;
const REDE_MAX_DIAS_VENCIMENTO = 15;
const REDE_MAX_VALOR = 30000;

async function getRow() {
    const [row] = await db.UseredeSettings.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
    return row;
}

/** Serializa para a tela, sem jamais devolver credencial ou sessão. */
function toPublic(row) {
    const json = row.toJSON();
    json.usuario_set = !!json.usuario;
    json.senha_set = !!json.senha;
    json.session_set = !!json.session_state;
    delete json.usuario;
    delete json.senha;
    delete json.session_state;
    // Limites do portal viajam junto para a tela poder validar e explicar.
    json.limites_rede = {
        max_parcelas: REDE_MAX_PARCELAS,
        max_dias_vencimento: REDE_MAX_DIAS_VENCIMENTO,
        max_valor: REDE_MAX_VALOR,
    };
    return json;
}

export async function getSettings(req, res) {
    try {
        const row = await getRow();
        return res.json(toPublic(row));
    } catch (err) {
        console.error('[UREDE] getSettings:', err);
        return res.status(500).json({ error: 'Falha ao carregar as configurações.' });
    }
}

export async function updateSettings(req, res) {
    try {
        const row = await getRow();
        const body = req.body || {};
        const updates = {};

        // ── Credenciais: cifra ANTES de gravar; string vazia = "não mexer" ────
        for (const campo of ['usuario', 'senha']) {
            if (body[campo] !== undefined && String(body[campo]).trim() !== '') {
                updates[campo] = encrypt(String(body[campo]).trim());
            }
        }
        // Trocar de usuário invalida a sessão salva — ela pertence à conta antiga.
        if (updates.usuario) {
            updates.session_state = null;
            updates.session_valida_em = null;
        }

        // ── Campos simples ────────────────────────────────────────────────────
        for (const campo of [
            'pv_principal', 'idserie_credito', 'cv_idtipo_documento',
            'situacao_sucesso_id', 'situacao_erro_id', 'situacao_pago_id', 'active',
        ]) {
            if (body[campo] !== undefined) updates[campo] = body[campo];
        }

        // ── Numéricos com teto do portal ──────────────────────────────────────
        if (body.max_parcelas !== undefined) {
            const n = Number(body.max_parcelas);
            if (!Number.isInteger(n) || n < 1 || n > REDE_MAX_PARCELAS) {
                return res.status(400).json({
                    error: `O limite de parcelas deve ser um inteiro entre 1 e ${REDE_MAX_PARCELAS} — o portal da Rede não aceita mais que isso.`,
                });
            }
            updates.max_parcelas = n;
        }

        if (body.max_dias_vencimento !== undefined) {
            const n = Number(body.max_dias_vencimento);
            if (!Number.isInteger(n) || n < 0 || n > REDE_MAX_DIAS_VENCIMENTO) {
                return res.status(400).json({
                    error: `O prazo máximo deve ser um inteiro entre 0 e ${REDE_MAX_DIAS_VENCIMENTO} dias — é o maior prazo que o portal da Rede oferece.`,
                });
            }
            updates.max_dias_vencimento = n;
        }

        if (body.valor_maximo !== undefined) {
            const raw = body.valor_maximo;
            if (raw === '' || raw === null) {
                // Vazio aqui NÃO vira "sem teto": o portal tem o dele (30 mil) e
                // emitir sem trava foi justamente o que gerou boleto de 11 milhões.
                updates.valor_maximo = REDE_MAX_VALOR;
            } else {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0 || n > REDE_MAX_VALOR) {
                    return res.status(400).json({
                        error: `O teto por link deve ser maior que zero e no máximo R$ ${REDE_MAX_VALOR.toLocaleString('pt-BR')} — limite do portal da Rede.`,
                    });
                }
                updates.valor_maximo = n;
            }
        }

        updates.updated_by = req.user?.id || null;
        await row.update(updates);

        return res.json(toPublic(await getRow()));
    } catch (err) {
        console.error('[UREDE] updateSettings:', err);
        return res.status(500).json({ error: 'Falha ao salvar as configurações.' });
    }
}

/**
 * Testa a conexão de verdade: abre o portal com a sessão salva e, se ela caiu,
 * faz o login com a credencial guardada — exatamente o que a emissão fará.
 *
 * Devolve 200 mesmo quando falha, com `ok: false` e o diagnóstico, porque a
 * tela quer MOSTRAR o motivo (sessão expirada, 2º fator, credencial errada) e
 * não tratar como erro de API.
 */
export async function testConnection(req, res) {
    const inicio = Date.now();
    try {
        const row = await getRow();
        if (!row.usuario || !row.senha) {
            return res.json({
                ok: false,
                etapa: 'credenciais',
                mensagem: 'Cadastre usuário e senha antes de testar.',
            });
        }
        // Sem exigir `active`: testar credencial é justamente o que se faz ANTES
        // de ligar a automação. `active` governa o webhook, não o acesso ao portal.
        const info = await withSession(async ({ page }) => {
            // Prova de que estamos autenticados DENTRO do produto que interessa,
            // e não só na home: o Link de Pagamento é o que a emissão usa.
            // Vai pelo MENU - a URL direta devolve 404 e cai na página de erro
            // (ver playwright/modules/userede/navegacao.js).
            await abrirLinkPagamento(page);

            const estabelecimento = await page
                .getByText(/\(\d{6,}\)/).first().textContent({ timeout: 10000 })
                .catch(() => null);

            return { url: page.url(), estabelecimento: (estabelecimento || '').trim() || null };
        });

        const atualizado = await getRow();
        return res.json({
            ok: true,
            etapa: 'conectado',
            mensagem: 'Conexão com o portal Userede confirmada.',
            estabelecimento: info.estabelecimento,
            url: info.url,
            duracao_ms: Date.now() - inicio,
            session_valida_em: atualizado.session_valida_em,
        });
    } catch (err) {
        // Erros esperados viram diagnóstico, não 500.
        const etapa = err.uredeMfeFalhou ? 'mfe_instavel'
            : err.uredeExigeHumano ? 'verificacao_humana'
            : err.uredeCredencialInvalida ? 'credencial_invalida'
            : 'falha';

        if (etapa === 'falha') console.error('[UREDE] testConnection:', err);

        return res.json({
            ok: false,
            etapa,
            mensagem: err.message,
            duracao_ms: Date.now() - inicio,
        });
    }
}

/**
 * Zera a sessão salva. Usado quando o portal pediu verificação humana e alguém
 * quer forçar um login limpo no próximo uso.
 */
export async function resetSession(req, res) {
    try {
        const row = await getRow();
        await row.update({
            session_state: null,
            session_valida_em: null,
            session_precisa_humano: false,
            session_ultimo_erro: null,
        });
        return res.json({ ok: true, mensagem: 'Sessão descartada. O próximo uso fará login novo.' });
    } catch (err) {
        console.error('[UREDE] resetSession:', err);
        return res.status(500).json({ error: 'Falha ao descartar a sessão.' });
    }
}

export default { getSettings, updateSettings, testConnection, resetSession };
