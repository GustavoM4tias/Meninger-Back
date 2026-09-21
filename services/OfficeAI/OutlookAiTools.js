// services/OfficeAI/OutlookAiTools.js
//
// A Eme operando a caixa de e-mail: a triagem, a fila de aprovação, as regras e
// a organização da caixa.
//
// POR QUE UM ARQUIVO SEPARADO DO MicrosoftTools
//
// Aquele fala com o GRAPH (agenda, SharePoint, Teams, buscar e-mail). Este fala
// com a IA DA CAIXA - triagem, fila, regras, permissões - que é um módulo do
// Office com banco próprio. Misturar os dois faria um arquivo em que "ler a
// agenda" e "mudar o nível de permissão da IA" vivem lado a lado, e a segunda
// coisa é muito mais perigosa que a primeira.
//
// AS REGRAS DE SEGURANÇA, TODAS ELAS
//
// 1. A CAIXA É SEMPRE A DE `user`. O módulo usa token de APLICAÇÃO: o Graph
//    aceitaria /users/{qualquer-um}/messages. Nenhum arg do Gemini escolhe
//    caixa, e nenhum deve passar a escolher.
//
// 2. TODA ESCRITA PEDE `confirmado: true`. Sem ele a tool devolve a PRÉVIA e não
//    toca em nada. Não é burocracia: aprovar é enviar e-mail, arquivar tira da
//    caixa, mudar o nível de permissão muda o que ela faz sozinha depois.
//
// 3. A EME NÃO SOBE O NÍVEL DE PERMISSÃO. Ela lê a configuração e sabe explicar,
//    mas quem autoriza a IA a agir mais é a pessoa, na tela, olhando a
//    consequência escrita. Uma IA que se autoriza a agir mais não é assistente.
//
// 4. `requiredPermissions` amarra cada tool à tela: quem não tem `/microsoft/
//    outlook` na alçada não tem nenhuma delas. As de configuração exigem a
//    capacidade `automate` - a mesma da aba Automações.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import ai from '../microsoft/MicrosoftOutlookAiService.js';
import outlookService from '../microsoft/MicrosoftOutlookService.js';
import { userCan } from '../permissions/capabilityService.js';
import { emailBlock } from './blocks.js';

/**
 * Registro completo do usuário: o req.user do middleware não traz o microsoft_id.
 *
 * `role` vai junto e NÃO é opcional: userCan() decide o bypass de admin por ele,
 * e sem o campo todo admin era tratado como usuário comum - as tools de
 * configuração recusavam quem podia tudo.
 */
async function fullUser(user) {
    const id = user?.id ?? user;
    return db.User.findByPk(id, {
        attributes: ['id', 'username', 'email', 'microsoft_id', 'role', 'permission_profile_id'],
    });
}

const semConta = {
    erro: 'Sua conta Microsoft não está vinculada ao Office. Conecte em Minha Conta para eu poder ver a sua caixa.',
};

/** A caixa desta pessoa, ou o erro pronto. Único caminho permitido. */
async function comCaixa(user) {
    const u = await fullUser(user);
    if (!u?.microsoft_id) return { erro: semConta };
    return { u, caixa: u.microsoft_id };
}

const COMPORTAMENTO = {
    responder: 'ela responde sozinha',
    aprovar: 'ela escreve e espera o seu OK',
    notificar: 'ela só te avisa',
    silenciar: 'ela fica em silêncio',
};

const CLASSE = {
    critica: 'prazo legal ou risco',
    alta: 'decisão que trava alguém',
    media: 'pedido comum',
    ruido: 'ruído',
};

