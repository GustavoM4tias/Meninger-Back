// controllers/microsoft/MicrosoftOutlookAiController.js
//
// A IA da caixa de e-mail. Mesmas duas regras do MicrosoftOutlookController,
// porque é a mesma caixa:
//
// 1. A CAIXA NUNCA VEM DO CLIENTE. `_resolveMailbox` tira o endereço do usuário
//    autenticado. Nenhuma rota daqui aceita `?mailbox=` e nenhuma deve passar a
//    aceitar - o módulo usa token de APLICAÇÃO, então um parâmetro solto abriria
//    a caixa da empresa inteira.
//
// 2. LER É UMA CAPACIDADE, MANDAR É OUTRA. Triagem, leitura e relatório vão por
//    'view'; mexer na configuração da IA e nas regras vai por 'automate';
//    aprovar (que É enviar) vai por 'send'. Dá para liberar a triagem para
//    alguém sem dar a ela o poder de a IA responder no seu nome.

import db from '../../models/sequelize/index.js';
import ai from '../../services/microsoft/MicrosoftOutlookAiService.js';
import settingsService from '../../services/microsoft/MicrosoftSettingsService.js';

function fail(res, err, ctx) {
    if (err?.expose) return res.status(err.expose).json({ error: err.message });

    const status = err?.response?.status || 500;
    const graph = err?.response?.data?.error;
    console.error(`❌ [OutlookAI] ${ctx}:`, graph || err.message);

    if (status === 403) {
        return res.status(403).json({
            error: 'O Office ainda não tem permissão para esta operação no e-mail. '
                 + 'Falta liberar a permissão no portal do Azure - o administrador tem a lista.',
            code: graph?.code || '',
        });
    }
    if (status === 429) return res.status(429).json({ error: 'Muitas requisições à Microsoft. Aguarde alguns instantes.' });
    return res.status(status).json({ error: graph?.message || err.message });
}

class MicrosoftOutlookAiController {

    /** Única fonte permitida do endereço de caixa. */
    async _mailbox(req) {
        const user = await db.User.findByPk(req.user.id, {
            attributes: ['id', 'email', 'microsoft_id', 'username'],
        });
        if (!user?.microsoft_id) {
            const e = new Error('Sua conta Microsoft não está vinculada. Conecte em Minha Conta para usar o e-mail.');
            e.expose = 400;
            throw e;
        }
        return user.microsoft_id;
    }

    /** Kill-switch do módulo inteiro e da IA, ligados pela configuração. */
    async _guardarModulo() {
        const s = await settingsService.get();
        if (s.outlook_enabled === false) {
            const e = new Error('O módulo de e-mail está desligado na configuração da integração Microsoft.');
            e.expose = 503; throw e;
        }
        if (s.outlook_ai_enabled === false) {
            const e = new Error('A IA da caixa está desligada na configuração da integração Microsoft.');
            e.expose = 503; throw e;
        }
        return s;
    }

    // ── Configuração da pessoa ───────────────────────────────────────────────

    settings = async (req, res) => {
        try {
            await this._guardarModulo();
            const global = await settingsService.get();
            const cfg = await ai.getSettings(req.user.id);
            res.json({
                ...cfg,
                // A tela precisa dizer a verdade sobre a automação: a config da
                // pessoa pode estar em "responde sozinha" e mesmo assim nada
                // sair, porque o interruptor da empresa está desligado.
                automacaoLigadaNaEmpresa: global.outlook_ai_auto_enabled === true,
            });
        } catch (err) { fail(res, err, 'settings'); }
    };

