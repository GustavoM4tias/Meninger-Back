// services/processos/autonomia.js
//
// A ESCADA DE AUTONOMIA. Módulo PURO: sem banco, sem rede, sem IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DECISÃO DE PRODUTO QUE ESTE ARQUIVO IMPLEMENTA
//
// "Começa observando; quando eu tiver segurança ela age; uns assuntos mais
// livres e outros extremamente restritos."
//
// Isso não é um interruptor do sistema: é um ATRIBUTO DE CADA PROCESSO. O
// acompanhamento de lead parado pode agir sozinho muito antes de qualquer
// coisa que toque em contrato assinado - e alguns processos nunca devem sair
// do primeiro degrau, por decisão, não por falta de confiança.
//
// ─────────────────────────────────────────────────────────────────────────────
// SUBIR É ATO DELIBERADO. DESCER É AUTOMÁTICO.
//
// A assimetria é o ponto. Um sistema que se promove sozinho ao ver uma
// sequência de acertos é um sistema que vai estar no degrau errado
// exatamente no dia em que o padrão mudar - e ninguém vai ter decidido isso.
// Então promoção aqui só SUGERE; quem sobe o degrau é uma pessoa.
//
// O contrário não pode esperar reunião: ação revertida, contestada ou que deu
// errado REBAIXA na hora e diz por quê. Confiança que não sabe recuar não é
// confiança, é inércia.
//
// ─────────────────────────────────────────────────────────────────────────────
// O TETO
//
// `autonomia_teto` é o limite que aquele processo nunca ultrapassa, nem com
// histórico impecável. É onde "extremamente restrito" vira dado: teto em
// 'observar' significa que ele existe para aprender e informar, e ponto.
// Mexer no teto é ato de admin na tela, separado de mexer no degrau atual -
// de propósito, para que subir o limite máximo nunca seja um efeito colateral
// de aprovar uma sugestão.

/** Os degraus, do mais contido ao mais solto. A ORDEM É A SEMÂNTICA. */
export const NIVEIS = ['observar', 'propor', 'agir', 'decidir'];

export const ROTULOS = {
    observar: 'Observar',
    propor: 'Propor',
    agir: 'Agir',
    decidir: 'Decidir',
};

export const EXPLICACOES = {
    observar: 'Registra o que acontece e monta o mapa. Não sugere nada e não aparece para ninguém.',
    propor: 'Sugere a ação na caixa de entrada, com a evidência. Nada acontece sem alguém clicar.',
    agir: 'Executa sozinha as ações declaradas neste processo, dentro do limite, e registra cada uma.',
    decidir: 'Escolhe entre os caminhos previstos no processo, em vez de executar um caminho único.',
};

/**
 * O que cada degrau LIBERA. Acumulativo de propósito: quem age também propõe,
 * e quem propõe também observa. Um degrau que não registrasse o que viu seria
 * um degrau que não consegue explicar o que fez.
 */
const PERMITE = {
    observar: ['registrar'],
    propor: ['registrar', 'propor'],
    agir: ['registrar', 'propor', 'executar'],
    decidir: ['registrar', 'propor', 'executar', 'escolher'],
};

export const ordem = (nivel) => NIVEIS.indexOf(String(nivel || ''));
export const nivelValido = (nivel) => ordem(nivel) >= 0;

/** Compara degraus. `null` quando algum dos dois não existe. */
export function maisAlto(a, b) {
    const ia = ordem(a), ib = ordem(b);
    if (ia < 0 || ib < 0) return null;
    return ia >= ib ? a : b;
}

/**
 * O degrau QUE VALE AGORA para um processo.
 *
 * Nunca leia `processo.autonomia` direto: o teto e o desligamento moram fora
 * desse campo, e ler o campo cru é como o sistema acabaria executando um
 * processo desligado porque alguém esqueceu de conferir a outra coluna.
 *
 * Processo desligado cai para 'observar', e não para nada: continuar
 * registrando é o que permite religá-lo depois sabendo o que perdeu.
 */
export function efetivo(processo = {}) {
    const atual = nivelValido(processo.autonomia) ? processo.autonomia : 'observar';
    const teto = nivelValido(processo.autonomia_teto) ? processo.autonomia_teto : 'propor';
    if (processo.enabled === false) return 'observar';
    return ordem(atual) > ordem(teto) ? teto : atual;
}

/** Este processo pode fazer isto agora? ('registrar'|'propor'|'executar'|'escolher') */
export function permite(processo, oQue) {
    return (PERMITE[efetivo(processo)] || []).includes(oQue);
}

/**
 * Validação de uma troca de degrau pedida na tela.
 *
 * Devolve `{ ok, motivo }` em vez de lançar: isto alimenta uma mensagem na
 * tela, e "Erro 400" não diz a quem está mexendo que o problema é o teto.
 */
export function podeSubir(atual, alvo, teto) {
    if (!nivelValido(alvo)) return { ok: false, motivo: 'Degrau de autonomia desconhecido.' };
    if (!nivelValido(teto)) return { ok: false, motivo: 'Este processo está sem teto de autonomia definido.' };

    if (ordem(alvo) > ordem(teto)) {
        return {
            ok: false,
            motivo: `O teto deste processo é "${ROTULOS[teto]}". Para ir além, suba o teto primeiro - é uma decisão separada, de propósito.`,
        };
    }
    // Pular degraus é como se chega em 'decidir' sem nunca ter visto a coisa
    // agir. Descer, sim, pode ser de uma vez: recuar depressa nunca é o risco.
    if (ordem(alvo) - ordem(atual) > 1) {
        return {
            ok: false,
            motivo: `Suba um degrau por vez. De "${ROTULOS[atual]}" o próximo é "${ROTULOS[NIVEIS[ordem(atual) + 1]]}".`,
        };
    }
    return { ok: true, motivo: '' };
}

