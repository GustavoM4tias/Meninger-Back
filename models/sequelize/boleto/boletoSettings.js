// models/sequelize/boleto/boletoSettings.js
// Configurações globais do módulo Boleto Caixa — tabela singleton (sempre 1 linha, id=1)
export default (sequelize, DataTypes) => {
    const BoletoSettings = sequelize.define('BoletoSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Credenciais ECO Cobrança ────────────────────────────────────────────
        eco_usuario: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'CPF/usuário de acesso ao ECO Cobrança Caixa',
        },
        eco_senha: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Senha de acesso ao ECO Cobrança Caixa (6 dígitos)',
        },

        // ── Configuração de série ──────────────────────────────────────────────
        idserie_ra: {
            type: DataTypes.INTEGER,
            defaultValue: 21,
            comment: 'ID da série Recurso Próprio a Vista (idserie no CV)',
        },

        // ── Configuração de anexo CV ───────────────────────────────────────────
        cv_idtipo_documento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'idtipo para anexar boleto na reserva do CV (obtido na API de tipos de arquivo)',
        },

        // ── Situações de retorno no CV ─────────────────────────────────────────
        situacao_sucesso_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'ID situação CV para alterar em caso de emissão bem-sucedida',
        },
        situacao_erro_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'ID situação CV para alterar em caso de erro (usa cancelar-reserva)',
        },

        // ── Controle ───────────────────────────────────────────────────────────
        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Habilita/desabilita o processamento automático de boletos',
        },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'boleto_settings',
        underscored: true,
        timestamps: true,
    });

    BoletoSettings.associate = () => {};
    return BoletoSettings;
};
