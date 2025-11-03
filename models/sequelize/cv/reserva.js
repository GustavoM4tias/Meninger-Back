// src/models/sequelize/cv/Reserva.js
export default (sequelize, DataTypes) => {
    const Reserva = sequelize.define('Reserva', {
        idreserva: { type: DataTypes.INTEGER, primaryKey: true },

        // Campos que MV pode usar
        status_reserva: { type: DataTypes.STRING },   // sem length
        status_repasse: { type: DataTypes.STRING },   // sem length
        idsituacao_repasse: { type: DataTypes.INTEGER },
        data_status_repasse: { type: DataTypes.DATE },

        // Denormalizações (use STRING sem length p/ evitar ALTER desnecessário)
        documento: { type: DataTypes.STRING },
        empreendimento: { type: DataTypes.STRING },
        etapa: { type: DataTypes.STRING },
        bloco: { type: DataTypes.STRING },
        unidade: { type: DataTypes.STRING },

        // JSONB
        situacao: { type: DataTypes.JSONB }, // <– CRÍTICO: JSONB
        imobiliaria: { type: DataTypes.JSONB },
        unidade_json: { type: DataTypes.JSONB },
        titular: { type: DataTypes.JSONB },
        corretor: { type: DataTypes.JSONB },
        condicoes: { type: DataTypes.JSONB },
        leads_associados: { type: DataTypes.JSONB },

        // Demais campos
        idproposta_cv: { type: DataTypes.INTEGER },
        idproposta_int: { type: DataTypes.STRING },
        vendida: { type: DataTypes.STRING(1) },
        observacoes: { type: DataTypes.TEXT },
        data_reserva: { type: DataTypes.DATE },
        data_contrato: { type: DataTypes.DATE },
        data_venda: { type: DataTypes.DATE },
        idtipovenda: { type: DataTypes.INTEGER },
        tipovenda: { type: DataTypes.STRING },
        idprecadastro: { type: DataTypes.INTEGER },
        ultima_mensagem: { type: DataTypes.TEXT },
        idtime: { type: DataTypes.INTEGER },
        contratos: { type: DataTypes.JSONB },
        empresa_correspondente: { type: DataTypes.JSONB },

        documentos: { type: DataTypes.JSONB, defaultValue: {} },
        erp_sienge: { type: DataTypes.JSONB, defaultValue: {} },
        campanhas: { type: DataTypes.JSONB, defaultValue: [] },
        mensagens: { type: DataTypes.JSONB, defaultValue: [] },

        status: { type: DataTypes.JSONB, defaultValue: [] },

        first_seen_at: { type: DataTypes.DATE },
        last_seen_at: { type: DataTypes.DATE },
    }, {
        tableName: 'reservas',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['documento'] },
            { fields: ['empreendimento'] },
            { fields: ['idsituacao_repasse'] },
            { fields: ['data_status_repasse'] },
        ]
    });

    return Reserva;
};
