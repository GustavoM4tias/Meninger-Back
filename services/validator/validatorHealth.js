// services/validator/validatorHealth.js
//
// A REGRA de saúde do Validador, separada da coleta de propósito: aqui não há
// banco, rede nem relógio de produção, então ela é testável de verdade
// (tests/validatorHealth.test.mjs). Quem coleta é o validatorHealthService.
//
// ── O que cada estado significa na prática ──────────────────────────────────
//
//   down      A validação NÃO acontece. Ou nenhum modelo do pool responde, ou a
//             API do validador está inalcançável. Contrato que entrar na etapa
//             vai ficar parado. É o estado que justifica acordar alguém.
//   degraded  A validação acontece, mas fora do desenho: o modelo principal
//             caiu e quem está respondendo é um degrau de fallback, ou o CV
//             parou de chamar o webhook, ou tem repasse preso na etapa. Nada
//             disso para a fila sozinho - tudo isso VIRA parada se ninguém
//             olhar.
//   ok        Todo modelo configurado responde, a API responde, o gatilho está
//             chamando e não há repasse preso.
//
// A distinção importa porque o remédio é diferente: `down` é trocar modelo ou
// consertar a URL; `degraded` é conferir o gatilho no painel do CV ou destravar
// um contrato na mão.

export const STATUS = {
    OK: 'ok',
    DEGRADED: 'degraded',
    DOWN: 'down',
    UNKNOWN: 'unknown',
};

/** Ordem de gravidade — usada para decidir quem manda quando há vários sinais. */
const PESO = { ok: 0, unknown: 1, degraded: 2, down: 3 };

const pior = (a, b) => (PESO[b] > PESO[a] ? b : a);

/**
 * Traduz os itens conferidos em um estado só, com motivo legível.
 *
 * `motivoChave` é o que evita repetir o mesmo aviso todo ciclo e, ao mesmo
 * tempo, deixa um problema DIFERENTE avisar na hora: ela muda quando a causa
 * muda (modelo caiu → API caiu), não quando o relógio anda.
 *
 * @param {object} checks
 * @param {Array<{model,ok,tipo?,erro?}>} [checks.modelos]
 * @param {{ok:boolean, erro?:string}}    [checks.api]
 * @param {{ok:boolean, motivo?:string}}  [checks.webhook]
 * @param {{ok:boolean, motivo?:string}}  [checks.fila]
 * @returns {{ status, motivo, motivoChave, detalhes: string[] }}
 */
