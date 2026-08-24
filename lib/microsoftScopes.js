// lib/microsoftScopes.js
//
// INVENTÁRIO DE PERMISSÕES da integração Microsoft 365.
//
// Por que existe: o repositório não era a fonte da verdade sobre o que a
// integração pode fazer. BASE_SCOPES pede nove escopos e nenhum deles cobre o
// Planner nem a listagem do diretório — essas telas funcionam porque o
// consentimento de administrador feito no portal do Azure devolve escopos além
// dos pedidos. Isso vivia num comentário de código e em lugar nenhum além dele,
// então um novo consentimento derrubava duas telas sem aviso, com 403 genérico.
//
// Este arquivo é lido pela tela de diagnóstico (/settings/integracao-microsoft),
// que compara o inventário com o `scp` do token real e diz, item por item, o que
// está consentido e o que falta.
//
// IMPORTANTE: mexer aqui NÃO muda o que é pedido no login. O que é pedido está
// em MicrosoftAuthService.BASE_SCOPES, e escopo que exige consentimento de
// administrador não pode entrar lá antes de ser concedido no portal — senão o
// login passa a falhar para todo mundo com "need admin approval".

/**
 * Cada entrada é uma FUNCIONALIDADE do Office, não um endpoint.
 *   required   - sem isto a funcionalidade não roda
 *   anyOf      - basta um dos escopos (ex.: Read é suficiente, ReadWrite cobre)
 *   requested  - já está em BASE_SCOPES (pedido no login)
 *   grantedBy  - 'user' = a pessoa consente sozinha | 'admin' = só o administrador
 */
