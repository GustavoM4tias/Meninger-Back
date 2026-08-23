// models/sequelize/userede/useredeSettings.js
//
// Configurações do módulo Link de Cartão (Userede) - tabela singleton (id=1).
//
// Tudo que a operação pode querer mudar mora aqui e tem campo na tela; as
// constantes do código são só fallback. Ver a seção TUDO CONFIGURÁVEL do
// CLAUDE.md.
export default (sequelize, DataTypes) => {
    const UseredeSettings = sequelize.define('UseredeSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Credenciais do portal ─────────────────────────────────────────────
        // CIFRADAS com utils/encryption.js (AES-256-GCM). Nunca trafegam em
        // texto puro na API: o controller devolve apenas `usuario_set`/`senha_set`.
        usuario: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'E-mail de acesso ao meu.userede.com.br (cifrado).',
        },
        senha: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Senha de acesso ao meu.userede.com.br (cifrada).',
        },

        // ── Sessão persistente ────────────────────────────────────────────────
        // O portal tem reCAPTCHA em todas as telas, então reaproveitar a sessão
        // é o caminho normal e logar é a exceção. Ver UseredeSessionService.
        session_state: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'storageState do Playwright (cookies + localStorage), cifrado.',
        },
        session_valida_em: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Última vez que a sessão foi confirmada viva.',
        },
        session_precisa_humano: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: 'True quando o portal pediu 2º fator/captcha - alguém precisa relogar.',
        },
        session_ultimo_erro: {
            type: DataTypes.STRING(500),
            allowNull: true,
            comment: 'Motivo da última falha de sessão, exibido na tela.',
        },

        // ── Estabelecimento (PV) ──────────────────────────────────────────────
        pv_principal: {
            type: DataTypes.STRING(20),
            allowNull: true,
            defaultValue: '18309232',
            comment: 'Número do PV usado na emissão (CONST MENIN - Matriz).',
        },

        // ── Gatilho ───────────────────────────────────────────────────────────
        idserie_credito: {
            type: DataTypes.TEXT,
            defaultValue: '[]',
            comment: 'IDs das séries "Recurso Próprio à Vista (Crédito)" (JSON array).',
            get() {
                const raw = this.getDataValue('idserie_credito');
                try {
                    const parsed = JSON.parse(raw || '[]');
                    const flat = (Array.isArray(parsed) ? parsed : [parsed])
                        .flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                    return Array.from(new Set(flat));
                } catch { return []; }
            },
            set(val) {
                const flat = (Array.isArray(val) ? val : [val])
                    .flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                this.setDataValue('idserie_credito', JSON.stringify(Array.from(new Set(flat))));
            },
        },

        // ── Regras de emissão ─────────────────────────────────────────────────
        // O portal aceita no máximo R$ 30.000 por link; nosso teto é mais
        // restritivo e barra ANTES de criar, como o valor_maximo do boleto.
        valor_maximo: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
            defaultValue: 15000,
            comment: 'Valor máximo (R$) por link. Acima disto a emissão erra. Teto da Rede: 30.000.',
        },
        // ATENÇÃO: o portal define um TETO de parcelas, não um valor fixo - quem
        // escolhe em quantas vezes pagar é o cliente, até este limite. O que ele
        // efetivamente escolheu é lido depois e gravado no histórico.
        max_parcelas: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 12,
            comment: 'Limite de parcelas oferecido no link (1 a 12; a Rede não aceita mais que 12).',
        },
        // O select "Prazo de vencimento" do portal só vai até 15 dias. A regra
        // de negócio (hoje 5 dias, igual ao boleto) fica em max_dias_vencimento;
        // os 15 são o limite físico da Rede e viram trava dura na validação.
        max_dias_vencimento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 5,
            comment: 'Dias corridos máximos até o vencimento. Limite físico do portal: 15.',
        },

        // ── Retorno no CV ─────────────────────────────────────────────────────
        cv_idtipo_documento: { type: DataTypes.INTEGER, allowNull: true },
        situacao_sucesso_id: { type: DataTypes.INTEGER, allowNull: true },
        situacao_erro_id: { type: DataTypes.INTEGER, allowNull: true },
        situacao_pago_id: { type: DataTypes.INTEGER, allowNull: true },

        // ── Controle ──────────────────────────────────────────────────────────
        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Habilita o processamento automático de links de cartão.',
        },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'userede_settings',
        underscored: true,
        timestamps: true,
    });

    UseredeSettings.associate = () => {};
    return UseredeSettings;
};