function quando(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoje = new Date();
    if (d.toDateString() === hoje.toDateString()) {
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ═══════════════════════════════════════════════════════════════════════════
// LEITURA
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
    name: 'outlook_triagem',
    description: 'O que a IA da caixa entendeu do e-mail que chegou: o que precisa de decisão do usuário, o que ela já resolveu, os prazos que achou e quanto era ruído. Use para "o que preciso responder hoje?", "tem algo urgente no e-mail?", "resume minha caixa", "o que a IA fez na minha caixa?". Responde do que ela já leu - é instantâneo e não custa nada.',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        const p = await ai.dashboard(u.id);

        return {
            result: {
                resumo: `${p.metricas.chegaram} e-mail(s) nas últimas 24h, `
                    + `${p.metricas.ruido} de ruído. ${p.metricas.precisamDeVoce} esperam decisão sua.`
                    + (p.metricas.rascunhos ? ` ${p.metricas.rascunhos} resposta(s) escrita(s) esperando o OK.` : ''),
                numeros: p.metricas,
                lidoPor: p.fonte === 'ia' ? 'modelo de IA' : 'regra simples (modelo não configurado)',
                precisamDeVoce: (p.prioritarios || []).map(l => ({
                    id: l.messageId,
                    assunto: l.assunto,
                    de: l.de,
                    quando: quando(l.quando),
                    tipo: CLASSE[l.classe] || l.classe,
                    porque: l.porque,
                    acaoSugerida: l.acao,
                    prazo: l.prazo || null,
                    oQueElaFaria: COMPORTAMENTO[l.comportamento],
                    rebaixadaPor: l.motivoRebaixe || null,
                })),
                prazos: (p.extraidos || []).map(e => ({ id: e.messageId, o_que: e.titulo, ate: e.prazo || e.prazoEm })),
                jaFez: (p.tratados || []).map(a => ({ o_que: a.texto, assunto: a.titulo, estado: a.estado })),
            },
        };
    },
});

registerTool({
    name: 'outlook_fila_aprovacao',
    description: 'As respostas que a IA JÁ ESCREVEU e estão esperando o OK do usuário para sair. Use para "o que está esperando minha aprovação?", "a IA escreveu alguma resposta?", "tem e-mail para eu aprovar?". Mostre o texto inteiro quando ele perguntar - é o que ele precisa ler antes de aprovar.',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        const fila = await ai.fila(u.id);
        if (!fila.length) return { result: { vazia: true, resumo: 'Nada esperando o seu OK.' } };

        return {
            result: {
                total: fila.length,
                itens: fila.map(f => ({
                    id: f.id,
                    tipo: f.tipo === 'cobranca' ? 'cobrança de prazo' : 'resposta',
                    assunto: f.assunto,
                    para: f.destinatarios,
                    texto: f.corpo,
                    porqueEstaEsperando: f.motivo,
                })),
                resumo: `${fila.length} texto(s) escrito(s) pela IA esperando o seu OK. Nada saiu ainda.`,
            },
        };
    },
});

