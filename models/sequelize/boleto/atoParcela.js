// models/sequelize/boleto/atoParcela.js
//
// Uma parcela do plano (ver atoPlano.js). Derivada de `condicoes.series[]` do
// CV: cada linha de serie mensal vira `quantidade` parcelas a partir do
// vencimento dela. `chave` (idserie:linha:indice) e o que casa a parcela com o
// CV nas sincronizacoes seguintes - lib/atoParcelas.js.
//
// Ciclo: prevista -> emitida -> paga
//                          \-> vencida -> (reemitida: emitida de novo) -> paga
//        prevista -> transferida (Sienge faturou) | cancelada (reserva morreu)
//        emitida/prevista -> erro (emissao falhou; volta a tentar)
export default (sequelize, DataTypes) => {
    const AtoParcela = sequelize.define('AtoParcela', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        plano_id: { type: DataTypes.INTEGER, allowNull: false },
        idreserva: { type: DataTypes.INTEGER, allowNull: false },

        chave: { type: DataTypes.STRING(40), allowNull: false },
        idserie: { type: DataTypes.INTEGER, allowNull: true },
        linha: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        indice_na_serie: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        serie_nome: { type: DataTypes.STRING, allowNull: true },
        sigla: { type: DataTypes.STRING(10), allowNull: true },

        numero: { type: DataTypes.INTEGER, allowNull: false },
        total: { type: DataTypes.INTEGER, allowNull: false },

        // Condicao ORIGINAL do CV. Nunca muda depois de emitida.
        vencimento: { type: DataTypes.DATEONLY, allowNull: false },
        valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },

        status: {
            type: DataTypes.STRING(20), allowNull: false, defaultValue: 'prevista',
            comment: 'prevista | emitida | vencida | paga | transferida | cancelada | erro',
        },

        // Boleto ATUAL da parcela (boleto_history.id) e o que ele cobra.
        boleto_history_id: { type: DataTypes.INTEGER, allowNull: true },
        vencimento_cobrado: { type: DataTypes.DATEONLY, allowNull: true },
        valor_cobrado: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        encargos_valor: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
        encargos_detalhe: {
            type: DataTypes.TEXT, allowNull: true,
            comment: 'JSON { diasAtraso, multa, juros }',
            get() {
                const raw = this.getDataValue('encargos_detalhe');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(v) { this.setDataValue('encargos_detalhe', v == null ? null : JSON.stringify(v)); },
        },

        emissoes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: 'Quantas vias ja sairam (1a + reemissoes).' },
        ultima_emissao_em: { type: DataTypes.DATE, allowNull: true },
        pago_em: { type: DataTypes.DATE, allowNull: true },
        erro_mensagem: { type: DataTypes.TEXT, allowNull: true },
        tentativas_erro: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        // Comunicacao ao cliente (um envio de cada por boleto vivo).
        lembrete_enviado_em: { type: DataTypes.DATE, allowNull: true },
        aviso_atraso_enviado_em: { type: DataTypes.DATE, allowNull: true },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'ato_parcelas',
        underscored: true,
        timestamps: true,
    });

    AtoParcela.associate = (models) => {
        AtoParcela.belongsTo(models.AtoPlano, { foreignKey: 'plano_id', as: 'plano' });
    };
    return AtoParcela;
};
