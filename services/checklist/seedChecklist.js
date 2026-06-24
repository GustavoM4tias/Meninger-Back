// services/checklist/seedChecklist.js
//
// Seed idempotente do módulo Checklist:
//  1) catálogo GLOBAL de status (com os status do Excel mapeados a state_class);
//  2) template "Lançamento de Empreendimento" extraído 1:1 do checklist real
//     Três Marias - Ibitinga (3 seções, categorias, valores e prazos relativos
//     aos marcos Meeting/Abertura de Loja).
//
// Roda no boot (bootServer). Nunca lança — falha de seed nao derruba o servidor.

import db from '../../models/sequelize/index.js';

// ── Catálogo de status (GLOBAL) ───────────────────────────────────────────────
// state_class normaliza o label custom: TODO | IN_PROGRESS | BLOCKED | DONE | CANCELLED
const STATUSES = [
    { label: 'SOLICITADO',       state_class: 'TODO',        color: '#64748b', position: 10 },
    { label: 'EM ESTUDO',        state_class: 'IN_PROGRESS', color: '#f59e0b', position: 20 },
    { label: 'EM ORÇAMENTO',     state_class: 'IN_PROGRESS', color: '#f59e0b', position: 30 },
    { label: 'EM APROVAÇÃO',     state_class: 'BLOCKED',     color: '#ef4444', position: 40 },
    { label: 'EM CRIAÇÃO',       state_class: 'IN_PROGRESS', color: '#3b82f6', position: 50 },
    { label: 'EM EXECUÇÃO',      state_class: 'IN_PROGRESS', color: '#3b82f6', position: 60 },
    { label: 'EM AJUSTE',        state_class: 'IN_PROGRESS', color: '#f97316', position: 70 },
    { label: 'SOLIC P/ COMPRAS', state_class: 'IN_PROGRESS', color: '#8b5cf6', position: 80 },
    { label: 'CONCLUÍDO',        state_class: 'DONE',        color: '#22c55e', position: 90 },
    { label: 'CANCELADO',        state_class: 'CANCELLED',   color: '#9ca3af', position: 100 },
    // N/A = não se aplica: nao entra no cálculo de progresso/atraso (como CANCELLED).
    { label: 'N/A',              state_class: 'CANCELLED',   color: '#a8a29e', position: 110 },
];

