// services/OfficeAI/MicrosoftTools.js
//
// Tools da Eme sobre o ecossistema Microsoft. Até aqui ela não conhecia nada
// disso: nenhuma tool tocava no Graph, então "qual minha agenda hoje" ou "acha o
// contrato do Ibitinga no SharePoint" não tinham resposta, mesmo com os serviços
// prontos no backend.
//
// Segurança:
//   - Agenda e SharePoint usam o token DELEGADO da própria pessoa: o que a Eme
//     alcança é exatamente o que ela alcançaria no Outlook.
//   - E-mail usa token de APLICAÇÃO (é o que o tenant consentiu), e por isso a
//     caixa é SEMPRE a de `user` — nunca um endereço vindo dos args do Gemini.
//     Args do modelo não ampliam escopo em nenhuma hipótese.
//   - requiredPermissions amarra cada tool à tela correspondente, então quem não
//     tem a tela não tem a tool.

import { registerTool } from './ToolRegistry.js';
import db from '../../models/sequelize/index.js';
import teamsService from '../microsoft/MicrosoftTeamsService.js';
import sharepointService from '../microsoft/MicrosoftSharepointService.js';
import outlookService from '../microsoft/MicrosoftOutlookService.js';

const TZ = 'America/Sao_Paulo';

/** Registro completo do usuário (o req.user do middleware não traz os tokens). */
async function fullUser(user) {
    const id = user?.id ?? user;
    return db.User.findByPk(id, {
        attributes: ['id', 'username', 'email', 'microsoft_id',
                     'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
    });
}

const semConta = {
    erro: 'Sua conta Microsoft não está vinculada ao Office. Conecte em Minha Conta para eu poder consultar.',
};

/** Converte "hoje", "amanhã", "esta semana" em um intervalo ISO em UTC. */
function periodo(quando = 'hoje') {
    const agora = new Date();
    const local = new Date(agora.toLocaleString('en-US', { timeZone: TZ }));
    const inicio = new Date(local);
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date(inicio);

    const q = String(quando || 'hoje').toLowerCase();
    if (q.includes('amanh')) { inicio.setDate(inicio.getDate() + 1); fim.setDate(fim.getDate() + 2); }
    else if (q.includes('semana')) { fim.setDate(fim.getDate() + 7); }
    else if (q.includes('mes') || q.includes('mês')) { fim.setDate(fim.getDate() + 30); }
    else if (q.includes('ontem')) { inicio.setDate(inicio.getDate() - 1); fim.setDate(fim.getDate()); }
    else { fim.setDate(fim.getDate() + 1); }

    return { inicio: inicio.toISOString(), fim: fim.toISOString(), rotulo: q };
}

function hora(iso) {
    if (!iso) return '';
    // O Graph já devolve no fuso de Brasília (header Prefer no service).
    return String(iso).slice(11, 16);
}

function dia(iso) {
    if (!iso) return '';
    const [a, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}`;
}

// ─── Agenda ──────────────────────────────────────────────────────────────────

registerTool({
    name: 'my_agenda',
    description: 'Mostra a AGENDA do próprio usuário (calendário do Teams/Outlook): compromissos, reuniões, horários, participantes e link de entrada. Use quando perguntarem "qual minha agenda hoje", "o que eu tenho amanhã", "minhas reuniões da semana", "estou livre às 15h?", "quantas reuniões eu tenho". Devolve os eventos em ordem de horário, com o que é reunião online marcado.',
    parameters: {
        type: 'object',
        properties: {
            quando: { type: 'string', description: 'Período em linguagem natural: "hoje" (padrão), "amanhã", "esta semana", "este mês", "ontem".' },
        },
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const { inicio, fim, rotulo } = periodo(args?.quando);
        const { items } = await teamsService.getCalendarView(u, inicio, fim);

        const eventos = items
            .filter(e => !e.isCancelled)
            .map(e => ({
                assunto: e.subject,
                dia: dia(e.start),
                inicio: hora(e.start),
                fim: hora(e.end),
                diaInteiro: e.isAllDay,
                online: e.isOnlineMeeting,
                linkEntrada: e.joinUrl,
                local: e.location,
                organizador: e.organizer?.name,
                participantes: e.attendees.length,
                recorrente: e.isRecurring,
            }));

        return {
            result: {
                periodo: rotulo,
                total: eventos.length,
                eventos,
                resumo: eventos.length
                    ? `${eventos.length} compromisso(s) em "${rotulo}". Primeiro: ${eventos[0].assunto} às ${eventos[0].inicio}.`
                    : `Nenhum compromisso em "${rotulo}".`,
            },
        };
    },
});

registerTool({
    name: 'check_availability',
    description: 'Verifica a DISPONIBILIDADE de pessoas num intervalo, para saber quem está livre antes de marcar reunião. Use quando perguntarem "o fulano está livre amanhã às 10h", "quando o time está disponível", "acha um horário para eu e o X". Informe os e-mails das pessoas e o intervalo. Devolve, por pessoa, os blocos ocupados e se está livre no horário pedido.',
    parameters: {
        type: 'object',
        properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'E-mails das pessoas a consultar (inclua o próprio usuário se ele fizer parte).' },
            inicio: { type: 'string', description: 'Início do intervalo, ISO local sem Z. Ex: 2026-08-25T09:00:00' },
            fim:    { type: 'string', description: 'Fim do intervalo, ISO local sem Z. Ex: 2026-08-25T18:00:00' },
        },
        required: ['emails', 'inicio', 'fim'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const emails = (args?.emails || []).map(e => String(e).trim()).filter(Boolean);
        if (!emails.length) return { result: { erro: 'Informe ao menos um e-mail.' } };

        const agenda = await teamsService.getSchedule(u, emails, args.inicio, args.fim);
        return {
            result: {
                intervalo: `${args.inicio} a ${args.fim}`,
                pessoas: agenda,
                resumo: agenda.map(p =>
                    `${p.email}: ${p.livre ? 'livre' : `${p.ocupado.length} bloco(s) ocupado(s)`}`
                ).join(' · '),
            },
        };
    },
});

registerTool({
    name: 'schedule_meeting',
    description: 'AGENDA uma reunião no calendário do usuário, com link do Teams. Use quando pedirem "marca uma reunião com o fulano amanhã às 10", "agenda 30 minutos com o time". SEMPRE confirme com o usuário antes: assunto, dia, horário, duração e participantes. Se não souber se as pessoas estão livres, use check_availability primeiro. A reunião é criada no calendário DELE, com ele como organizador.',
    parameters: {
        type: 'object',
        properties: {
            assunto:       { type: 'string', description: 'Assunto da reunião.' },
            inicio:        { type: 'string', description: 'Início, ISO local sem Z. Ex: 2026-08-25T10:00:00' },
            fim:           { type: 'string', description: 'Fim, ISO local sem Z. Ex: 2026-08-25T10:30:00' },
            participantes: { type: 'array', items: { type: 'string' }, description: 'E-mails dos convidados.' },
            descricao:     { type: 'string', description: 'Texto do convite (opcional).' },
            local:         { type: 'string', description: 'Local físico, se houver (opcional).' },
            online:        { type: 'boolean', description: 'Cria link do Teams. Padrão: true.' },
            confirmado:    { type: 'boolean', description: 'Passe true SÓ depois de o usuário confirmar. Sem isso, a tool devolve a prévia sem agendar nada.' },
        },
        required: ['assunto', 'inicio', 'fim'],
    },
    requiredPermissions: ['/microsoft/teams'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const convidados = (args?.participantes || []).map(e => String(e).trim()).filter(Boolean);

        // Agendar dispara convite para outras pessoas: sem confirmação explícita,
        // devolve a prévia e não cria nada.
        if (args?.confirmado !== true) {
            return {
                result: {
                    previa: true,
                    assunto: args.assunto,
                    inicio: args.inicio,
                    fim: args.fim,
                    participantes: convidados,
                    online: args?.online !== false,
                    resumo: `Confirme antes de eu agendar: "${args.assunto}", de ${args.inicio} a ${args.fim}`
                          + (convidados.length ? `, convidando ${convidados.join(', ')}.` : ', sem convidados.')
                          + ' O convite sai no seu nome.',
                },
            };
        }

        const evento = await teamsService.createScheduledMeeting(u, {
            subject: args.assunto,
            start: args.inicio,
            end: args.fim,
            attendees: convidados,
            body: args?.descricao || '',
            location: args?.local || '',
            isOnlineMeeting: args?.online !== false,
        });

        return {
            result: {
                agendado: true,
                id: evento.id,
                assunto: evento.subject,
                inicio: evento.start,
                fim: evento.end,
                linkEntrada: evento.joinUrl,
                resumo: `Reunião "${evento.subject}" agendada para ${dia(evento.start)} às ${hora(evento.start)}`
                      + (convidados.length ? `, convite enviado para ${convidados.length} pessoa(s).` : '.'),
            },
        };
    },
});

// ─── SharePoint ──────────────────────────────────────────────────────────────

registerTool({
    name: 'find_in_sharepoint',
    description: 'Procura ARQUIVO no SharePoint da empresa por nome ou conteúdo, e devolve o link para abrir. Use quando pedirem "acha o contrato do Ibitinga", "onde está a planilha de custos", "me manda o arquivo X", "procura no SharePoint". Busca em todas as bibliotecas dos sites que a pessoa alcança. Devolve nome, biblioteca, data da última alteração e link.',
    parameters: {
        type: 'object',
        properties: {
            termo: { type: 'string', description: 'O que procurar (nome do arquivo, empreendimento, assunto).' },
            limite: { type: 'number', description: 'Quantos resultados no máximo. Padrão 10.' },
        },
        required: ['termo'],
    },
    requiredPermissions: ['/microsoft/sharepoint'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const termo = String(args?.termo || '').trim();
        if (!termo) return { result: { erro: 'Diga o que devo procurar.' } };
        const limite = Math.min(Number(args?.limite) || 10, 25);

        const { items: sites } = await sharepointService.getSites(u);
        const achados = [];

        // Varre biblioteca por biblioteca até juntar o limite. Para na primeira
        // vez que enche, para não fazer dezenas de chamadas por uma pergunta.
        for (const site of sites.slice(0, 8)) {
            if (achados.length >= limite) break;
            let drives = [];
            try { ({ items: drives } = await sharepointService.getSiteDrives(u, site.id)); } catch { continue; }

            for (const drive of drives.slice(0, 3)) {
                if (achados.length >= limite) break;
                try {
                    const { items } = await sharepointService.search(u, drive.id, termo);
                    for (const it of items) {
                        if (it.isFolder) continue;
                        achados.push({
                            nome: it.name,
                            site: site.name,
                            biblioteca: drive.name,
                            tamanhoKb: Math.round((it.size || 0) / 1024),
                            alteradoEm: it.lastModified,
                            link: it.webUrl,
                        });
                        if (achados.length >= limite) break;
                    }
                } catch { /* biblioteca sem acesso: segue */ }
            }
        }

        return {
            result: {
                termo,
                total: achados.length,
                arquivos: achados,
                resumo: achados.length
                    ? `${achados.length} arquivo(s) para "${termo}". Primeiro: ${achados[0].nome} (${achados[0].site} / ${achados[0].biblioteca}).`
                    : `Nenhum arquivo encontrado para "${termo}" nas bibliotecas que você alcança.`,
            },
        };
    },
});

// ─── E-mail ──────────────────────────────────────────────────────────────────

registerTool({
    name: 'search_email',
    description: 'Procura E-MAIL na caixa do próprio usuário e resume o que achou. Use quando pedirem "acha o e-mail do fulano sobre X", "recebi algo do Sienge?", "qual foi a resposta sobre o contrato", "meus e-mails não lidos". Devolve remetente, assunto, data e prévia. Não abre anexo nem manda e-mail.',
    parameters: {
        type: 'object',
        properties: {
            termo:      { type: 'string', description: 'Texto a procurar no assunto e no corpo. Vazio lista os mais recentes.' },
            naoLidos:   { type: 'boolean', description: 'Só os não lidos.' },
            comAnexo:   { type: 'boolean', description: 'Só os que têm anexo.' },
            pasta:      { type: 'string', description: 'inbox (padrão), sentitems, drafts, archive.' },
            limite:     { type: 'number', description: 'Quantos no máximo. Padrão 10.' },
        },
    },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        // A caixa é SEMPRE a da própria pessoa. O Gemini não escolhe caixa.
        const { items } = await outlookService.listMessages(u.microsoft_id, {
            folder: ['inbox', 'sentitems', 'drafts', 'archive'].includes(args?.pasta) ? args.pasta : 'inbox',
            search: String(args?.termo || '').trim(),
            unreadOnly: args?.naoLidos === true,
            withAttachments: args?.comAnexo === true,
            top: Math.min(Number(args?.limite) || 10, 25),
        });

        const emails = items.map(m => ({
            de: m.from?.name || m.from?.email,
            email: m.from?.email,
            assunto: m.subject,
            recebidoEm: m.receivedAt,
            lido: m.isRead,
            temAnexo: m.hasAttachments,
            previa: m.preview.slice(0, 200),
        }));

        return {
            result: {
                total: emails.length,
                emails,
                resumo: emails.length
                    ? `${emails.length} e-mail(s)${args?.termo ? ` sobre "${args.termo}"` : ''}. Mais recente: "${emails[0].assunto}" de ${emails[0].de}.`
                    : `Nenhum e-mail${args?.termo ? ` sobre "${args.termo}"` : ''} nessa pasta.`,
            },
        };
    },
});

registerTool({
    name: 'inbox_summary',
    description: 'Resumo rápido da CAIXA DE ENTRADA do usuário: quantos não lidos, de quem são e sobre o quê. Use para "tenho e-mail novo?", "o que chegou hoje?", "resume minha caixa", "estou atrasado em algum e-mail?".',
    parameters: { type: 'object', properties: {} },
    requiredPermissions: ['/microsoft/outlook'],
    contexts: ['OFFICE'],
    async handler(user) {
        const u = await fullUser(user);
        if (!u?.microsoft_id) return { result: semConta };

        const contagem = await outlookService.unreadCount(u.microsoft_id);
        const { items } = await outlookService.listMessages(u.microsoft_id, {
            folder: 'inbox', unreadOnly: true, top: 15,
        });

        // Agrupa por remetente: "5 do CV CRM" diz mais que cinco linhas iguais.
        const porRemetente = {};
        for (const m of items) {
            const chave = m.from?.name || m.from?.email || '(sem remetente)';
            porRemetente[chave] = (porRemetente[chave] || 0) + 1;
        }
        const remetentes = Object.entries(porRemetente)
            .sort((a, b) => b[1] - a[1])
            .map(([nome, qtd]) => ({ nome, quantidade: qtd }));

        return {
            result: {
                naoLidos: contagem.unread,
                totalNaCaixa: contagem.total,
                porRemetente: remetentes,
                maisRecentes: items.slice(0, 8).map(m => ({
                    de: m.from?.name || m.from?.email,
                    assunto: m.subject,
                    recebidoEm: m.receivedAt,
                    temAnexo: m.hasAttachments,
                })),
                resumo: contagem.unread
                    ? `${contagem.unread} não lido(s) de ${contagem.total} na caixa. Quem mais escreveu: ${remetentes.slice(0, 3).map(r => `${r.nome} (${r.quantidade})`).join(', ')}.`
                    : 'Caixa de entrada em dia, nenhum e-mail não lido.',
            },
        };
    },
});