registerTool({
    name: 'outlook_configuracao_ia',
    description: 'Como a IA da caixa está configurada hoje: nível de permissão, o que ela faz por importância, assuntos que ela nunca responde sozinha, teto de valor e janela de envio. Use para "o que a IA pode fazer sozinha?", "por que ela não respondeu aquele e-mail?", "ela está ligada?". Serve para EXPLICAR o comportamento dela.',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        const cfg = await ai.getSettings(u.id);
        const regras = await ai.getRules(u.id);

        const NIVEL = {
            1: 'Só observa - classifica e resume, nada sai sem ele',
            2: 'Escreve e espera - redige e deixa na fila de aprovação',
            3: 'Responde o rotineiro - médio e ruído ela resolve; crítico e alto pedem OK',
            4: 'Age por ele - responde, arquiva e cobra, com registro depois',
        };

        return {
            result: {
                ligada: cfg.ativo,
                automacaoLigadaNaEmpresa: cfg.automacaoLigadaNaEmpresa === true,
                nivel: `${cfg.nivel} - ${NIVEL[cfg.nivel] || ''}`,
                porImportancia: Object.fromEntries(
                    Object.entries(cfg.matriz || {}).map(([k, v]) => [CLASSE[k] || k, COMPORTAMENTO[v] || v]),
                ),
                nuncaSozinhaSobre: (cfg.limites || []).filter(l => l.on).map(l => l.label),
                tetoDeValor: cfg.teto_mil ? `R$ ${cfg.teto_mil} mil` : 'sempre pede OK',
                janelaDeEnvio: cfg.janela,
                leDe: cfg.escopo === 'inbox' ? 'só a Caixa de Entrada' : 'a caixa inteira, menos enviados e lixeira',
                temAssinatura: !!cfg.assinatura,
                regras: regras.map(r => ({
                    titulo: r.titulo, ligada: r.ativo,
                    modo: r.modo === 'automatico' ? 'age sozinha' : 'pede OK',
                    vezesHoje: r.execucoesHoje,
                })),
                // A explicação que o modelo precisa para não prometer o que a
                // configuração não permite.
                observacao: cfg.automacaoLigadaNaEmpresa
                    ? null
                    : 'A execução automática está DESLIGADA para a empresa inteira: independente do nível, ela só lê e escreve - nada sai nem muda de pasta sozinho.',
            },
        };
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// ESCRITA — tudo aqui pede confirmação
// ═══════════════════════════════════════════════════════════════════════════

/**
 * E-mail NOVO: a Eme monta, a pessoa revisa e envia do cartão.
 *
 * Esta tool não toca no Graph. Ela devolve um bloco `email` que o chat mostra
 * como cartão editável (Para, assunto, corpo, "Editar no Outlook", Enviar). O
 * envio é um clique da pessoa, pela rota /outlook/send - com a alçada `send`
 * conferida lá e a confirmação de "vai para fora da Menin" feita no cartão.
 * Por isso não existe `confirmado` aqui: não há o que confirmar, a tool não
 * age. E por isso o modelo não pode dizer "enviei": o resumo abaixo repete.
 */
registerTool({
    name: 'outlook_escrever_email',
    description: 'MONTA um e-mail NOVO para o usuário revisar e enviar, no cartão do chat. Use para "manda um e-mail para o João dizendo que...", "escreve um e-mail para a prefeitura pedindo...", "prepara um e-mail para o time sobre...". Passe os destinatários como E-MAIL (se a pessoa citou só o nome, ache o e-mail com query_people antes), o assunto e o corpo completo em texto simples, no tom do usuário. NÃO envia: quem envia é o usuário, clicando no cartão. Nunca diga que enviou.',
    parameters: {
        type: 'object',
        properties: {
            para:    { type: 'array', items: { type: 'string' }, description: 'E-mails dos destinatários principais.' },
            cc:      { type: 'array', items: { type: 'string' }, description: 'E-mails em cópia, se o usuário pediu.' },
            assunto: { type: 'string', description: 'Assunto do e-mail, curto e objetivo.' },
            corpo:   { type: 'string', description: 'Corpo completo em texto simples (quebras de linha com \\n). Saudação, mensagem e despedida no nome do usuário.' },
        },
        required: ['para', 'assunto', 'corpo'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'send')) {
            return { result: { erro: 'Você não tem a ação de envio na tela de e-mail, então não posso montar e-mails para você enviar.' } };
        }

        const limpa = (arr) => (Array.isArray(arr) ? arr : [arr])
            .map(e => String(e || '').trim().toLowerCase())
            .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        const para = [...new Set(limpa(args?.para))];
        const cc = [...new Set(limpa(args?.cc))].filter(e => !para.includes(e));
        const assunto = String(args?.assunto || '').trim();
        const corpo = String(args?.corpo || '').trim();

        if (!para.length) return { result: { erro: 'Preciso do E-MAIL de pelo menos um destinatário. Se só tem o nome, procure com query_people.' } };
        if (!corpo) return { result: { erro: 'Preciso do texto do e-mail.' } };

        const externos = para.concat(cc).filter(e => !/@menin\.com\.br$/i.test(e));
        return {
            result: {
                blocks: [emailBlock({ to: para, cc, subject: assunto, body: corpo })],
                para, cc, assunto,
                externos: externos.length ? externos : undefined,
                message: 'O e-mail JÁ está no cartão do chat, editável, aguardando o usuário clicar em Enviar. '
                    + 'NADA foi enviado. Responda em 1 frase dizendo que ele pode revisar e enviar pelo cartão'
                    + (externos.length ? `, e avise que ${externos.join(', ')} é endereço de fora da Menin` : '')
                    + '. Nunca diga que enviou.',
            },
        };
    },
});

/**
 * Resposta/encaminhamento pelo MESMO cartão. Também não envia: o cartão chama
 * /outlook/messages/:id/:kind/send, que responde com a citação montada pelo
 * Outlook (mesma conversa). A Eme escreve o texto; a tool só lê a mensagem
 * original para preencher para quem vai e o assunto, e devolve o bloco.
 */
const TIPO_RESPOSTA = { responder: 'reply', responder_todos: 'replyAll', encaminhar: 'forward' };

registerTool({
    name: 'outlook_responder_email',
    description: 'MONTA a RESPOSTA ou o ENCAMINHAMENTO de um e-mail existente, no cartão do chat, para o usuário revisar e enviar. Use para "responde o e-mail da Julia dizendo que...", "responde a todos que...", "encaminha esse e-mail para o Marcus". O `id` da mensagem vem de outlook_triagem, search_email ou inbox_summary. Escreva o `corpo` completo em texto simples, no tom do usuário: a conversa anterior vai junto automaticamente, não a repita. Para encaminhar, `para` é obrigatório. NÃO envia: quem envia é o usuário, clicando no cartão. Nunca diga que enviou.',
    parameters: {
        type: 'object',
        properties: {
            id:    { type: 'string', description: 'Id da mensagem original.' },
            tipo:  { type: 'string', enum: ['responder', 'responder_todos', 'encaminhar'], description: 'responder (só ao remetente), responder_todos ou encaminhar.' },
            corpo: { type: 'string', description: 'O que o usuário quer dizer, pronto para enviar, em texto simples (quebras com \\n).' },
            para:  { type: 'array', items: { type: 'string' }, description: 'E-mails de destino. Obrigatório ao encaminhar; em resposta, só se o usuário quiser trocar o destinatário.' },
            cc:    { type: 'array', items: { type: 'string' }, description: 'E-mails em cópia, se pedido.' },
        },
        required: ['id', 'tipo', 'corpo'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u, caixa } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'send')) {
            return { result: { erro: 'Você não tem a ação de envio na tela de e-mail, então não posso montar respostas para você enviar.' } };
        }

        const kind = TIPO_RESPOSTA[args?.tipo] || 'reply';
        const limpa = (arr) => (Array.isArray(arr) ? arr : [arr])
            .map(e => String(e || '').trim().toLowerCase())
            .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        const corpo = String(args?.corpo || '').trim();
        if (!corpo) return { result: { erro: 'Preciso do texto da resposta.' } };

        let msg;
        try {
            msg = await outlookService.getMessage(caixa, String(args?.id || ''));
        } catch (err) {
            return { result: { erro: `Não achei essa mensagem na sua caixa (${err.message}). Busque de novo com search_email ou outlook_triagem.` } };
        }

        // Para quem vai: o que a pessoa pediu ganha; senão, o que o Outlook faria.
        const eu = String(u.email || '').toLowerCase();
        const semEu = (lista) => (lista || []).map(p => String(p?.email || '').toLowerCase()).filter(e => e && e !== eu);
        let para = [...new Set(limpa(args?.para))];
        let cc = [...new Set(limpa(args?.cc))];
        if (!para.length) {
            if (kind === 'forward') return { result: { erro: 'Para encaminhar preciso do E-MAIL de quem vai receber. Se só tem o nome, procure com query_people.' } };
            para = semEu([msg.from]);
            if (kind === 'replyAll') {
                para = [...new Set([...para, ...semEu(msg.to)])];
                if (!cc.length) cc = semEu(msg.cc).filter(e => !para.includes(e));
            }
        }
        cc = cc.filter(e => !para.includes(e));

        const prefixo = kind === 'forward' ? 'Enc:' : 'Re:';
        const assuntoBase = String(msg.subject || '').replace(/^\s*((re|enc|fwd?|fw)\s*:\s*)+/i, '');
        const externos = para.concat(cc).filter(e => !/@menin\.com\.br$/i.test(e));

        return {
            result: {
                blocks: [emailBlock({
                    to: para, cc, subject: `${prefixo} ${assuntoBase}`, body: corpo,
                    replyTo: { messageId: msg.id, kind, subject: msg.subject, from: msg.from?.name || msg.from?.email, preview: (msg.preview || '').slice(0, 160) },
                })],
                tipo: args?.tipo, para, cc, assunto: `${prefixo} ${assuntoBase}`,
                externos: externos.length ? externos : undefined,
                message: `A ${kind === 'forward' ? 'mensagem encaminhada' : 'resposta'} JÁ está no cartão do chat, editável, aguardando o usuário clicar em Enviar. `
                    + 'NADA foi enviado. Responda em 1 frase dizendo que ele pode revisar e enviar pelo cartão'
                    + (externos.length ? `, e avise que ${externos.join(', ')} é endereço de fora da Menin` : '')
                    + '. Nunca diga que enviou.',
            },
        };
    },
});

