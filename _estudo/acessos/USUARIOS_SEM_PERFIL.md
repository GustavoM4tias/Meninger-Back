# Usuários sem perfil e sem empreendimento

Foto do banco em 2026-08-19 (só usuários ATIVOS, não-admin, provedor Office).

São **15 pessoas**, e as duas listas são a MESMA gente: quem não tem perfil
também não tem empreendimento liberado. Quem já está num perfil
(Padrão - Comercial ou Padrão - Administrativo) tem grant.

O que isso significa hoje:
- **sem perfil** → as telas vêm só do pacote legado copiado no cutover
  (`routes_extra`), então editar o perfil do departamento não alcança essas
  pessoas. Quem está com 0 telas não enxerga nada além do que é livre.
- **sem empreendimento** → mesmo com a tela liberada, o dado vem VAZIO
  (não existe fallback desde 2026-07-29: sem grant, sem dado).

## Lista para ajustar

| # | id | Nome | E-mail | Departamento / cargo | Telas hoje | Perfil sugerido |
|---|---|---|---|---|---|---|
| 1 | 78 | Alexsandra Bittencourt | alexsandra.bittencourt@menin.com.br | Comercial / Gestor Comercial | 11 | Padrão - Comercial |
| 2 | 90 | Antônio Marcio | antoniomarciomsa@gmail.com | Comercial / Gestor Comercial | 11 | Padrão - Comercial |
| 3 | 91 | Diego da Silva | di.antonn@gmail.com | Comercial / Adm Comercial | 11 | Padrão - Comercial |
| 4 | 95 | Douglas Baruffi | residencialjardimmonaco@gmail.com | Comercial / Adm Comercial | 0 | Padrão - Comercial |
| 5 | 80 | Francieli Sachini | francieli.sachini@menin.com.br | Comercial / Gestor Comercial | 11 | Padrão - Comercial |
| 6 | 81 | Gabriela Videira | gabriela.videira@menin.com.br | Comercial / Gestor Comercial | 11 | Padrão - Comercial |
| 7 | 82 | Gleyciane Pereira | gleyciane.pereira@menin.com.br | Comercial / Adm Comercial | 11 | Padrão - Comercial |
| 8 | 93 | Michelle Chiquesi | michelle.chiqsi@menin.com.br | Comercial / Adm Comercial | 0 | Padrão - Comercial |
| 9 | 89 | Sara Silva | sara.silva@menin.com.br | Comercial / Adm Comercial | 11 | Padrão - Comercial |
| 10 | 87 | Silvia Romano | silvia.romano@menin.com.br | Comercial / Adm Comercial | 11 | Padrão - Comercial |
| 11 | 96 | Thaina Andressa Natal da Silva | thaina.silva@menin.com.br | Comercial / Adm Comercial | 0 | Padrão - Comercial |
| 12 | 7 | Lúcio Dias | lucio.dias@menin.com.br | Novos Negócios / Gestor Habitacional HIS | 0 | Padrão - Novos Negócios |
| 13 | 79 | Francisco Alberto Furtado | fco.furtado@menin.com.br | **sem cargo/departamento** | 11 | definir departamento antes |
| 14 | 83 | Gustavo Reverete | gustavo.reverete@menin.com.br | **sem cargo/departamento** | 0 | definir departamento antes |
| 15 | 85 | Luis Gustavo Menin | luisgustavo@menin.com.br | **sem cargo/departamento** | 0 | definir departamento antes |

## Observações antes de aplicar

1. **Gestor Comercial x Adm Comercial ganham o mesmo pacote.** Hoje só existe um
   perfil padrão por DEPARTAMENTO. Se o Adm Comercial deve ver menos que o
   Gestor, o caminho é criar um perfil próprio (a tela de Alçadas cria) e não
   remendar com exceção por usuário.
2. **O pacote legado** (11 telas por pessoa, 12 no conjunto) é:
   `/comercial/buildings`, `/comercial/conditions`, `/comercial/mcmv`,
   `/comercial/projections`, `/comercial/relatorios/faturamento`,
   `/comercial/relatorios/projecao`, `/financeiro/custos`, `/marketing/events`,
   `/marketing/leads`, `/microsoft/teams`, `/validator` — mais
   `/financeiro/titulos`, que só 3 pessoas têm. O Padrão - Comercial cobre tudo
   menos `/financeiro/custos` e `/financeiro/titulos`: quem precisar dessas duas
   leva como exceção por usuário.
3. **Trocar o perfil não dá dado.** Depois do perfil, cada pessoa ainda precisa
   dos empreendimentos (botão de liberação na tela de Alçadas). Sem isso a tela
   abre vazia.
4. As 3 pessoas sem cargo/departamento precisam do vínculo em
   /settings/management antes — é o que decide o perfil padrão.
