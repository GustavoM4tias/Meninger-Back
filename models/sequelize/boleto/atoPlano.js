// models/sequelize/boleto/atoPlano.js
//
// Plano de parcelas de uma reserva: o que o Office cobra entre o ato pago e o
// faturamento do contrato no Sienge. UMA linha por reserva.
//
// Nasce quando o ato e pago (boleto ou cartao) e morre de um de tres jeitos:
//   sienge_faturado    o contrato ganhou titulo no Sienge -> o ERP cobra daqui
//                      em diante; as parcelas previstas viram `transferida`.
//   reserva_cancelada  a reserva morreu no CV; boletos em aberto sao baixados.
//   manual             alguem encerrou pela tela e disse por que.
//
// As parcelas ficam em `ato_parcelas`; os boletos continuam em `boleto_history`
// (com `parcela_id` preenchido) para reaproveitar verificacao, baixa, PDF e
// timeline sem duplicar nada.
export default (sequelize, DataTypes) => {
    const AtoPlano = sequelize.define('AtoPlano', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        idreserva: { type: DataTypes.INTEGER, allowNull: false, unique: true },

        // Denormalizacoes para a tela nao precisar do CV a cada linha.
        idpessoa_cv: { type: DataTypes.INTEGER, allowNull: true },
        titular_nome: { type: DataTypes.STRING, allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        idempreendimento_cv: { type: DataTypes.INTEGER, allowNull: true },
        unidade: { type: DataTypes.STRING, allowNull: true },
        cnpj_empresa: { type: DataTypes.STRING, allowNull: true },

        status: {
            type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ativo',
            comment: 'ativo | pausado | encerrado | cancelado',
        },
        encerrado_motivo: {
            type: DataTypes.STRING(40), allowNull: true,
            comment: 'sienge_faturado | reserva_cancelada | manual | sem_series',
        },
        encerrado_detalhe: { type: DataTypes.TEXT, allowNull: true },
        encerrado_em: { type: DataTypes.DATE, allowNull: true },
        encerrado_por: { type: DataTypes.INTEGER, allowNull: true },
        pausado_por: { type: DataTypes.INTEGER, allowNull: true },
        pausado_em: { type: DataTypes.DATE, allowNull: true },

        // Origem do plano: 'ato_pago' (automatico) ou 'manual' (tela).
        origem: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'ato_pago' },
        ato_pago_em: { type: DataTypes.DATE, allowNull: true },

        // Contrato do Sienge (tabela local `contracts`, external_id = idreserva).
        sienge_contract_id: { type: DataTypes.BIGINT, allowNull: true },
        sienge_receivable_bill_id: { type: DataTypes.BIGINT, allowNull: true },
        sienge_verificado_em: { type: DataTypes.DATE, allowNull: true },

        // Ultima leitura das condicoes no CV (para a tela mostrar divergencias).
        cv_sincronizado_em: { type: DataTypes.DATE, allowNull: true },
        divergencias: {
            type: DataTypes.TEXT, allowNull: true,
            comment: 'JSON: parcelas ja emitidas cujo valor/vencimento mudou no CV depois.',
            get() {
                const raw = this.getDataValue('divergencias');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(v) { this.setDataValue('divergencias', v == null ? null : JSON.stringify(v)); },
        },

        observacao: { type: DataTypes.TEXT, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'ato_planos',
        underscored: true,
        timestamps: true,
    });

    AtoPlano.associate = (models) => {
        AtoPlano.hasMany(models.AtoParcela, { foreignKey: 'plano_id', as: 'parcelas' });
    };
    return AtoPlano;
};
