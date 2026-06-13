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
                let parsed;
                try { parsed = JSON.parse(raw || '[21]'); } catch { return [21]; }
                // Tolera dados legados aninhados como [[[21,9]]] vindos do sync alter
                if (Array.isArray(parsed)) {
                    const flat = parsed.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                    return Array.from(new Set(flat));
                }
                const n = Number(parsed);
                return Number.isFinite(n) && n > 0 ? [n] : [];
            },
            set(val) {
                const raw = Array.isArray(val) ? val : [val];
                const flat = raw.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                const unique = Array.from(new Set(flat));
                this.setDataValue('idserie_ra', JSON.stringify(unique));
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
        situacao_pago_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 28,
            comment: 'ID situação CV quando boleto é detectado como LIQUIDADO no Ecobrança',
        },
        situacao_baixado_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 29,
            comment: 'ID situação CV quando boleto é baixado por devolução (vencido sem pagamento)',
        },
        tolerancia_dias_uteis: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 1,
            comment: 'Dias úteis após vencimento (já considerando fim de semana/feriado) para baixar o boleto. 1 = boleto pago compensa em D+1 útil.',
        },

        delay_situacao_sucesso_min: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 2,
            comment: 'Safety threshold (minutos) até o próximo lote Sienge (5/5min). Se faltam menos que isto, pula pro próximo ciclo. Default 2 → delay efetivo varia entre 3 e 7 min, alinhado a múltiplo de 5 + 1 buffer.',
        },

        max_dias_vencimento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 10,
            comment: 'Dias corridos máximos entre hoje e a data de vencimento do boleto. Vencimento acima → erro "excede limite". Override por empreendimento em boleto_comission_rules.max_dias_vencimento.',
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
