export default (sequelize, DataTypes) => {
    // Regras de público-alvo de um comunicado (a quem ele é atribuído).
    // Escopo: ROLE | POSITION | DEPARTMENT | CITY | USER. Na publicação, estes
    // escopos são resolvidos em destinatários concretos (comunicado_receipts).
    const ComunicadoAssignment = sequelize.define('ComunicadoAssignment', {
        comunicadoId: { type: DataTypes.INTEGER, allowNull: false },

        // ROLE | POSITION | DEPARTMENT | CITY | USER
        scopeType: { type: DataTypes.STRING, allowNull: false },
        scopeValue: { type: DataTypes.STRING, allowNull: false },
    }, {
        tableName: 'comunicado_assignments',
        timestamps: true,
        underscored: true,
        indexes: [
            { fields: ['comunicado_id'] },
            { unique: true, fields: ['comunicado_id', 'scope_type', 'scope_value'] },
        ],
    });

    return ComunicadoAssignment;
};