registerTool({
    name: 'outlook_redigir_resposta',
    description: 'Manda a IA da CAIXA escrever a resposta de um e-mail e deixar na FILA DE APROVAÇÃO da tela de e-mail (painel da direita), sem mostrar no chat. Use só quando o usuário pedir explicitamente para "deixar na fila" ou "preparar para eu aprovar depois". Para responder AGORA, com o texto no chat, use outlook_responder_email. NÃO envia nada. O id vem de outlook_triagem.',
    parameters: {
        type: 'object',
        properties: {
            id:        { type: 'string', description: 'Id da mensagem, vindo de outlook_triagem.' },
            instrucao: { type: 'string', description: 'O que o usuário quer dizer na resposta, se ele disse.' },
        },
        required: ['id'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u, caixa } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'send')) {
            return { result: { erro: 'Você não tem a ação de envio nesta tela, então não posso escrever respostas no seu nome.' } };
        }

        try {
            const item = await ai.redigir(u.id, caixa, String(args?.id || ''), {
                instrucao: String(args?.instrucao || ''),
            });
            return {
                result: {
                    escrito: true,
                    assunto: item.assunto,
                    para: item.destinatarios,
                    texto: item.corpo,
                    resumo: 'Escrevi e deixei na fila de aprovação, no painel da direita da tela de e-mail. '
                        + 'NADA foi enviado - mostre o texto e diga que ele precisa aprovar.',
                },
            };
        } catch (err) {
            return { result: { erro: err.message } };
        }
    },
});

