// models/sequelize/boleto/boletoSettings.js
// Configurações globais do módulo Boleto Caixa — tabela singleton (sempre 1 linha, id=1)
export default (sequelize, DataTypes) => {
    const BoletoSettings = sequelize.define('BoletoSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Credenciais Ecobrança ────────────────────────────────────────────
        eco_usuario: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'CPF/usuário de acesso ao Ecobrança Caixa',
        },
        eco_senha: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Senha de acesso ao Ecobrança Caixa (6 dígitos)',
        },

        // ── Configuração de séries ─────────────────────────────────────────────
        // Armazena JSON array de IDs: [21] ou [21, 22, 35]
        idserie_ra: {
            type: DataTypes.TEXT,
            defaultValue: '[21]',
            comment: 'IDs das séries de entrada aceitas (JSON array). Ex: [21] ou [21,22]',
            get() {
                const raw = this.getDataValue('idserie_ra');
                try { return JSON.parse(raw || '[21]'); } catch { return [21]; }
            },
            set(val) {
                const arr = Array.isArray(val) ? val : [val];
                this.setDataValue('idserie_ra', JSON.stringify(arr.map(Number).filter(Boolean)));
            },
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
