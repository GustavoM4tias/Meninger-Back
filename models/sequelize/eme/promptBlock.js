// models/sequelize/eme/promptBlock.js
//
// Bloco editável do system prompt do Eme. Cada registro é uma "peça" do cérebro
// (identidade, política, regra de módulo, comportamento, voz...). O runtime monta
// o system prompt concatenando os blocos habilitados na ordem definida.
//
// PRINCÍPIO: estes blocos são SEMEADOS com o conteúdo atual exato do
// systemPrompt.js. Enquanto a tabela estiver vazia, o runtime cai no fallback
// hardcoded — então o dia 1 é byte a byte idêntico (zero regressão).

export default (sequelize, DataTypes) => {
  const EmePromptBlock = sequelize.define('EmePromptBlock', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Slug estável — usado pelo seed para upsert idempotente e por referências.
    key: { type: DataTypes.STRING(120), allowNull: false, unique: true },

    // Rótulo legível exibido no painel admin.
    title: { type: DataTypes.STRING(200), allowNull: false },

    // identity | policy | access | module_rule | behavior | voice | custom
    category: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'custom' },

    // Módulo ao qual a regra pertence (leads, eventos, comercial, precadastros,
    // reservas, alertas...). null = bloco global.
    module: { type: DataTypes.STRING(60), allowNull: true },

    // OFFICE | ACADEMY | BOTH — em qual contexto do Eme o bloco entra.
    context: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OFFICE' },

    // Texto do bloco. Pode conter placeholders ({{user.city}}, {{now}}, etc.)
    // resolvidos pelo montador em runtime.
    content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

    // Ordem de concatenação dentro do prompt (menor = mais no topo).
    orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // true = o bloco embrulha uma seção COMPUTADA em código (lista de
    // empreendimentos, contexto do usuário, bridge). O admin edita o texto ao
    // redor, mas a parte dinâmica continua sendo injetada pelo servidor.
    isDynamic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Permissão necessária para o bloco entrar (raro; normalmente null).
    requiredPermission: { type: DataTypes.STRING(120), allowNull: true },

    // true = bloco-núcleo: admin pode editar/desabilitar, mas não deletar.
    locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Quem editou por último (username/email) — rastreio leve.
    updatedBy: { type: DataTypes.STRING(120), allowNull: true },
  }, {
    tableName: 'eme_prompt_blocks',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['key'] },
      { fields: ['context'] },
      { fields: ['category'] },
      { fields: ['module'] },
      { fields: ['enabled'] },
      { fields: ['order_index'] },
    ],
  });

  return EmePromptBlock;
};
