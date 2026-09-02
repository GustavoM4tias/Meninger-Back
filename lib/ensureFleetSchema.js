// lib/ensureFleetSchema.js
//
// Frota: o veículo corporativo, a agenda dele e o diário de bordo.
//
// POR QUE A RESERVA E A RETIRADA SÃO A MESMA LINHA
//
// A operação vivia de dois formulários do Forms (RETIRADA e DEVOLUÇÃO) e de um
// grupo do Teams. Dois formulários geram dois registros que ninguém consegue
// casar depois: não dá para saber quantos km aquela viagem rodou sem adivinhar
// qual devolução pertence a qual retirada. Aqui a reserva é a linha, e retirar
// e devolver são dois momentos que preenchem colunas dela.
//
// POR QUE BLOQUEIO NÃO É RESERVA
//
// "Veículo está em manutenção hoje" não tem condutor, não tem km e não pode
// entrar em relatório de uso. Fica em vehicle_blocks e só ocupa a agenda.
//
// Idempotente - roda em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [

    `CREATE TABLE IF NOT EXISTS vehicles (
        id SERIAL PRIMARY KEY,
        placa VARCHAR(10) NOT NULL UNIQUE,
        modelo VARCHAR(120) NOT NULL,
        apelido VARCHAR(60),
        cor VARCHAR(40),
        ano INTEGER,

        -- proprio | reserva (o que a locadora empresta durante a manutenção)
        tipo VARCHAR(20) NOT NULL DEFAULT 'proprio',

        km_atual INTEGER,
        km_atualizado_em TIMESTAMP WITH TIME ZONE,

        observacao TEXT,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS vehicle_reservations (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_by_user_id INTEGER,
        departamento VARCHAR(60),

        inicio TIMESTAMP WITH TIME ZONE NOT NULL,
        fim TIMESTAMP WITH TIME ZONE NOT NULL,
        periodo VARCHAR(20) NOT NULL DEFAULT 'dia',

        destino VARCHAR(255),
        solicitado_por VARCHAR(120),
        observacao TEXT,

        -- reservada | em_uso | devolvida | cancelada | expirada
        status VARCHAR(20) NOT NULL DEFAULT 'reservada',

        retirado_em TIMESTAMP WITH TIME ZONE,
        km_saida INTEGER,
        combustivel_saida VARCHAR(10),
        avarias_saida TEXT,
        obs_saida TEXT,

        devolvido_em TIMESTAMP WITH TIME ZONE,
        km_chegada INTEGER,
        combustivel_chegada VARCHAR(10),
        houve_abastecimento BOOLEAN,
        abastecimento_desc TEXT,
        houve_avaria BOOLEAN,
        avaria_desc TEXT,
        obs_chegada TEXT,

        cancelado_em TIMESTAMP WITH TIME ZONE,
        cancelado_por_user_id INTEGER,
        motivo_cancelamento TEXT,

        lembrete_enviado_em TIMESTAMP WITH TIME ZONE,
        atraso_avisado_em TIMESTAMP WITH TIME ZONE,

        calendar_event_id TEXT,
        calendar_organizer VARCHAR(160),
        calendar_error TEXT,

        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    // Colunas que entraram DEPOIS da tabela existir em algum ambiente. O
    // `CREATE TABLE IF NOT EXISTS` acima não as adicionaria (a tabela já
    // existe e ele vira no-op), e só o `sync({ alter })` as criaria - o que
    // deixaria o módulo dependendo de a fase de schema não ter sido pulada.
    // Foi exatamente o que aconteceu aqui: o boot criou as tabelas antes destas
    // duas colunas existirem.
    // "Centro de custo" era o nome do formulário antigo; o negócio chama isso
    // de DEPARTAMENTO. Renomear de verdade (em vez de só trocar o rótulo da
    // tela) evita o código falar uma língua e a operação falar outra.
    // Postgres não tem RENAME COLUMN IF EXISTS, daí o bloco condicional.
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'vehicle_reservations' AND column_name = 'centro_custo')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name = 'vehicle_reservations' AND column_name = 'departamento')
       THEN ALTER TABLE vehicle_reservations RENAME COLUMN centro_custo TO departamento;
       END IF;
     END $$`,
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'fleet_settings' AND column_name = 'centros_custo')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name = 'fleet_settings' AND column_name = 'departamentos')
       THEN ALTER TABLE fleet_settings RENAME COLUMN centros_custo TO departamentos;
       END IF;
     END $$`,
    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS departamento VARCHAR(60)`,

    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS fotos_saida JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS fotos_chegada JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE fleet_settings ADD COLUMN IF NOT EXISTS exigir_face BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE fleet_settings ADD COLUMN IF NOT EXISTS min_fotos_saida INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE fleet_settings ADD COLUMN IF NOT EXISTS min_fotos_chegada INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE fleet_settings ADD COLUMN IF NOT EXISTS km_max_por_dia INTEGER NOT NULL DEFAULT 1000`,

    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS lembrete_enviado_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS atraso_avisado_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE vehicle_reservations ADD COLUMN IF NOT EXISTS calendar_error TEXT`,

    `CREATE INDEX IF NOT EXISTS vehicle_reservations_vehicle ON vehicle_reservations (vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS vehicle_reservations_user ON vehicle_reservations (user_id)`,
    `CREATE INDEX IF NOT EXISTS vehicle_reservations_status ON vehicle_reservations (status)`,
    // A consulta que mais roda é "o que ocupa este carro nesta janela": status
    // + intervalo. Sem este índice ela varre a tabela a cada tecla da agenda.
    `CREATE INDEX IF NOT EXISTS vehicle_reservations_janela ON vehicle_reservations (vehicle_id, status, inicio, fim)`,

    `CREATE TABLE IF NOT EXISTS vehicle_blocks (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL,
        inicio TIMESTAMP WITH TIME ZONE NOT NULL,
        fim TIMESTAMP WITH TIME ZONE NOT NULL,
        tipo VARCHAR(20) NOT NULL DEFAULT 'manutencao',
        motivo VARCHAR(255),
        observacao TEXT,
        created_by_user_id INTEGER,
        calendar_event_id TEXT,
        calendar_organizer VARCHAR(160),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS vehicle_blocks_janela ON vehicle_blocks (vehicle_id, inicio, fim)`,

    `CREATE TABLE IF NOT EXISTS vehicle_logs (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL,
        reservation_id INTEGER,
        tipo VARCHAR(20) NOT NULL,
        descricao TEXT,
        valor NUMERIC(12,2),
        litros NUMERIC(8,2),
        km INTEGER,
        ocorrido_em TIMESTAMP WITH TIME ZONE,
        anexo_url TEXT,
        created_by_user_id INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS vehicle_logs_vehicle ON vehicle_logs (vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS vehicle_logs_reservation ON vehicle_logs (reservation_id)`,

    `CREATE TABLE IF NOT EXISTS fleet_settings (
        id SERIAL PRIMARY KEY,
        horas_expirar_sem_retirada INTEGER NOT NULL DEFAULT 4,
        max_dias_reserva INTEGER NOT NULL DEFAULT 15,
        antecedencia_max_dias INTEGER NOT NULL DEFAULT 90,
        lembrete_retirada_horas INTEGER NOT NULL DEFAULT 24,

        exigir_km BOOLEAN NOT NULL DEFAULT TRUE,
        exigir_combustivel BOOLEAN NOT NULL DEFAULT TRUE,
        exigir_avarias BOOLEAN NOT NULL DEFAULT TRUE,
        exigir_destino BOOLEAN NOT NULL DEFAULT TRUE,

        hora_inicio_manha VARCHAR(5) NOT NULL DEFAULT '07:00',
        hora_fim_manha VARCHAR(5) NOT NULL DEFAULT '12:00',
        hora_inicio_tarde VARCHAR(5) NOT NULL DEFAULT '13:00',
        hora_fim_tarde VARCHAR(5) NOT NULL DEFAULT '18:00',

        departamentos JSONB NOT NULL DEFAULT '["Comercial","Marketing","Administrativo","Diretoria","Manutenção - Pós Obras","Suprimentos","Engenharia"]'::jsonb,
        gestor_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,

        evento_ativo BOOLEAN NOT NULL DEFAULT TRUE,
        evento_organizador_email VARCHAR(160),
        evento_participantes VARCHAR(20) NOT NULL DEFAULT 'alcada',
        evento_mostrar_como VARCHAR(10) NOT NULL DEFAULT 'free',
        evento_lembrete_minutos INTEGER NOT NULL DEFAULT 0,

        teams_webhook_url TEXT,
        teams_webhook_ativo BOOLEAN NOT NULL DEFAULT FALSE,

        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    // Linha única. Sem ela o serviço cairia no fallback do código em todo boot
    // e a tela de configuração não teria o que salvar.
    //
    // As datas vão EXPLÍCITAS: quando a tabela nasce pelo `sync` do Sequelize
    // (e não por este CREATE), `created_at`/`updated_at` ficam NOT NULL sem
    // DEFAULT - o Sequelize preenche pelo JS. Um INSERT cru só com o id falha
    // ali, e foi exatamente o que aconteceu na primeira execução.
    `INSERT INTO fleet_settings (id, created_at, updated_at)
     SELECT 1, NOW(), NOW() WHERE NOT EXISTS (SELECT 1 FROM fleet_settings)`,
];

export async function ensureFleetSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Frota] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][Frota] ${applied} ok, ${failed} falha(s).`);
}

export default ensureFleetSchema;