registerTool({
    name: 'outlook_aprovar_envio',
    description: 'APROVA e ENVIA um texto que está na fila de aprovação. Use só quando o usuário disser claramente que pode enviar ("pode mandar", "aprova", "envia essa"). SEMPRE mostre o texto e para quem vai, e confirme antes - e-mail enviado não tem desfazer. O id vem de outlook_fila_aprovacao.',
    parameters: {
        type: 'object',
        properties: {
            id:         { type: 'number', description: 'Id do item da fila, de outlook_fila_aprovacao.' },
            confirmado: { type: 'boolean', description: 'true SÓ depois de o usuário aprovar o texto exato.' },
        },
        required: ['id'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u, caixa } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'send')) {
            return { result: { erro: 'Você não tem a ação de envio nesta tela.' } };
        }

        const fila = await ai.fila(u.id);
        const item = fila.find(f => f.id === Number(args?.id));
        if (!item) return { result: { erro: 'Este item não está mais na fila. Talvez já tenha sido enviado ou descartado.' } };

        if (args?.confirmado !== true) {
            return {
                result: {
                    previa: true,
                    para: item.destinatarios,
                    assunto: item.assunto,
                    texto: item.corpo,
                    resumo: `Confirme antes de eu enviar para ${item.destinatarios.join(', ')}: `
                        + `"${item.assunto}". Sai no seu nome e não tem desfazer.`,
                },
            };
        }

        try {
            await ai.aprovar(u.id, caixa, item.id);
            return { result: { enviado: true, para: item.destinatarios, resumo: 'Enviado.' } };
        } catch (err) {
            return { result: { erro: err.message } };
        }
    },
});

