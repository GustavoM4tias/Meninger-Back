// src/models/sequelize/enterpriseCity.js
export default (sequelize, DataTypes) => {
    const EnterpriseCity = sequelize.define('EnterpriseCity', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },

        // Identificadores externos
        source: { type: DataTypes.ENUM('crm', 'erp'), allowNull: false }, // de onde veio o registro base
        crm_id: { type: DataTypes.INTEGER },         // idempreendimento (CRM)
        erp_id: { type: DataTypes.STRING(50) },     // id interno do ERP (p.ex. "50001")

        // Metadados do empreendimento
        enterprise_name: { type: DataTypes.STRING(255) },
        default_city: { type: DataTypes.STRING(120) },   // cidade retornada pela API (CRM/ERP)
        city_override: { type: DataTypes.STRING(120) },  // cidade ajustada manualmente no painel (opcional)

        // Extras
        raw_payload: { type: DataTypes.JSONB, defaultValue: {} },

        first_seen_at: { type: DataTypes.DATE },
        last_seen_at: { type: DataTypes.DATE }
    }, {
        tableName: 'enterprise_cities',
        underscored: true,
        timestamps: true,
        indexes: [
            { unique: true, fields: ['source', 'crm_id'], where: { source: 'crm' } },
            { unique: true, fields: ['source', 'erp_id'], where: { source: 'erp' } },
            { fields: ['default_city'] },
            { fields: ['city_override'] }
        ]
    });

    // Getter virtual para sempre usar a cidade efetiva
    Object.defineProperty(EnterpriseCity.prototype, 'effective_city', {
        get() {
            return this.city_override || this.default_city || null;
        }
    });

    return EnterpriseCity;
};