// ── Template "Lançamento de Empreendimento" ───────────────────────────────────
// anchor: STORE_OPENING (Abertura de Loja) | MEETING. offset em dias (negativo =
// antes do marco). Valores e prazos vêm do Excel Três Marias - Ibitinga.
const LAUNCH_TEMPLATE = {
    name: 'Lançamento de Empreendimento',
    kind: 'LAUNCH',
    description: 'Modelo padrão de checklist de lançamento (Engenharia e Comercial, Agência de Marketing, Marketing Interno). Gerado a partir do checklist Três Marias - Ibitinga.',
    icon: 'rocket',
    color: '#2563eb',
    is_default: true,
    sections: [
        {
            name: 'Engenharia e Comercial',
            color: '#0ea5e9',
            items: [
                { title: 'Documento registro do empreendimento', assignee: 'TAKETA' },
                { title: 'Comunicar Leonardo - Obras', assignee: 'TAKETA' },
                { title: 'CNPJ - Cartão', assignee: 'TAKETA' },
                { title: 'Documento informações de ficha técnica', assignee: 'DINIZ' },
                { title: 'Documento informações comerciais', assignee: 'DINIZ' },
                { title: 'Projeto implantação (DWG e PDF)', assignee: 'TAKETA' },
                { title: 'Projeto produto - casa ou apartamento (DWG e PDF)', assignee: 'TAKETA' },
                { title: 'Texto legal para publicidades', assignee: 'TAKETA' },
                { title: 'Contratação de local da loja (locação)', assignee: 'CIDA' },
                { title: 'Contratação de gestor', assignee: 'CIDA' },
                { title: 'Contratação de ADM', assignee: 'CIDA' },
            ],
        },
        {
            name: 'Agência - MKT',
            color: '#a855f7',
            items: [
                { title: 'Criação logo', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'KV do produto - manual de uso da logo', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Camiseta', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Windbanner', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Book do corretor', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Book do cliente', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Panfleto para ação', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Panfleto para combate', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Vídeo teaser - vem aí', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Outdoor - fixo na área', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Outdoor - fase teaser', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Outdoor - fase pré-lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Outdoor - fase lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Artes para corretores WhatsApp - fase teaser', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Artes para corretores WhatsApp - fase pré-lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Artes para corretores WhatsApp - fase lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Criativos para patrocinado - fase teaser', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Criativos para patrocinado - fase pré-lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Criativos para patrocinado - fase lançamento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Chave para foto', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Comunicação visual da loja', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Convite digital meeting - para corretores', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Convite digital lançamento - para futuros clientes', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -10 },
                { title: 'Sugestões de influenciadores', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -5 },
                { title: 'Sugestões de portais de notícias', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -5 },
            ],
        },
        {
            name: 'Interno - MKT',
            color: '#10b981',
            items: [
                // Categoria: Empreendimento
                { title: 'Projeto loja - arquiteta e acompanhamento', category: 'Empreendimento', value: 3000, assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Maquete', category: 'Empreendimento', value: 10500, assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Implantação e voo de pássaro 3D', category: 'Empreendimento', value: 1000, assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Imagens ilustrativas', category: 'Empreendimento', value: 2000, assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Hotsite', category: 'Empreendimento', assignee: 'DINIZ', anchor: 'STORE_OPENING', offset: -8 },
                { title: 'Kit infláveis: balão e tenda', category: 'Empreendimento', value: 6300, assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -11 },
                { title: 'Contratação de outdoors', category: 'Empreendimento', value: 1200, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: 'Pontos de outdoors disponíveis na cidade' },
                { title: 'Contratação de drone - imagens da área e de pontos da cidade', category: 'Empreendimento', value: 450, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -22 },
                { title: 'Contratação de outdoor na área', category: 'Empreendimento', value: 8900, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Equipe para panfletagem', category: 'Empreendimento', value: 100, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -1 },
                { title: 'Contratação de impressão de panfletos', category: 'Empreendimento', value: 1700, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -9 },
                { title: 'Contratação de portais de notícias', category: 'Empreendimento', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -8 },
                { title: 'Contratação de influenciadores', category: 'Empreendimento', value: 1500, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -8 },
                { title: 'Contratação de carro de som', category: 'Empreendimento', value: 800, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -8 },
                { title: 'Contratação de plotagem: comunicação visual loja', category: 'Empreendimento', value: 18540, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Contratação de fachada loja', category: 'Empreendimento', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -4 },
                { title: 'Contratação de empreiteiro para reforma de loja', category: 'Empreendimento', value: 21900, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -7 },
                { title: 'Compra de materiais para reforma de loja', category: 'Empreendimento', value: 8800, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -7, notes: 'Terra Nova - Leati - Palácio das Tintas e Gesso' },
                { title: 'Contratação para instalação de ar condicionado', category: 'Empreendimento', value: 2450, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -7, notes: 'Instalação' },
                { title: 'Contratação de móveis planejados', category: 'Empreendimento', value: 4750, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Contratação de máquina de café', category: 'Empreendimento', value: 180, valueKind: 'MONTHLY', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: 'Mensal' },
                { title: 'Contratação de câmera e alarme monitoramento', category: 'Empreendimento', value: 4609.15, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: 'Instalação e equipamentos' },
                { title: 'Contratação de internet', category: 'Empreendimento', value: 99.9, valueKind: 'MONTHLY', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: 'Mensal - 3 primeiros meses 49,90 (promoção)' },
                { title: 'Contratação de equipe de limpeza pós obra', category: 'Empreendimento', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Contratação de confecção de camisetas', category: 'Empreendimento', value: 2000, assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: '40 camisetas' },
                { title: 'Contratação de impressora', category: 'Empreendimento', value: 200, valueKind: 'MONTHLY', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2, notes: 'Mensal' },
                { title: 'Brindes para corretores', category: 'Empreendimento', assignee: 'ADM' },
                { title: 'Brindes para clientes (demanda mínima)', category: 'Empreendimento', assignee: 'ADM' },
                { title: 'Bexiga para loja', category: 'Empreendimento', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Drive de divulgação para corretores', category: 'Empreendimento', assignee: 'TAKETA', anchor: 'STORE_OPENING', offset: -9 },
                { title: 'Geladeira/frigobar', category: 'Empreendimento', value: 931, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Materiais de escritório', category: 'Empreendimento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Materiais de limpeza', category: 'Empreendimento', assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Ar condicionado', category: 'Empreendimento', value: 5991.43, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Água/bebedouro', category: 'Empreendimento', value: 729, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Mesa e cadeiras', category: 'Empreendimento', value: 3479.61, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Som JBL com mic', category: 'Empreendimento', value: 283.31, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Sino', category: 'Empreendimento', value: 233, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Planta artificial para LED', category: 'Empreendimento', value: 554.16, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Suprimentos para café', category: 'Empreendimento', value: 294.81, assignee: 'BRUNA', anchor: 'STORE_OPENING', offset: -2 },
                // Categoria: Meeting
                { title: 'Locação de espaço para meeting', category: 'Meeting', value: 1200, assignee: 'ADM', anchor: 'MEETING', offset: 0 },
                { title: 'Coffee break para meeting', category: 'Meeting', value: 2310, assignee: 'ADM', anchor: 'MEETING', offset: 0 },
                { title: 'Audiovisual para meeting', category: 'Meeting', value: 1800, assignee: 'ADM', anchor: 'MEETING', offset: 0, notes: 'Som e painel de LED' },
                // Categoria: Inauguração
                { title: 'Decoração arco de bexiga', category: 'Inauguração', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Coffee break para inauguração loja', category: 'Inauguração', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
                { title: 'Pipoca e algodão doce', category: 'Inauguração', assignee: 'ADM', anchor: 'STORE_OPENING', offset: -2 },
            ],
        },
    ],
};

async function seedStatuses() {
    // 1 SELECT + 1 bulk INSERT (em vez de N findOrCreate sequenciais).
    const existing = await db.ChecklistStatus.findAll({ where: { scope: 'GLOBAL' }, attributes: ['label'], raw: true });
    const have = new Set(existing.map((r) => r.label));
    const missing = STATUSES.filter((s) => !have.has(s.label));
    if (!missing.length) return 0;
    await db.ChecklistStatus.bulkCreate(missing.map((s) => ({ ...s, scope: 'GLOBAL', template_id: null, is_active: true })));
    return missing.length;
}

// Marca os flags de autorização (Fase 3) só na PRIMEIRA vez — depois o admin gerencia
// pelo editor de status. Roda mesmo em banco já semeado (fora do fast-path).
async function seedApprovalFlags() {
    try {
        const [reviewCount, gatedCount] = await Promise.all([
            db.ChecklistStatus.count({ where: { scope: 'GLOBAL', approval_role: 'REVIEW' } }),
            db.ChecklistStatus.count({ where: { scope: 'GLOBAL', requires_approval: true } }),
        ]);
        if (reviewCount > 0 || gatedCount > 0) return 0; // já configurado
        await Promise.all([
            db.ChecklistStatus.update({ approval_role: 'REVIEW' }, { where: { scope: 'GLOBAL', label: 'EM APROVAÇÃO' } }),
            db.ChecklistStatus.update({ approval_role: 'REWORK' }, { where: { scope: 'GLOBAL', label: 'EM AJUSTE' } }),
            db.ChecklistStatus.update({ requires_approval: true }, { where: { scope: 'GLOBAL', label: ['CONCLUÍDO', 'SOLIC P/ COMPRAS'] } }),
        ]);
        return 1;
    } catch (err) { console.warn('[seedChecklist.approvalFlags] falhou:', err?.message || err); return 0; }
}

async function seedLaunchTemplate() {
    const existing = await db.ChecklistTemplate.findOne({
        where: { kind: LAUNCH_TEMPLATE.kind, name: LAUNCH_TEMPLATE.name },
        attributes: ['id'],
    });
    if (existing) return { created: false, templateId: existing.id };

    const tpl = await db.ChecklistTemplate.create({
        name: LAUNCH_TEMPLATE.name,
        description: LAUNCH_TEMPLATE.description,
        kind: LAUNCH_TEMPLATE.kind,
        icon: LAUNCH_TEMPLATE.icon,
        color: LAUNCH_TEMPLATE.color,
        is_default: LAUNCH_TEMPLATE.is_default,
        is_active: true,
    });

    // bulkCreate seções e depois itens (2 INSERTs em vez de ~80 sequenciais).
    let sPos = 0;
    const sectionRows = LAUNCH_TEMPLATE.sections.map((sec) => ({ template_id: tpl.id, name: sec.name, color: sec.color || null, position: (sPos += 10) }));
    const createdSections = await db.ChecklistTemplateSection.bulkCreate(sectionRows, { returning: true });
    const sectionIdByName = new Map(createdSections.map((s) => [s.name, s.id]));

    const itemRows = [];
    for (const sec of LAUNCH_TEMPLATE.sections) {
        const sectionId = sectionIdByName.get(sec.name);
        let iPos = 0;
        for (const it of sec.items) {
            iPos += 10;
            itemRows.push({
                template_id: tpl.id,
                section_id: sectionId,
                title: it.title,
                category: it.category || null,
                default_priority: 'MEDIUM',
                default_value: it.value ?? null,
                default_assignee_role: it.assignee || null,
                due_anchor: it.anchor || null,
                due_offset_days: it.offset ?? null,
                notes_template: it.notes
                    ? (it.valueKind === 'MONTHLY' ? `${it.notes} (valor mensal)` : it.notes)
                    : (it.valueKind === 'MONTHLY' ? 'Valor mensal' : null),
                position: iPos,
            });
        }
    }
    await db.ChecklistTemplateItem.bulkCreate(itemRows);
    return { created: true, templateId: tpl.id };
}

// ── Régua de cobrança default (editável depois na tela admin) ─────────────────
const DEFAULT_RULES = [
    { name: '3 dias antes do prazo', offset_days: -3, recipients: { assignee: true, owner: false, user_ids: [], roles: [] }, channels: { inapp: true, email: true, whatsapp: false }, title_template: 'Faltam 3 dias: {{task}}', body_template: 'A entrega "{{task}}" ({{checklist}}) vence em {{due}}.', importance: 5, position: 10 },
    { name: '1 dia antes do prazo', offset_days: -1, recipients: { assignee: true, owner: false, user_ids: [], roles: [] }, channels: { inapp: true, email: true, whatsapp: false }, title_template: 'Amanhã: {{task}}', body_template: 'A entrega "{{task}}" ({{checklist}}) vence amanhã ({{due}}).', importance: 6, position: 20 },
    { name: 'No dia do prazo', offset_days: 0, recipients: { assignee: true, owner: false, user_ids: [], roles: [] }, channels: { inapp: true, email: true, whatsapp: false }, title_template: 'Vence hoje: {{task}}', body_template: 'A entrega "{{task}}" ({{checklist}}) vence hoje ({{due}}).', importance: 7, position: 30 },
    { name: 'Em atraso (a cada 2 dias)', offset_days: 1, repeat_every_days: 2, max_occurrences: 6, recipients: { assignee: true, owner: false, user_ids: [], roles: [] }, channels: { inapp: true, email: true, whatsapp: false }, title_template: 'Atrasada há {{daysLate}} dia(s): {{task}}', body_template: 'A entrega "{{task}}" ({{checklist}}) está {{daysLate}} dia(s) em atraso (venceu {{due}}).', importance: 8, position: 40 },
    { name: 'Escalar ao dono (5 dias de atraso)', offset_days: 5, recipients: { assignee: true, owner: true, user_ids: [], roles: [] }, channels: { inapp: true, email: true, whatsapp: false }, title_template: 'Escalada: {{task}} ({{daysLate}}d em atraso)', body_template: '"{{task}}" ({{checklist}}) segue pendente há {{daysLate}} dias (venceu {{due}}).', importance: 9, position: 50 },
];

async function seedCobranca() {
    if (!db.ChecklistSettings || !db.ChecklistReminderRule) return 0;
    const [settings, existingRules] = await Promise.all([
        db.ChecklistSettings.findOne({ attributes: ['id'] }),
        db.ChecklistReminderRule.findAll({ where: { scope: 'GLOBAL' }, attributes: ['name'], raw: true }),
    ]);
    if (!settings) await db.ChecklistSettings.create({});
    const have = new Set(existingRules.map((r) => r.name));
    const missing = DEFAULT_RULES.filter((r) => !have.has(r.name));
    if (missing.length) {
        await db.ChecklistReminderRule.bulkCreate(missing.map((r) => ({ ...r, scope: 'GLOBAL', anchor: 'DUE_DATE', active: true, apply_states: ['TODO', 'IN_PROGRESS', 'BLOCKED'] })));
    }
    return missing.length;
}

export default async function seedChecklist() {
    try {
        if (!db.ChecklistStatus || !db.ChecklistTemplate) {
            console.warn('[seedChecklist] models do checklist nao registrados; pulando.');
            return;
        }
        // Flags de autorização (Fase 3): idempotente e fora do fast-path (precisa rodar
        // mesmo num banco que já tinha os status semeados antes da Fase 3).
        await seedApprovalFlags();
        // Fast-path: se já está tudo semeado, sai em ~1 ida ao banco (3 counts em paralelo).
        const [statusCount, tplCount, settingsCount] = await Promise.all([
            db.ChecklistStatus.count({ where: { scope: 'GLOBAL' } }),
            db.ChecklistTemplate.count({ where: { kind: LAUNCH_TEMPLATE.kind, name: LAUNCH_TEMPLATE.name } }),
            db.ChecklistSettings ? db.ChecklistSettings.count() : Promise.resolve(1),
        ]);
        if (statusCount >= STATUSES.length && tplCount > 0 && settingsCount > 0) return;

        const statusCreated = await seedStatuses();
        const tpl = await seedLaunchTemplate();
        const rulesCreated = await seedCobranca();
        console.log(`[seedChecklist] status novos: ${statusCreated}; template "Lançamento de Empreendimento": ${tpl.created ? 'criado' : 'já existia'} (id ${tpl.templateId}); regras de cobrança novas: ${rulesCreated}.`);
    } catch (err) {
        console.warn('[seedChecklist] falhou (nao crítico):', err?.message || err);
    }
}
