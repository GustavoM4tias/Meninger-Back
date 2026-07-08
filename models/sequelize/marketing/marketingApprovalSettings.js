export const DEFAULT_APPROVAL_TYPES = [
    { key: 'verba_meta_ads', label: 'Verba Meta/Ads', active: true },
    { key: 'evento', label: 'Evento', active: true },
    { key: 'grafica', label: 'Gráfica', active: true },
    { key: 'filmagem', label: 'Filmagem', active: true },
    { key: 'radio', label: 'Rádio', active: true },
    { key: 'reportagem', label: 'Reportagem', active: true },
    { key: 'carro_de_som', label: 'Carro de Som', active: true },
    { key: 'outdoor', label: 'Outdoor', active: true },
    { key: 'midia_online', label: 'Mídia Online', active: true },
    { key: 'midia_offline', label: 'Mídia Offline', active: true },
    { key: 'servico_manutencao', label: 'Serviço/Manutenção', active: true },
    { key: 'contratacao', label: 'Contratação', active: true },
    { key: 'outro', label: 'Outro', active: true },
];

export default (sequelize, DataTypes) => {
    // Configuração global do módulo (linha única, criada lazy no service).
    // Tipos configuráveis em JSONB — o ticket grava snapshot type_key+type_label.
    const MarketingApprovalSettings = sequelize.define('MarketingApprovalSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        // [{ key, label, active }] — desativar preserva o histórico dos tickets antigos.
        types: { type: DataTypes.JSONB, allowNull: false, defaultValue: DEFAULT_APPROVAL_TYPES },
        // Dias com ticket pendente até re-notificar os aprovadores (cobrança).
        reminder_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'marketing_approval_settings',
        timestamps: true,
        underscored: true,
    });

    return MarketingApprovalSettings;
};