registerTool({
    name: 'outlook_tirar_da_lista',
    description: 'Tira um e-mail da lista "precisa de você", DIZENDO por quê. Use quando o usuário disser "já respondi isso", "quem cuida disso é o financeiro", "não precisa responder", "deixa para depois". Não toca na caixa de e-mail: é arrumação da lista, e o motivo ensina a IA a não insistir em coisa parecida.',
    parameters: {
        type: 'object',
        properties: {
            id:     { type: 'string', description: 'Id da mensagem, de outlook_triagem.' },
            motivo: {
                type: 'string',
                description: 'ja_respondi | outra_pessoa | nao_precisa | resolvido_fora | adiado.',
            },
            nota:   { type: 'string', description: 'Detalhe do usuário, se ele deu (ex.: "a Julia assumiu").' },
        },
        required: ['id', 'motivo'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        try {
            const r = await ai.resolver(u.id, String(args?.id || ''), {
                motivo: String(args?.motivo || 'nao_precisa'),
                nota: String(args?.nota || ''),
            });
            return {
                result: {
                    ok: true, motivo: r.rotulo,
                    resumo: `Tirei da lista: ${r.rotulo}. O e-mail continua na caixa, intocado.`,
                },
            };
        } catch (err) {
            return { result: { erro: err.message } };
        }
    },
});

registerTool({
    name: 'outlook_organizar',
    description: 'Organiza uma mensagem na caixa: marcar lida/não lida, sinalizar, mudar importância, mover para pasta ou arquivar. Use para "arquiva esse e-mail", "marca como importante", "move para a pasta Contratos", "sinaliza para eu ver depois". SEMPRE confirme antes de mover ou arquivar - a mensagem sai de onde está.',
    parameters: {
        type: 'object',
        properties: {
            id:         { type: 'string', description: 'Id da mensagem.' },
            acao:       { type: 'string', description: 'ler | nao_ler | sinalizar | tirar_sinal | importancia | mover | arquivar.' },
            valor:      { type: 'string', description: 'Para importancia: alta|normal|baixa. Para mover: o NOME da pasta.' },
            confirmado: { type: 'boolean', description: 'true para mover/arquivar, depois de o usuário confirmar.' },
        },
        required: ['id', 'acao'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u, caixa } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'organize')) {
            return { result: { erro: 'Você não tem a ação de organizar nesta tela.' } };
        }

        const id = String(args?.id || '');
        const acao = String(args?.acao || '');

        try {
            switch (acao) {
                case 'ler':
                    await outlookService.setRead(caixa, id, true);
                    return { result: { ok: true, resumo: 'Marcada como lida.' } };
                case 'nao_ler':
                    await outlookService.setRead(caixa, id, false);
                    return { result: { ok: true, resumo: 'Marcada como não lida.' } };
                case 'sinalizar':
                    await outlookService.setFlag(caixa, id, true);
                    return { result: { ok: true, resumo: 'Sinalizada para acompanhamento.' } };
                case 'tirar_sinal':
                    await outlookService.setFlag(caixa, id, false);
                    return { result: { ok: true, resumo: 'Sinalizador retirado.' } };

                case 'importancia': {
                    const mapa = { alta: 'high', normal: 'normal', baixa: 'low' };
                    const v = mapa[String(args?.valor || '').toLowerCase()];
                    if (!v) return { result: { erro: 'Diga se a importância é alta, normal ou baixa.' } };
                    await outlookService.setImportance(caixa, id, v);
                    return { result: { ok: true, resumo: `Importância ${args.valor}.` } };
                }

                case 'mover':
                case 'arquivar': {
                    // Mover tira a mensagem de onde ela está: confirma primeiro.
                    const pastas = await outlookService.listFolders(caixa);
                    const alvo = acao === 'arquivar'
                        ? pastas.find(f => f.wellKnownName === 'archive')
                        : pastas.find(f => f.name.toLowerCase() === String(args?.valor || '').toLowerCase())
                          || pastas.find(f => f.name.toLowerCase().includes(String(args?.valor || '').toLowerCase()));

                    if (!alvo) {
                        return { result: {
                            erro: `Não achei a pasta "${args?.valor}".`,
                            pastasDisponiveis: pastas.filter(f => !f.wellKnownName).map(f => f.name).slice(0, 40),
                        } };
                    }

                    if (args?.confirmado !== true) {
                        return { result: {
                            previa: true, pasta: alvo.name,
                            resumo: `Confirme: mover esta mensagem para "${alvo.name}"? `
                                + 'Ela sai da pasta atual, aqui e no Outlook.',
                        } };
                    }

                    await outlookService.move(caixa, id, alvo.id);
                    return { result: { ok: true, resumo: `Movida para ${alvo.name}.` } };
                }

                default:
                    return { result: { erro: 'Ação não reconhecida.' } };
            }
        } catch (err) {
            const status = err?.response?.status;
            if (status === 403) {
                return { result: { erro: 'Isto depende da permissão Mail.ReadWrite no Azure, que o tenant ainda não concedeu.' } };
            }
            return { result: { erro: err.message } };
        }
    },
});