    salvarSettings = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.saveSettings(req.user.id, req.body || {}));
        } catch (err) { fail(res, err, 'salvarSettings'); }
    };

    // ── Regras ───────────────────────────────────────────────────────────────

    regras = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.getRules(req.user.id));
        } catch (err) { fail(res, err, 'regras'); }
    };

    atualizarRegra = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.toggleRule(req.user.id, req.params.id, req.body || {}));
        } catch (err) { fail(res, err, 'atualizarRegra'); }
    };

    criarRegra = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.createRuleFromText(req.user.id, req.body?.texto));
        } catch (err) { fail(res, err, 'criarRegra'); }
    };

    excluirRegra = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.deleteRule(req.user.id, req.params.id));
        } catch (err) { fail(res, err, 'excluirRegra'); }
    };

    // ── Triagem ──────────────────────────────────────────────────────────────

    /**
     * O painel, direto do cache. INSTANTÂNEO - não fala com o Graph nem com o
     * Gemini.
     *
     * Antes esta rota classificava antes de responder, e a conta era cruel:
     * toda abertura pagava uma listagem no Graph e, se tivesse e-mail novo, os
     * ~25s do modelo. A tela ficava branca esperando. Agora ela pinta com o que
     * já foi lido e chama `atualizar` por fora - ver o comentário lá embaixo.
     */
    triagem = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.dashboard(req.user.id));
        } catch (err) { fail(res, err, 'triagem'); }
    };

    /**
     * A parte cara: lê o que chegou e classifica. A tela chama DEPOIS de já ter
     * pintado, e mostra "lendo o que chegou" enquanto roda.
     */
    atualizarTriagem = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            const passada = await ai.triage(req.user.id, mailbox, { force: req.query.force === '1' });
            const painel = await ai.dashboard(req.user.id);
            res.json({ ...painel, passada });
        } catch (err) { fail(res, err, 'atualizarTriagem'); }
    };

    leitura = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.leitura(req.user.id, req.params.id));
        } catch (err) { fail(res, err, 'leitura'); }
    };

    adiar = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.adiar(req.user.id, req.params.id));
        } catch (err) { fail(res, err, 'adiar'); }
    };

    /** Tira da lista dizendo por quê. Não toca na caixa de e-mail. */
    resolver = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.resolver(req.user.id, req.params.id, req.body || {}));
        } catch (err) { fail(res, err, 'resolver'); }
    };

    // ── Aprendizado ──────────────────────────────────────────────────────────

    feedback = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.listarFeedback(req.user.id));
        } catch (err) { fail(res, err, 'feedback'); }
    };

    comentar = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.registrarFeedback(req.user.id, req.body || {}));
        } catch (err) { fail(res, err, 'comentar'); }
    };

    aposentarFeedback = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.aposentarFeedback(req.user.id, req.params.id, req.body?.aplicado));
        } catch (err) { fail(res, err, 'aposentarFeedback'); }
    };

    // ── Trilho lateral ───────────────────────────────────────────────────────

    trilho = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            res.json(await ai.trilho(req.user.id, mailbox));
        } catch (err) { fail(res, err, 'trilho'); }
    };

    // ── Fila de aprovação ────────────────────────────────────────────────────

    fila = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.fila(req.user.id));
        } catch (err) { fail(res, err, 'fila'); }
    };

    redigir = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            res.json(await ai.redigir(req.user.id, mailbox, req.params.id, req.body || {}));
        } catch (err) { fail(res, err, 'redigir'); }
    };

    editarFila = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.atualizarFila(req.user.id, req.params.id, req.body || {}));
        } catch (err) { fail(res, err, 'editarFila'); }
    };

    /** Aprovar É enviar: por isso vive na capacidade 'send' e fica no log. */
    aprovar = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            const fila = await ai.aprovar(req.user.id, mailbox, req.params.id);
            console.log(`📧 [OutlookAI] usuário ${req.user.id} aprovou e enviou o item ${req.params.id} da fila.`);
            res.json(fila);
        } catch (err) { fail(res, err, 'aprovar'); }
    };

    descartar = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.descartar(req.user.id, req.params.id));
        } catch (err) { fail(res, err, 'descartar'); }
    };

    // ── Histórico ────────────────────────────────────────────────────────────

    historico = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.historico(req.user.id, { limite: req.query.limite }));
        } catch (err) { fail(res, err, 'historico'); }
    };

    desfazer = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            res.json(await ai.desfazer(req.user.id, mailbox, req.params.id));
        } catch (err) { fail(res, err, 'desfazer'); }
    };

    // ── Contexto ─────────────────────────────────────────────────────────────

    analisarContexto = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            res.json(await ai.analisarContexto(req.user.id, mailbox));
        } catch (err) { fail(res, err, 'analisarContexto'); }
    };

    aceitarContexto = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.aceitarSugestao(req.user.id));
        } catch (err) { fail(res, err, 'aceitarContexto'); }
    };

    descartarContexto = async (req, res) => {
        try {
            await this._guardarModulo();
            res.json(await ai.descartarSugestao(req.user.id));
        } catch (err) { fail(res, err, 'descartarContexto'); }
    };

    // ── Interruptores da empresa (admin) ─────────────────────────────────────
    //
    // Ficam AQUI, e não numa tela de configuração à parte, porque a tela de
    // diagnóstico da integração foi removida de propósito em 24/08. Gestão por
    // tela continua valendo: quem é admin vê este bloco dentro de Automações,
    // que é justamente onde a consequência aparece.

    configEmpresa = async (req, res) => {
        try {
            const s = await settingsService.get();
            res.json({
                outlook_ai_enabled: s.outlook_ai_enabled !== false,
                outlook_ai_auto_enabled: s.outlook_ai_auto_enabled === true,
                outlook_ai_triage_size: Number(s.outlook_ai_triage_size) || 40,
            });
        } catch (err) { fail(res, err, 'configEmpresa'); }
    };

    salvarConfigEmpresa = async (req, res) => {
        try {
            const b = req.body || {};
            const campos = {};

            if (b.outlook_ai_enabled !== undefined) campos.outlook_ai_enabled = !!b.outlook_ai_enabled;
            if (b.outlook_ai_auto_enabled !== undefined) campos.outlook_ai_auto_enabled = !!b.outlook_ai_auto_enabled;
            if (b.outlook_ai_triage_size !== undefined) {
                // Teto de custo de IA por caixa: valor fora da faixa é recusado,
                // não silenciosamente ajustado - 400 na triagem viraria conta alta.
                const n = Number(b.outlook_ai_triage_size);
                if (!Number.isFinite(n) || n < 5 || n > 60) {
                    return res.status(400).json({ error: 'A triagem aceita de 5 a 60 mensagens por passada.' });
                }
                campos.outlook_ai_triage_size = Math.round(n);
            }

            if (!Object.keys(campos).length) return res.status(400).json({ error: 'Nada para salvar.' });

            const [row] = await db.MicrosoftSettings.findOrCreate({
                where: { id: 1 },
                defaults: { id: 1 },
            });
            await row.update({ ...campos, updated_by: req.user.id });
            settingsService.invalidate();

            if (campos.outlook_ai_auto_enabled !== undefined) {
                console.log(`⚙️  [OutlookAI] execução automática ${campos.outlook_ai_auto_enabled ? 'LIGADA' : 'desligada'} por ${req.user.id}.`);
            }

            return this.configEmpresa(req, res);
        } catch (err) { fail(res, err, 'salvarConfigEmpresa'); }
    };

    // ── Relatório ────────────────────────────────────────────────────────────

    relatorio = async (req, res) => {
        try {
            await this._guardarModulo();
            const mailbox = await this._mailbox(req);
            res.json(await ai.relatorio(req.user.id, mailbox));
        } catch (err) { fail(res, err, 'relatorio'); }
    };
}

export default new MicrosoftOutlookAiController();
