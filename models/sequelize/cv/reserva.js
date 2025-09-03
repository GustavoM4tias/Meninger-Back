// src/models/sequelize/cv/Reserva.js
export default (sequelize, DataTypes) => {
    const Reserva = sequelize.define('Reserva', {
        // PK (vem do CVCRM)
        idreserva: { type: DataTypes.INTEGER, primaryKey: true },

        // Espelho do status ATUAL (copiado do Repasse relacionado)
        status_reserva: { type: DataTypes.STRING(100) },
        status_repasse: { type: DataTypes.STRING(100) },
        idsituacao_repasse: { type: DataTypes.INTEGER },
        data_status_repasse: { type: DataTypes.DATE },

        // Denormalizações úteis p/ filtros/relatórios
        documento: { type: DataTypes.STRING(20) },           // titular.documento
        empreendimento: { type: DataTypes.STRING(255) },     // unidade.empreendimento
        etapa: { type: DataTypes.STRING(100) },              // unidade.etapa
        bloco: { type: DataTypes.STRING(100) },              // unidade.bloco
        unidade: { type: DataTypes.STRING(255) },            // unidade.unidade (rótulo)

        // Blocos da reserva (JSONB)
        situacao: { type: DataTypes.JSONB },                 // obj
        imobiliaria: { type: DataTypes.JSONB },              // obj
        unidade_json: { type: DataTypes.JSONB },             // obj (detalhes completos)
        titular: { type: DataTypes.JSONB },                  // obj
        corretor: { type: DataTypes.JSONB },                 // obj
        condicoes: { type: DataTypes.JSONB },                // obj (inclui series)
        leads_associados: { type: DataTypes.JSONB },         // array

        // Campos “flat” do corpo de reserva (opcionais)
        idproposta_cv: { type: DataTypes.INTEGER },
        idproposta_int: { type: DataTypes.STRING(50) },
        vendida: { type: DataTypes.STRING(1) },
        observacoes: { type: DataTypes.TEXT },
        data_reserva: { type: DataTypes.DATE },              // campo "data"
        data_contrato: { type: DataTypes.DATE },
        data_venda: { type: DataTypes.DATE },
        idtipovenda: { type: DataTypes.INTEGER },
        tipovenda: { type: DataTypes.STRING(100) },
        idprecadastro: { type: DataTypes.INTEGER },
        ultima_mensagem: { type: DataTypes.TEXT },
        idtime: { type: DataTypes.INTEGER },

        contratos: { type: DataTypes.JSONB },                // array
        empresa_correspondente: { type: DataTypes.JSONB },   // obj

        // Extras vindos de outras rotas
        documentos: { type: DataTypes.JSONB, defaultValue: {} },     // /documentos
        erp_sienge: { type: DataTypes.JSONB, defaultValue: {} },      // /erp/sienge
        campanhas: { type: DataTypes.JSONB, defaultValue: [] },       // /campanhas
        mensagens: { type: DataTypes.JSONB, defaultValue: [] },       // /mensagens (array plano)

        // Histórico do status (status[0] = atual)
        // item: { status_reserva, status_repasse, idsituacao_repasse, data_status_repasse, captured_at }
        status: { type: DataTypes.JSONB, defaultValue: [] },

        // Metadados
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