export function agregar(checks = {}) {
    const detalhes = [];
    let status = STATUS.OK;
    let motivo = 'Validador respondendo normalmente.';
    let motivoChave = 'ok';

    // Saída única: há um caminho que corta o resto da checagem (sem chave, onde
    // conferir gatilho e fila só somaria ruído a um problema de configuração).
    const finalizar = () => ({ status, motivo, motivoChave, detalhes });

    const modelos = Array.isArray(checks.modelos) ? checks.modelos : [];
    const vivos = modelos.filter(m => m?.ok);
    const mortos = modelos.filter(m => m && !m.ok);

    // ── A API do validador ──────────────────────────────────────────────────
    // Vem primeiro porque é a falha mais cara de diagnosticar: sem ela, nem o
    // modelo chega a ser chamado, e o sintoma visível seria só "contrato parado".
    if (checks.api && checks.api.ok === false) {
        status = pior(status, STATUS.DOWN);
        motivo = `API do validador inalcançável: ${checks.api.erro || 'sem resposta'}.`;
        motivoChave = 'api-fora';
        detalhes.push(motivo);
    }

    // ── Os modelos ──────────────────────────────────────────────────────────
    if (modelos.length) {
        if (!vivos.length) {
            status = pior(status, STATUS.DOWN);

            // Falta de CHAVE não é falha de modelo: repetir "gemini-2.5-pro
            // (config), gemini-2.5-flash (config)" manda o admin trocar de
            // modelo quando o conserto é uma variável de ambiente.
            const semChave = mortos.filter(m => m.tipo === 'config');
            if (semChave.length === mortos.length) {
                const msg = `Sem chave do provedor configurada: ${semChave[0]?.erro || 'GEMINI_API_KEYS ausente'}.`;
                detalhes.push(msg);
                if (motivoChave === 'ok') { motivo = msg; motivoChave = 'sem-chave'; }
                return finalizar();
            }

            const porModelo = mortos.map(m => `${m.model} (${m.tipo || 'erro'})`).join(', ');
            const msg = `Nenhum modelo do pool respondeu: ${porModelo}.`;
            detalhes.push(msg);
            // API fora é causa mais raiz que modelo fora: se ela já tomou o
            // motivo, este fica só no detalhe.
            if (motivoChave === 'ok') { motivo = msg; motivoChave = 'sem-modelo'; }
        } else if (mortos.length) {
            // Um modelo morto com outro vivo é o caso do modelo APOSENTADO:
            // ainda valida, mas com um degrau de fallback e sem ninguém saber.
            // É exatamente o que precisa virar aviso antes de a fila sentir.
            status = pior(status, STATUS.DEGRADED);

            const aposentados = mortos.filter(m => m.tipo === 'modelo').map(m => m.model);
            const msg = aposentados.length
                ? `Modelo indisponível no provedor (404): ${aposentados.join(', ')}. Troque o nome na configuração.`
                : `Modelo com falha: ${mortos.map(m => `${m.model} (${m.tipo || 'erro'})`).join(', ')}.`;
            detalhes.push(msg);

            if (motivoChave === 'ok') {
                motivo = msg;
                motivoChave = aposentados.length ? `modelo-404:${aposentados.join('+')}` : 'modelo-falha';
            }
        }
    }

    // ── O gatilho do CV ─────────────────────────────────────────────────────
    if (checks.webhook && checks.webhook.ok === false) {
        status = pior(status, STATUS.DEGRADED);
        const msg = checks.webhook.motivo || 'Gatilho CONTRATOS_IA sem chamadas recentes.';
        detalhes.push(msg);
        if (motivoChave === 'ok') { motivo = msg; motivoChave = 'webhook-silencioso'; }
    }

    // ── A fila no CV ────────────────────────────────────────────────────────
    if (checks.fila && checks.fila.ok === false) {
        status = pior(status, STATUS.DEGRADED);
        const msg = checks.fila.motivo || 'Repasse parado em "Analise Contratos".';
        detalhes.push(msg);
        if (motivoChave === 'ok') { motivo = msg; motivoChave = 'fila-parada'; }
    }

    // Nada conferido = nada sabido. Dizer "ok" aqui seria a pior mentira
    // possível: a tela ficaria verde justamente quando a sonda não rodou.
    if (!modelos.length && !checks.api && !checks.webhook && !checks.fila) {
        return {
            status: STATUS.UNKNOWN,
            motivo: 'Nada foi conferido nesta rodada.',
            motivoChave: 'sem-checagem',
            detalhes: [],
        };
    }

    if (status === STATUS.OK) {
        detalhes.push(`${vivos.length} de ${modelos.length} modelo(s) respondendo.`);
    }

    return { status, motivo, motivoChave, detalhes };
}

/**
 * O gatilho está vivo? Silêncio longo demais é suspeita, não certeza: pode ser
 * um feriado sem contrato nenhum. Por isso vira `degraded` (olhe isto), nunca
 * `down` (a validação parou).
 */
export function avaliarWebhook({ active, lastCallAt, silenceHours, agora = new Date() }) {
    if (active === false) {
        return { ok: false, motivo: 'Gatilho CONTRATOS_IA desativado na configuração.', lastCallAt: lastCallAt || null };
    }
    if (!lastCallAt) {
        return { ok: false, motivo: 'O CV nunca chamou o gatilho CONTRATOS_IA. Confira o endereço no painel do CV.', lastCallAt: null };
    }

    const horas = (agora.getTime() - new Date(lastCallAt).getTime()) / 3600000;
    if (horas > silenceHours) {
        return {
            ok: false,
            horas: Math.floor(horas),
            lastCallAt,
            motivo: `O CV não chama o gatilho CONTRATOS_IA há ${Math.floor(horas)}h (limite: ${silenceHours}h).`,
        };
    }
    return { ok: true, horas: Math.floor(horas), lastCallAt };
}

/**
 * A fila parou? Um repasse na etapa é normal (acabou de entrar); um repasse na
 * etapa há mais que o prazo é a definição operacional de produção parada.
 */
export function avaliarFila({ total = 0, maisAntigoEm = null, stuckHours, agora = new Date() }) {
    if (!total) return { ok: true, total: 0 };

    if (!maisAntigoEm) return { ok: true, total };

    const horas = (agora.getTime() - new Date(maisAntigoEm).getTime()) / 3600000;
    if (horas > stuckHours) {
        return {
            ok: false,
            total,
            horas: Math.floor(horas),
            motivo: `${total} repasse(s) em "Analise Contratos"; o mais antigo há ${Math.floor(horas)}h (limite: ${stuckHours}h).`,
        };
    }
    return { ok: true, total, horas: Math.floor(horas) };
}

export default { STATUS, agregar, avaliarWebhook, avaliarFila };
