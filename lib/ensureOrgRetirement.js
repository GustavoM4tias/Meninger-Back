// lib/ensureOrgRetirement.js
//
// Faxina do quadro de departamentos (decisão de 2026-08-27). O que muda:
//
//   • "Direção" e "Diretoria" eram o mesmo departamento em dobro. Fica
//     DIRETORIA (é o do conjunto padrão — apagar o outro só faria o seed
//     recriá-lo no boot seguinte); os cargos e as pessoas da "Direção" migram.
//   • "Financeiro" não existe mais na empresa: a operação é Contas a Pagar e
//     Contas a Receber. O departamento vira CONTAS_A_RECEBER (é onde está a
//     pessoa lotada nele hoje) e CONTAS_A_PAGAR nasce ao lado.
//   • Jurídico, Recursos Humanos, Tecnologia da Informação e o Sócio Fundador
//     (que já estava inativo) saem — nenhum tem gente lotada.
//   • Perfis de alçada inativos e sem ninguém apontando são APAGADOS. Eram
//     restos da consolidação de 2026-08-19 ("Gestor Comercial", "Novos
//     Negócios"), que a tela de Alçadas mostrava como lixo permanente.
//
// Roda UMA VEZ (applyOnce). Não pode ser idempotente-de-todo-boot: depois
// desta passada o dono do cadastro é a tela Departamentos & cargos, e um patch
// que reescrevesse isso a cada boot desfaria o que o admin fizer lá.
//
// Ninguém perde alçada na virada: quando um perfil é reaproveitado por um
// departamento novo e JÁ TEM gente apontando para ele, ele é marcado como
// customizado — assim o seed de perfis padrão não re-sincroniza as telas por
// baixo de quem já usa. O admin aplica o padrão novo quando quiser, pelo botão
// "Restaurar padrão" da tela de Alçadas.
//
// Ver lib/ensureOrgDefaultsSchema.js (conjunto padrão de departamentos/cargos)
// e lib/ensureSignupApprovalSchema.js (telas padrão por departamento).

import { applyOnce } from './schemaPatchMarks.js';

