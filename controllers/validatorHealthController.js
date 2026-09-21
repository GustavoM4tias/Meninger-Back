// controllers/validatorHealthController.js
//
// A aba Saúde da tela do Validador. Duas camadas de propósito:
//
//   FAROL (`estado`)   cor, desde quando e uma frase. Vai para quem tem a tela,
//                      porque saber que o validador está fora do ar ANTES de
//                      subir o PDF poupa a pessoa de decifrar um erro genérico.
//   DETALHE (o resto)  quais modelos responderam, a mensagem crua do provedor,
//                      o endereço do gatilho e a configuração. Admin: é aqui que
//                      mora o segredo do webhook e o que mexe na conta do
//                      provedor.

import { runHealthCheck, getHealthSnapshot } from '../services/validator/validatorHealthService.js';
import { getSettings, updateSettings } from '../services/validator/validatorSettings.js';
import validatorHealthScheduler from '../scheduler/validatorHealthScheduler.js';

/** Frase curta e sem detalhe técnico, para quem só precisa saber se dá para usar. */
function frase(status, settings) {
    if (status === 'ok') return 'Validador respondendo normalmente.';
    if (status === 'down') return 'O validador está fora do ar. Contrato enviado agora pode não ser analisado.';
    if (status === 'degraded') return 'O validador está funcionando parcialmente. Confira o resultado antes de agir.';
    return settings?.last_probe_at
        ? 'Estado desconhecido na última checagem.'
        : 'A sonda ainda não rodou.';
}

/** GET /api/contracts/health — o farol. Alçada da tela. */
export async function getEstado(req, res) {
    try {
        const s = await getSettings();
        res.json({
            status: s.status,
            status_since: s.status_since,
            last_probe_at: s.last_probe_at,
            last_ok_at: s.last_ok_at,
            probe_enabled: s.probe_enabled,
            mensagem: frase(s.status, s),
        });
    } catch (err) {
        console.error('[validatorHealth] estado:', err?.message);
        res.status(500).json({ error: 'Erro ao ler o estado do validador.' });
    }
}

/** GET /api/contracts/health/full — detalhe + configuração + rastro. Admin. */
export async function getDetalhe(req, res) {
    try {
        const { default: db } = await import('../models/sequelize/index.js');
        const { obterConfig, montarEndereco } = await import('../services/contractWebhookService.js');
        const base = `${req.protocol}://${req.get('host')}`;

        const [snapshot, settings, execucoes, parados, webhookCfg, endereco] = await Promise.all([
            getHealthSnapshot({ limit: Number(req.query.limit) || 20 }),
            getSettings(),
            db.ContractValidatorRun.findAll({ order: [['started_at', 'DESC']], limit: 10, raw: true }).catch(() => []),
            db.ContractValidatorStuck.findAll({ order: [['status_since', 'ASC']], raw: true }).catch(() => []),
            obterConfig().catch(() => null),
            montarEndereco(base).catch(() => null),
        ]);

        res.json({
            saude: snapshot,
            // Só o que a tela edita: o estado da sonda já vai em `saude`, e
            // devolver duas cópias convidaria a tela a gravar estado sem querer.
            configuracao: {
                models: settings.models,
                probe_enabled: settings.probe_enabled,
                probe_cron: settings.probe_cron,
                probe_timeout_ms: settings.probe_timeout_ms,
                queue_check_enabled: settings.queue_check_enabled,
                queue_check_cron: settings.queue_check_cron,
                webhook_silence_hours: settings.webhook_silence_hours,
                stuck_alert_hours: settings.stuck_alert_hours,
                failure_streak_to_alert: settings.failure_streak_to_alert,
                notify_user_ids: settings.notify_user_ids,
                alert_on_down: settings.alert_on_down,
                alert_on_recovery: settings.alert_on_recovery,
            },
            webhook: webhookCfg ? {
                endereco,
                ativo: webhookCfg.active,
                ultima_chamada: webhookCfg.last_call_at,
                ultimo_idrepasse: webhookCfg.last_idrepasse,
                chamadas_total: webhookCfg.calls_total,
            } : null,
            execucoes,
            parados,
        });
    } catch (err) {
        console.error('[validatorHealth] detalhe:', err?.message);
        res.status(500).json({ error: 'Erro ao montar o diagnóstico do validador.' });
    }
}

/**
 * POST /api/contracts/health/check — roda a sonda agora. Admin.
 *
 * `incluirFila` é opcional porque é o único item que custa chamada à API do CV;
 * o botão da tela manda `true` (quem clicou quer o quadro completo).
 */
export async function rodarSonda(req, res) {
    try {
        const incluirFila = req.body?.incluirFila !== false;
        const r = await runHealthCheck({ origin: 'manual', incluirFila });
        if (r?.skipped) return res.status(409).json({ error: 'Uma checagem já está em andamento.' });
        res.json(r);
    } catch (err) {
        console.error('[validatorHealth] sonda manual:', err?.message);
        res.status(500).json({ error: 'Erro ao rodar a checagem.' });
    }
}

/**
 * PUT /api/contracts/health/settings — grava a configuração. Admin.
 *
 * Recarrega o scheduler na sequência: sem isso, mudar o ritmo da sonda na tela
 * só valeria no próximo deploy - que é exatamente o que tirar a configuração
 * da env veio resolver.
 */
export async function salvarConfig(req, res) {
    try {
        const settings = await updateSettings(req.body || {}, req.user?.id || null);
        validatorHealthScheduler.reload()
            .catch(err => console.warn('[validatorHealth] scheduler não recarregou:', err?.message));
        res.json({ ok: true, configuracao: settings });
    } catch (err) {
        if (err?.expose === 400) return res.status(400).json({ error: err.message });
        console.error('[validatorHealth] salvar config:', err?.message);
        res.status(500).json({ error: 'Erro ao salvar a configuração.' });
    }
}

export default { getEstado, getDetalhe, rodarSonda, salvarConfig };
