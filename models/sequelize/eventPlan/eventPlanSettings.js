// models/sequelize/eventPlan/eventPlanSettings.js
//
// Configuração global do módulo (linha única, criada lazy no service).
//
// As ETAPAS de autorização são TOTALMENTE definidas na tela: quantas são, como
// se chamam e quem decide em cada uma. Não existe etapa fixa no código.
//
// Nasce VAZIO de propósito: quem configura decide o fluxo do zero. Sem etapa
// nenhuma, o plano enviado é aprovado na hora (a tela avisa disso).
export const DEFAULT_STAGES = [];

export const DEFAULT_ITEM_CATEGORIES = [
    { key: 'alimentacao', label: 'Alimentação', active: true },
    { key: 'brinde', label: 'Brinde', active: true },
    { key: 'midia', label: 'Mídia', active: true },
    { key: 'mao_de_obra', label: 'Mão de obra', active: true },
    { key: 'estrutura', label: 'Estrutura', active: true },
    { key: 'taxa', label: 'Taxa / participação', active: true },
    { key: 'impresso', label: 'Material impresso', active: true },
    { key: 'outro', label: 'Outro', active: true },
];

export default (sequelize, DataTypes) => {
    const EventPlanSettings = sequelize.define('EventPlanSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // [{ key, name, order, profile_ids }] — a fila de autorização inteira,
        // na ordem. `key` é gerado na criação e nunca muda (as decisões gravadas
        // apontam para ele); `name` pode ser renomeado à vontade.
        stages: { type: DataTypes.JSONB, allowNull: false, defaultValue: DEFAULT_STAGES },

        // ── Ciclo mensal ──────────────────────────────────────────────────────
        // A JANELA do plano é a última semana do mês ANTERIOR ao de referência:
        // abre N dias antes do fim do mês (7 = última semana) e fecha no último
        // dia daquele mês. O plano de setembro abre ~25/08 e fecha em 31/08.
        open_days_before_month_end: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
        // Fechou a janela e o gestor não enviou? O plano vai SOZINHO para a fila
        // do Comercial. Assim o mês nunca começa sem proposta na mesa — e quem
        // quiser adiantar pode enviar a qualquer momento durante a janela.
        auto_submit_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // LEGADO: era o prazo "dia N do mês de referência", da regra antiga
        // (janela indo até a primeira semana do mês). Mantido só para não perder
        // a coluna de instalações existentes — o motor não lê mais este campo.
        deadline_day: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
        // Evento nos N primeiros dias do mês entra na fila prioritária do
        // aprovador: a aprovação acontece depois do envio e pode se estender
        // pelos primeiros dias, então ele corre risco de acontecer antes de ser
        // decidido. O gestor é avisado disso ao cadastrar.
        priority_window_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },

        item_categories: { type: DataTypes.JSONB, allowNull: false, defaultValue: DEFAULT_ITEM_CATEGORIES },

        // ── Cobrança (F3) ─────────────────────────────────────────────────────
        chase_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // Dias ANTES do prazo em que o gestor é lembrado (e no dia 0).
        chase_offsets: { type: DataTypes.JSONB, allowNull: false, defaultValue: [5, 2, 0] },
        run_hour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 8 },
        timezone: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'America/Sao_Paulo' },
        // Se false, a cobrança ignora as preferências de canal do usuário.
        respect_user_prefs: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'event_plan_settings',
        timestamps: true,
        underscored: true,
    });

    return EventPlanSettings;
};