export const MICROSOFT_SCOPE_INVENTORY = [
    {
        key: 'auth',
        feature: 'Entrar com a conta Microsoft',
        screen: 'Login',
        anyOf: ['User.Read'],
        requested: true,
        grantedBy: 'user',
        note: 'Perfil básico da pessoa (nome, e-mail, cargo). Base de tudo.',
    },
    {
        key: 'calendar',
        feature: 'Agenda e reuniões do Teams',
        screen: '/microsoft/teams',
        anyOf: ['Calendars.ReadWrite'],
        requested: true,
        grantedBy: 'user',
        note: 'Ler o calendário, criar, editar e cancelar evento e série recorrente.',
    },
    {
        key: 'onlineMeetings',
        feature: 'Reunião instantânea do Teams',
        screen: '/microsoft/teams',
        anyOf: ['OnlineMeetings.ReadWrite'],
        requested: true,
        grantedBy: 'user',
        note: 'Criar link de reunião na hora, sem evento no calendário.',
    },
    {
        key: 'transcripts',
        feature: 'Transcrição das reuniões (organizador)',
        screen: '/microsoft/teams?tab=reunioes',
        anyOf: ['OnlineMeetingTranscript.Read.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Baixar a transcrição de reunião que a própria pessoa organizou.',
    },
    {
        key: 'sharepointRead',
        feature: 'Navegar em sites e bibliotecas',
        screen: '/microsoft/sharepoint',
        anyOf: ['Sites.ReadWrite.All', 'Sites.Read.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Listar sites, bibliotecas e pastas do SharePoint.',
    },
    {
        key: 'sharepointWrite',
        feature: 'Enviar, renomear, mover e excluir arquivo',
        screen: '/microsoft/sharepoint',
        anyOf: ['Files.ReadWrite.All'],
        requested: true,
        grantedBy: 'admin',
        note: 'Também alimenta o seletor de anexos das Fichas Comerciais e do Checklist.',
    },
    {
        key: 'planner',
        feature: 'Quadro do Planner',
        screen: '/microsoft/planner',
        anyOf: ['Tasks.ReadWrite', 'Tasks.Read'],
        requested: false,
        grantedBy: 'user',
        note: 'NÃO é pedido no login. Só funciona com consentimento de administrador no portal do Azure.',
    },
    {
        key: 'plannerGroups',
        feature: 'Enxergar os grupos que têm plano',
        screen: '/microsoft/planner',
        anyOf: ['GroupMember.Read.All', 'Group.Read.All', 'Directory.Read.All'],
        requested: false,
        grantedBy: 'admin',
        note: 'Sem isto a lista de grupos volta vazia e a tela parece "sem planos".',
    },
    {
        key: 'mail',
        feature: 'Outlook: ler, rascunhar e enviar e-mail',
        screen: '/settings/outlook-lab',
        anyOf: ['Mail.ReadWrite', 'Mail.Read'],
        requested: false,
        grantedBy: 'user',
        note: 'Autorização SEPARADA do login, feita por conta no Laboratório do Outlook. Fora do login de propósito: escopo novo no login vale para todo mundo e pode travar a entrada.',
    },
    {
        key: 'mailSend',
        feature: 'Outlook: enviar em nome da pessoa',
        screen: '/settings/outlook-lab',
        anyOf: ['Mail.Send'],
        requested: false,
        grantedBy: 'user',
        note: 'É o que permite o Office disparar cobrança, aviso e relatório saindo do endereço da própria pessoa.',
    },
    {
        key: 'orgUsers',
        feature: 'Importar pessoas da organização',
        screen: '/settings/users',
        anyOf: ['User.ReadBasic.All', 'User.Read.All', 'Directory.Read.All'],
        requested: false,
        grantedBy: 'admin',
        note: 'NÃO é pedido no login. Depende do consentimento de administrador.',
    },
];

/**
 * Permissões de APLICAÇÃO (sem usuário). Não aparecem no token delegado — o
 * diagnóstico só informa que existem e para que servem.
 */
export const MICROSOFT_APP_PERMISSIONS = [
    {
        key: 'teamsMessage',
        feature: 'Teams como canal de mensagem do Office',
        permissions: ['ChatMessage.Send', 'Chat.ReadWrite.All', 'TeamsActivity.Send'],
        note: 'NÃO CONCEDIDA. O Office fala por e-mail, WhatsApp, in-app e push, mas não pelo canal onde a empresa realmente conversa. O app tem Chat.Read.All (ler), e nenhuma das de ESCRITA — mandar mensagem no Teams exige uma das três acima. Sem elas não há caminho: webhook de canal do Teams resolveria aviso de canal, mas não mensagem para uma pessoa, que é o caso de cobrança e alerta.',
    },
    {
        key: 'changeNotifications',
        feature: 'A Microsoft avisar quando algo muda (assinaturas)',
        permissions: ['Mail.Read', 'Calendars.Read'],
        note: 'Concedidas. As assinaturas usam as mesmas permissões da leitura, então o recurso funciona; o que ele exige a mais não é permissão, é uma URL HTTPS pública para a Microsoft chamar de volta (PUBLIC_API_URL). Em ambiente local não funciona.',
    },
    {
        key: 'transcriptsApp',
        feature: 'Transcrição de reunião que a pessoa apenas participou',
        permissions: ['OnlineMeetings.Read.All', 'OnlineMeetingTranscript.Read.All'],
        note: 'Exige, além do consentimento, uma política de acesso a aplicativo (application access policy) no tenant. Sem isso, o Office só alcança a transcrição de quem organizou a reunião.',
    },
];

/** Lista achatada de tudo que o login pede hoje, para conferência na tela. */
export function requestedScopeKeys(baseScopes) {
    return String(baseScopes || '')
        .split(/\s+/)
        .filter(Boolean)
        .filter(s => !['openid', 'profile', 'email', 'offline_access'].includes(s));
}

/**
 * Compara o inventário com os escopos que o token realmente carrega.
 * @param {string[]} granted - conteúdo do claim `scp` do access_token
 */
export function diagnoseScopes(granted) {
    const set = new Set((granted || []).map(s => s.toLowerCase()));

    return MICROSOFT_SCOPE_INVENTORY.map(entry => {
        const matched = entry.anyOf.filter(s => set.has(s.toLowerCase()));
        return {
            ...entry,
            granted: matched.length > 0,
            matchedScopes: matched,
            missing: matched.length ? [] : entry.anyOf,
        };
    });
}
