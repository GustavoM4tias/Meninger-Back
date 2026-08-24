// lib/microsoftPermissoes.js
//
// De um 403 do Graph para uma FRASE ACIONÁVEL.
//
// Antes, permissão faltando chegava na tela como "Permissão insuficiente para
// esta operação Microsoft. Código: ErrorAccessDenied" - que não diz o que
// liberar, nem para quem pedir, nem onde. O usuário desistia e ninguém ficava
// sabendo que faltava uma linha marcada no portal do Azure.
//
// Aqui o caminho da chamada que falhou vira o nome exato da permissão, o tipo
// (Aplicação x Delegada - errar isso é o engano mais comum no portal) e o que
// ela destrava. O front pega isso e abre o aviso, toda vez que a pessoa tentar:
// a funcionalidade fica bloqueada até alguém conceder, e é justamente essa
// insistência que faz a autorização acontecer.
//
// A lista completa, com o passo a passo, está em
// _estudo/microsoft/PERMISSOES-AZURE.md. Aqui ficam só as que o código já pede.

export const APP_ID     = '291d3be9-7ec0-48aa-9f4b-598db950a538';
export const PORTAL_URL =
    `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${APP_ID}/isMSAApp~/false`;

/**
 * Cada regra: quando o caminho casa (e o método, se declarado), é esta
 * permissão que falta. A ordem importa - a primeira que casa vence.
 */
const REGRAS = [
    {
        teste: (p, m) => /\/mailFolders|\/messages|\/sendMail/i.test(p) && m !== 'get',
        nome: 'Mail.ReadWrite',
        tipo: 'Aplicação',
        destrava: 'Mover e-mail de pasta, marcar como lido, sinalizar, categorizar, criar rascunho e excluir.',
    },
    {
        teste: (p) => /mailboxSettings/i.test(p),
        nome: 'MailboxSettings.Read',
        tipo: 'Aplicação',
        destrava: 'Ler assinatura, fuso, horário de trabalho, resposta automática e regras da caixa.',
    },
    {
        teste: (p, m) => /\/mailFolders|\/messages/i.test(p) && m === 'get',
        nome: 'Mail.Read',
        tipo: 'Aplicação',
        destrava: 'Ler as mensagens e os anexos da caixa.',
    },
    {
        teste: (p) => /getSchedule/i.test(p),
        nome: 'Calendars.Read.Shared',
        tipo: 'Delegada',
        destrava: 'Ver quem está livre antes de marcar reunião. Sem ela, todos os convidados ficam cinzas.',
    },
    {
        teste: (p) => /\/me\/memberOf/i.test(p),
        nome: 'GroupMember.Read.All',
        tipo: 'Delegada',
        destrava: 'Enxergar os grupos que têm plano no Planner. Sem ela o quadro parece vazio.',
    },
    {
        teste: (p) => /\/planner\//i.test(p),
        nome: 'Tasks.ReadWrite',
        tipo: 'Delegada',
        destrava: 'O quadro do Planner: buckets, tarefas, prazos e responsáveis.',
    },
    {
        teste: (p) => /\/onlineMeetings\/[^/]+\/transcripts/i.test(p),
        nome: 'OnlineMeetings.Read.All',
        tipo: 'Aplicação',
        destrava: 'Transcrição de reunião que a pessoa apenas participou, quando ninguém carregou a reunião ainda.',
        alem: 'Além do consentimento, esta exige uma política de acesso a aplicativo no tenant, criada por PowerShell do Teams.',
    },
    {
        teste: (p) => /^\/users(\?|$)/i.test(p),
        nome: 'User.ReadBasic.All',
        tipo: 'Delegada',
        destrava: 'Ler o nome das pessoas do diretório da Menin: responsáveis, participantes e a importação de usuários.',
    },
    {
        teste: (p) => /\/presence|getPresencesByUserId/i.test(p),
        nome: 'Presence.Read.All',
        tipo: 'Delegada',
        destrava: 'Mostrar quem está disponível, ocupado ou em reunião no Teams.',
    },
    {
        teste: (p) => /\/places/i.test(p),
        nome: 'Place.Read.All',
        tipo: 'Delegada',
        destrava: 'Escolher a sala na hora de marcar a reunião, com capacidade e recursos - em vez de escrever o local à mão.',
    },
    {
        teste: (p) => /\/chats|\/teamwork/i.test(p),
        nome: 'TeamsActivity.Send',
        tipo: 'Aplicação',
        destrava: 'O Office avisar pelo Teams (cobrança de checklist, alerta de reserva, aviso de fechamento).',
        alem: 'Esta também exige o Office registrado como aplicativo do Teams.',
    },
    {
        teste: (p, m) => /\/drives|\/sites/i.test(p) && m !== 'get',
        nome: 'Files.ReadWrite.All',
        tipo: 'Delegada',
        destrava: 'Enviar, renomear, mover e excluir arquivo no SharePoint e no OneDrive.',
    },
    {
        teste: (p) => /\/drives|\/sites/i.test(p),
        nome: 'Sites.Read.All',
        tipo: 'Delegada',
        destrava: 'Navegar em site, biblioteca e pasta do SharePoint.',
    },
    {
        teste: (p) => /\/events|\/calendar/i.test(p),
        nome: 'Calendars.ReadWrite',
        tipo: 'Delegada',
        destrava: 'Ler a agenda e criar, editar ou cancelar compromisso.',
    },
];

/**
 * @param {string} path   caminho chamado no Graph (sem o host)
 * @param {string} method verbo em minúsculas
 * @returns {object|null} o que dizer ao usuário, ou null se não soubermos
 */
export function permissaoDaChamada(path, method = 'get') {
    const p = String(path || '');
    const m = String(method || 'get').toLowerCase();

    for (const r of REGRAS) {
        if (!r.teste(p, m)) continue;
        return {
            nome: r.nome,
            tipo: r.tipo,
            destrava: r.destrava,
            alem: r.alem || null,
            portal: PORTAL_URL,
            appId: APP_ID,
        };
    }
    return null;
}

/**
 * Anexa a informação de permissão ao erro e REGISTRA no log.
 *
 * O aviso na tela foi removido em 24/08/2026: quem esbarra na falta é o usuário
 * comum, e ele não pode resolver nada disso - conceder permissão é do
 * administrador do tenant. Modal para ele era só um susto sem saída.
 *
 * O registro fica aqui, no log do servidor: é assim que a gente descobre QUAIS
 * permissões estão sendo batidas de verdade, em vez de deduzir da documentação.
 * Para onde isso deve aparecer (tela de saúde só para admin, alerta, relatório)
 * está em aberto - ver as pendências.
 */
export function marcarErroDePermissao(err, path, method) {
    const info = permissaoDaChamada(path, method);
    if (!info) return err;

    err.permissao = info;
    console.warn(`[Graph] permissão faltando: ${info.nome} (${info.tipo}) — ${String(method || 'get').toUpperCase()} ${path}`);
    return err;
}