registerTool({
    name: 'outlook_criar_regra',
    description: 'Cria uma regra para a IA seguir na caixa, a partir de uma frase do usuário ("arquive newsletters e me avise só se citarem a Menin", "sempre me avise de e-mail da prefeitura"). SEMPRE mostre como a regra ficou e confirme antes de criar - ela passa a valer para todo e-mail que chegar.',
    parameters: {
        type: 'object',
        properties: {
            texto:      { type: 'string', description: 'A regra na linguagem do usuário.' },
            confirmado: { type: 'boolean', description: 'true SÓ depois de o usuário confirmar.' },
        },
        required: ['texto'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        if (!await userCan(u, '/microsoft/outlook', 'automate')) {
            return { result: { erro: 'Mexer no que a IA faz sozinha depende de uma alçada própria, que você não tem nesta tela.' } };
        }

        const texto = String(args?.texto || '').trim();
        if (!texto) return { result: { erro: 'Descreva a regra.' } };

        if (args?.confirmado !== true) {
            return { result: {
                previa: true, texto,
                resumo: `Confirme antes de eu criar: "${texto}". A regra passa a valer para todo e-mail que chegar.`,
            } };
        }

        try {
            const regras = await ai.createRuleFromText(u.id, texto);
            const nova = regras.filter(r => r.origem === 'texto').pop();
            return { result: {
                criada: true,
                titulo: nova?.titulo,
                descricao: nova?.descricao,
                modo: nova?.modo === 'automatico' ? 'age sozinha' : 'pede seu OK',
                resumo: `Regra "${nova?.titulo}" criada e ativa.`,
            } };
        } catch (err) {
            return { result: { erro: err.message } };
        }
    },
});

registerTool({
    name: 'outlook_ensinar_ia',
    description: 'Guarda uma correção do usuário sobre como a IA escreve, para valer nas PRÓXIMAS respostas. Use quando ele reclamar do texto ("ficou formal demais", "não me chame de prezado", "sempre copie o Rafael nisso", "seja mais curto"). Não precisa de confirmação: é uma anotação, não uma ação na caixa.',
    parameters: {
        type: 'object',
        properties: {
            comentario: { type: 'string', description: 'O que ela deve fazer diferente, na linguagem do usuário.' },
            nota:       { type: 'string', description: 'bom | ruim, se ele elogiou ou reclamou.' },
        },
        required: ['comentario'],
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const { erro, u } = await comCaixa(user);
        if (erro) return { result: erro };

        const comentario = String(args?.comentario || '').trim();
        if (!comentario) return { result: { erro: 'O que ela deve fazer diferente?' } };

        await ai.registrarFeedback(u.id, {
            comentario,
            nota: ['bom', 'ruim'].includes(args?.nota) ? args.nota : 'ruim',
        });

        return { result: {
            guardado: true,
            resumo: `Anotado: "${comentario}". Vou levar isso em conta em toda resposta que escrever daqui para frente.`,
        } };
    },
});

export default {};