/**
 * Vale SUGERIR que este processo suba um degrau?
 *
 * Só sugere. A promoção é um clique de gente, e esta função existe para que
 * esse clique seja informado em vez de anual: sem ela, ninguém lembra de
 * promover e o processo fica em 'propor' para sempre, pedindo aprovação de
 * coisa que acerta há meses.
 *
 * @param {{aprovadas:number, recusadas:number, revertidas:number, dias:number}} hist
 * @param {{min_aprovadas:number, min_dias:number, max_recusadas:number}} cfg
 */
export function avaliarPromocao(processo = {}, hist = {}, cfg = {}) {
    const atual = efetivo(processo);
    const teto = nivelValido(processo.autonomia_teto) ? processo.autonomia_teto : 'propor';
    const proximo = NIVEIS[ordem(atual) + 1] || null;

    if (!proximo) return { sugerir: false, proximo: null, motivo: 'Já está no degrau mais alto.' };
    if (ordem(proximo) > ordem(teto)) {
        return { sugerir: false, proximo: null, motivo: `Teto em "${ROTULOS[teto]}".` };
    }

    const minAprovadas = Number(cfg.min_aprovadas) > 0 ? Number(cfg.min_aprovadas) : 10;
    const minDias = Number(cfg.min_dias) > 0 ? Number(cfg.min_dias) : 14;
    const maxRecusadas = Number.isFinite(Number(cfg.max_recusadas)) ? Number(cfg.max_recusadas) : 1;

    const aprovadas = Number(hist.aprovadas) || 0;
    const recusadas = Number(hist.recusadas) || 0;
    const revertidas = Number(hist.revertidas) || 0;
    const dias = Number(hist.dias) || 0;

    // Reversão zera a conversa. Uma única ação desfeita significa que o
    // processo ainda erra de um jeito que a operação sente - e é exatamente
    // nessa hora que promover parece razoável nos números agregados.
    if (revertidas > 0) {
        return { sugerir: false, proximo, motivo: `${revertidas} ação(ões) revertida(s) no período. Sem promoção enquanto houver reversão.` };
    }
    if (recusadas > maxRecusadas) {
        return { sugerir: false, proximo, motivo: `${recusadas} proposta(s) recusada(s) (limite ${maxRecusadas}).` };
    }
    if (aprovadas < minAprovadas) {
        return { sugerir: false, proximo, motivo: `${aprovadas} de ${minAprovadas} aprovações necessárias.` };
    }
    // Tempo é um critério à parte do volume: cinquenta acertos numa terça não
    // provam que o processo aguenta um fechamento de mês.
    if (dias < minDias) {
        return { sugerir: false, proximo, motivo: `${dias} de ${minDias} dias de histórico.` };
    }

    return {
        sugerir: true,
        proximo,
        motivo: `${aprovadas} aprovações em ${dias} dias, sem reversão. Pode subir para "${ROTULOS[proximo]}".`,
    };
}

/**
 * Um evento ruim derruba o degrau AGORA.
 *
 * Não passa por aprovação e não espera lote. O custo de rebaixar à toa é uma
 * semana pedindo confirmação de novo; o custo de não rebaixar é a próxima
 * ação errada sair sozinha, igual à que acabou de ser desfeita.
 *
 * @param {'revertida'|'contestada'|'erro'|'fora_do_escopo'} tipo
 */
export function avaliarRebaixamento(processo = {}, tipo = 'revertida') {
    const atual = efetivo(processo);

    const MOTIVOS = {
        revertida: 'uma ação automática foi desfeita',
        contestada: 'uma ação automática foi contestada por quem a recebeu',
        erro: 'uma ação automática falhou na execução',
        fora_do_escopo: 'o processo agiu sobre algo fora do escopo declarado',
    };
    const porque = MOTIVOS[tipo] || MOTIVOS.revertida;

    // Agir fora do escopo é categoria à parte: não é o processo errando a
    // dose, é o processo tocando em algo que não era dele. Volta para o
    // primeiro degrau, não para o anterior.
    if (tipo === 'fora_do_escopo') {
        if (atual === 'observar') return { rebaixar: false, para: atual, motivo: '' };
        return {
            rebaixar: true,
            para: 'observar',
            motivo: `Rebaixado para "Observar": ${porque}. Este não é um erro de dose, e por isso não volta só um degrau.`,
        };
    }

    if (atual === 'observar') return { rebaixar: false, para: atual, motivo: '' };

    // Em 'propor' o estrago já depende de alguém ter clicado, então o degrau
    // não é o culpado: quem errou foi a proposta, e ela tem a própria régua.
    if (atual === 'propor') {
        return { rebaixar: false, para: atual, motivo: `Sem rebaixamento: em "Propor" nada sai sem uma pessoa aprovar.` };
    }

    const para = NIVEIS[ordem(atual) - 1];
    return {
        rebaixar: true,
        para,
        motivo: `Rebaixado de "${ROTULOS[atual]}" para "${ROTULOS[para]}": ${porque}.`,
    };
}

export default {
    NIVEIS, ROTULOS, EXPLICACOES,
    ordem, nivelValido, maisAlto, efetivo, permite,
    podeSubir, avaliarPromocao, avaliarRebaixamento,
};