const SQL = `
DO $$
DECLARE
    -- de → para, por CÓDIGO do departamento. Merge preserva cargos, pessoas e alçadas.
    v_merges  TEXT[][] := ARRAY[['DIREÇÃO', 'DIRETORIA'], ['FINANCEIRO', 'CONTAS_A_RECEBER']];
    -- Departamentos que saem de vez (nenhum tem gente lotada).
    v_drops   TEXT[]   := ARRAY['JURIDICO', 'RH', 'TI', 'SOCIO_FUNDADOR'];
    v_par     TEXT[];
    v_code    TEXT;
    v_src     INTEGER;
    v_dst     INTEGER;
    v_dst_nome TEXT;
    v_dst_code TEXT;
    v_p_src   INTEGER;
    v_p_dst   INTEGER;
BEGIN
    -- ── Departamentos novos ──────────────────────────────────────────────
    -- Criados aqui (e não só no seed) para o merge do Financeiro já ter
    -- destino nesta mesma passada, independente da ordem dos patches.
    INSERT INTO departments (code, name, description, active, created_at, updated_at)
    VALUES ('CONTAS_A_PAGAR', 'Contas a Pagar',
            'Títulos a pagar, custos por centro de custo, conciliação com o Sienge e relacionamento com fornecedores.',
            true, NOW(), NOW())
    ON CONFLICT DO NOTHING;

    INSERT INTO departments (code, name, description, active, created_at, updated_at)
    VALUES ('CONTAS_A_RECEBER', 'Contas a Receber',
            'Cobrança do ato, boletos e link de cartão, consulta de nº CEF, conciliação de recebimentos e inadimplência.',
            true, NOW(), NOW())
    ON CONFLICT DO NOTHING;

    -- ── Merges ───────────────────────────────────────────────────────────
    FOREACH v_par SLICE 1 IN ARRAY v_merges LOOP
        SELECT id INTO v_src FROM departments WHERE upper(code) = upper(v_par[1]) LIMIT 1;
        SELECT id, name, code INTO v_dst, v_dst_nome, v_dst_code
          FROM departments WHERE upper(code) = upper(v_par[2]) LIMIT 1;
        CONTINUE WHEN v_src IS NULL OR v_dst IS NULL OR v_src = v_dst;

        UPDATE positions SET department_id = v_dst WHERE department_id = v_src;
        UPDATE users SET signup_department_id = v_dst WHERE signup_department_id = v_src;

        -- Perfil padrão do destino, se já existir (o do Diretoria existe; o dos
        -- departamentos recém-criados ainda não — o seed cria depois).
        SELECT id INTO v_p_dst FROM permission_profiles
         WHERE department_id = v_dst ORDER BY active DESC, id LIMIT 1;

        FOR v_p_src IN SELECT id FROM permission_profiles WHERE department_id = v_src LOOP
            IF v_p_dst IS NOT NULL THEN
                -- Destino já tem perfil padrão: as pessoas do perfil antigo passam
                -- para ele e o antigo some.
                UPDATE users SET permission_profile_id = v_p_dst WHERE permission_profile_id = v_p_src;
                DELETE FROM permission_profiles WHERE id = v_p_src;
            ELSE
                -- Destino sem perfil: o antigo VIRA o perfil do departamento novo,
                -- levando junto quem já aponta para ele.
                UPDATE permission_profiles
                   SET department_id = v_dst,
                       seed_code = v_dst_code,
                       -- Só congela as telas se houver gente apontando: aí ninguém
                       -- perde acesso na virada. Perfil vazio segue o padrão novo.
                       routes_customized = routes_customized
                           OR EXISTS (SELECT 1 FROM users WHERE permission_profile_id = v_p_src)
                 WHERE id = v_p_src;

                UPDATE permission_profiles
                   SET name = 'Padrão - ' || v_dst_nome
                 WHERE id = v_p_src
                   AND NOT EXISTS (SELECT 1 FROM permission_profiles x
                                    WHERE x.id <> v_p_src AND x.name = 'Padrão - ' || v_dst_nome);

                v_p_dst := v_p_src;
            END IF;
        END LOOP;

        DELETE FROM departments WHERE id = v_src;
        RAISE NOTICE '[OrgRetirement] % incorporado a %.', v_par[1], v_par[2];
    END LOOP;

    -- ── Remoções ─────────────────────────────────────────────────────────
    FOREACH v_code IN ARRAY v_drops LOOP
        SELECT id INTO v_src FROM departments WHERE upper(code) = upper(v_code) LIMIT 1;
        CONTINUE WHEN v_src IS NULL;

        -- Trava: departamento com gente lotada NÃO é removido. Se alguém entrar
        -- num deles entre a escrita e o boot, o patch deixa como está.
        IF EXISTS (SELECT 1 FROM users u JOIN positions p ON p.id = u.position_id
                    WHERE p.department_id = v_src) THEN
            RAISE NOTICE '[OrgRetirement] % tem pessoa lotada — mantido.', v_code;
            CONTINUE;
        END IF;

        DELETE FROM positions p
         WHERE p.department_id = v_src
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.position_id = p.id);

        UPDATE users SET signup_department_id = NULL WHERE signup_department_id = v_src;

        FOR v_p_src IN SELECT id FROM permission_profiles WHERE department_id = v_src LOOP
            IF EXISTS (SELECT 1 FROM users WHERE permission_profile_id = v_p_src) THEN
                -- Não deve acontecer (departamento sem gente), mas alçada de
                -- alguém nunca é apagada às cegas: desvincula e desativa.
                UPDATE permission_profiles SET department_id = NULL, active = false WHERE id = v_p_src;
            ELSE
                DELETE FROM permission_profiles WHERE id = v_p_src;
            END IF;
        END LOOP;

        DELETE FROM departments d
         WHERE d.id = v_src
           AND NOT EXISTS (SELECT 1 FROM positions WHERE department_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM permission_profiles WHERE department_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM users WHERE signup_department_id = d.id);
        RAISE NOTICE '[OrgRetirement] % removido.', v_code;
    END LOOP;

    -- ── Perfis inativos sem ninguém ──────────────────────────────────────
    DELETE FROM permission_profiles pp
     WHERE pp.active = false
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.permission_profile_id = pp.id);
END $$;
`;

export async function ensureOrgRetirement() {
    await applyOnce('org.departamentos.faxina_2026_08_27', SQL);
}

export default ensureOrgRetirement;
