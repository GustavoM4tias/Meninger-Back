// api/controllers/eventController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { Op } from 'sequelize';
import { visibleCities } from '../services/permissions/accessScopeService.js';
dayjs.extend(utc); dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const fmt = (iso) => (iso ? dayjs.utc(iso).tz(TZ).format('dddd, D [de] MMMM [de] YYYY • HH:mm') : '');

const { Event } = db;

// Vínculo de empreendimento do evento (o form envia enterprise_id/name/logo).
// Sanitiza: id numérico ou null; strings vazias viram null.
const enterpriseFields = (body) => ({
    enterprise_id: Number.isFinite(Number(body?.enterprise_id)) && String(body?.enterprise_id ?? '') !== ''
        ? Number(body.enterprise_id) : null,
    enterprise_name: String(body?.enterprise_name || '').trim() || null,
    enterprise_logo: String(body?.enterprise_logo || '').trim() || null,
});

export const addEvent = async (req, res) => {
    const {
        title, description, eventDate, tags = [], images = [],
        address = {}, created_by, notification = false,
        organizers = [], notify_to = { users: [], positions: [], emails: [] },
    } = req.body;

    try {
        const created = await Event.create({
            title,
            description,
            event_date: eventDate,
            tags,
            images,
            address,
            created_by,
            organizers,
            notify_to,
            ...enterpriseFields(req.body),
        });

        res.status(201).json({ message: 'Evento criado com sucesso', eventId: created.id });

        if (!notification) return;

        // dispara via serviço unificado: persiste in-app + envia e-mail conforme prefs
        NotificationService.notify({
            type: NotificationType.EVENT_CREATED,
            recipients: notify_to,
            title: `Novo evento: ${title}`,
            body: description,
            data: {
                eventId: created.id,
                image: Array.isArray(images) ? images[0] : null,
                eventDateISO: eventDate,
                eventDateFormatted: fmt(eventDate),
            },
            link: `/marketing/Events?search=${encodeURIComponent(title)}`,
            importance: 7,
            emailData: {
                title,
                description,
                eventDateISO: eventDate,
                eventDateFormatted: fmt(eventDate),
                tags,
                images,
                address,
                organizers,
            },
        }).catch(err => console.error('[event/notify]', err));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar evento' });
    }
};

export const updateEvent = async (req, res) => {
    const { id } = req.params;
    const {
        title,
        description,
        eventDate,
        tags = [],
        images = [],
        address = {},
        organizers = [],
        notify_to = { users: [], positions: [], emails: [] }
    } = req.body;

    try {
        const [updated] = await Event.update({
            title,
            description,
            event_date: eventDate,
            tags: Array.isArray(tags) ? tags : [],
            images: Array.isArray(images) ? images : [],
            address: address && typeof address === 'object' ? address : {}, // <— corrigido
            organizers: Array.isArray(organizers) ? organizers : [],
            notify_to: {
                users: Array.isArray(notify_to?.users) ? notify_to.users : [],
                positions: Array.isArray(notify_to?.positions) ? notify_to.positions : [],
                emails: Array.isArray(notify_to?.emails) ? notify_to.emails : []
            },
            ...enterpriseFields(req.body),
        }, { where: { id } });

        if (!updated) return responseHandler.error(res, 'Evento não encontrado');
        responseHandler.success(res, 'Evento atualizado com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
}; 

export const getEvents = async (req, res) => {
  try {
    // 🔒 precisa do user para sabermos o escopo
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    // Escopo por cidades (eventos filtram por endereço, sem id de
    // empreendimento): null = admin (sem filtro), [] = nada visível
    const cities = await visibleCities(req.user);

    // Base do findAll
    const base = {
      order: [['event_date', 'ASC']],
      attributes: [
        'id', 'title', 'description', 'post_date', 'event_date',
        'tags', 'images', 'address', 'created_by', 'organizers', 'notify_to',
        'enterprise_id', 'enterprise_name', 'enterprise_logo',
      ],
    };

    // Admin -> vê tudo
    if (cities === null) {
      const events = await Event.findAll(base);
      return responseHandler.success(res, { events });
    }

    // fail-closed: escopo sem cidades → nada visível
    if (!cities.length) {
      return responseHandler.success(res, { events: [] });
    }

    // 🎯 Filtro por address.city ILIKE %cidade% (qualquer cidade do escopo)
    // Sequelize com Postgres permite json path com Sequelize.json('address.city')
    const whereCity = {
      [Op.or]: cities.map((c) => db.Sequelize.where(
        db.Sequelize.json('address.city'),
        { [Op.iLike]: `%${c}%` }
      )),
    };

    const events = await Event.findAll({
      ...base,
      where: whereCity,
    });

    return responseHandler.success(res, { events });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const deleteEvent = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await Event.destroy({ where: { id } });
        if (!deleted) return responseHandler.error(res, 'Evento não encontrado');

        // Cascade: remove notificações in-app relacionadas a esse evento
        // (data->>'eventId' guarda o id em formato texto no Postgres)
        try {
            await db.Notification.destroy({
                where: db.Sequelize.where(
                    db.Sequelize.literal(`data->>'eventId'`),
                    String(id)
                ),
            });
        } catch (e) {
            console.warn('[eventDelete] falha ao limpar notificações do evento', id, e?.message);
        }

        responseHandler.success(res, 'Evento excluído com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

// ─── Relatório de eventos por e-mail ──────────────────────────────────────────
//
// A tela captura o relatório como imagem e manda pra cá. O destinatário pode ser
// escolhido de quatro formas, que se somam: pessoas, cargos, departamentos
// inteiros ou e-mail avulso digitado. Escolher por cargo/departamento evita o
// erro clássico de esquecer alguém ao digitar endereço a endereço.

/**
 * Catálogo de destinatários para o seletor da tela: pessoas ativas e internas,
 * mais os cargos e departamentos existentes.
 */
export const listReportRecipients = async (req, res) => {
    try {
        const { User, Position, Department } = db;

        const users = await User.findAll({
            where: {
                status: true,
                // Usuário externo (Academy/parceiro) não recebe relatório interno.
                external_kind: { [Op.is]: null },
                external_organization_id: { [Op.is]: null },
                email: { [Op.ne]: null },
            },
            attributes: ['id', 'username', 'email', 'position', 'position_id'],
            order: [['username', 'ASC']],
        });

        const positions = await Position.findAll({
            where: { active: true },
            attributes: ['id', 'name', 'department_id'],
            include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
            order: [['name', 'ASC']],
        });

        const departments = await Department.findAll({
            where: { active: true },
            attributes: ['id', 'name'],
            order: [['name', 'ASC']],
        });

        const deptByPosition = new Map(positions.map(p => [p.id, p.department?.name || null]));

        res.json({
            users: users.map(u => ({
                id: u.id,
                username: u.username,
                email: u.email,
                position: u.position || null,
                department: deptByPosition.get(u.position_id) || null,
            })),
            positions: [...new Set(positions.map(p => p.name).filter(Boolean))],
            departments: departments.map(d => ({ id: d.id, name: d.name })),
        });
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

/** E-mails de todos os destinatários escolhidos, sem repetir ninguém. */
async function resolveReportRecipients({ emails = [], userIds = [], positions = [], departmentIds = [] }) {
    const { User, Position } = db;
    const base = {
        status: true,
        external_kind: { [Op.is]: null },
        external_organization_id: { [Op.is]: null },
        email: { [Op.ne]: null },
    };

    const found = new Map();
    const push = (rows) => rows.forEach(u => { if (u.email) found.set(u.email.toLowerCase(), u.email); });

    if (userIds.length) {
        push(await User.findAll({ where: { ...base, id: userIds }, attributes: ['email'] }));
    }
    if (positions.length) {
        push(await User.findAll({ where: { ...base, position: { [Op.in]: positions } }, attributes: ['email'] }));
    }
    if (departmentIds.length) {
        // Departamento chega às pessoas pelos cargos dele (positions.department_id).
        const cargos = await Position.findAll({
            where: { department_id: departmentIds }, attributes: ['id'],
        });
        const ids = cargos.map(c => c.id);
        if (ids.length) {
            push(await User.findAll({ where: { ...base, position_id: { [Op.in]: ids } }, attributes: ['email'] }));
        }
    }

    // E-mail digitado à mão entra por último e não duplica quem já veio do cadastro.
    for (const raw of emails) {
        const e = String(raw || '').trim();
        if (e && !found.has(e.toLowerCase())) found.set(e.toLowerCase(), e);
    }

    return [...found.values()];
}

export const sendReportEmail = async (req, res) => {
    try {
        const {
            to = [], userIds = [], positions = [], departmentIds = [],
            subject, message, imageBase64, reportTitle,
        } = req.body || {};

        const destinatarios = await resolveReportRecipients({
            emails: Array.isArray(to) ? to : [],
            userIds: (Array.isArray(userIds) ? userIds : []).map(Number).filter(Boolean),
            positions: Array.isArray(positions) ? positions : [],
            departmentIds: (Array.isArray(departmentIds) ? departmentIds : []).map(Number).filter(Boolean),
        });

        if (!destinatarios.length) {
            return res.status(400).json({ error: 'Escolha ao menos um destinatário.' });
        }
        if (!imageBase64) {
            return res.status(400).json({ error: 'Relatório sem imagem para enviar.' });
        }

        // dataURL -> Buffer. A imagem vai anexada E embutida por cid, para
        // aparecer no corpo mesmo em cliente que bloqueia imagem remota.
        const base64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const titulo = String(reportTitle || 'Cronograma de Eventos').trim();
        const assunto = String(subject || '').trim() || `${titulo} — Menin`;
        const corpo = String(message || '').trim();

        const bodyHtml = [
            corpo ? `<p style="margin:0 0 16px 0;">${corpo.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` : '',
            '<img src="cid:relatorio-eventos" alt="' + titulo.replace(/"/g, '') + '"',
            ' style="width:100%;max-width:640px;border:1px solid #e5e7eb;border-radius:8px;" />',
        ].join('');

        const { sendEmail } = await import('../email/email.service.js');
        await sendEmail(
            'generic.notification',
            destinatarios,
            { title: assunto, preview: titulo, bodyHtml },
            {
                attachments: [{
                    filename: `${titulo.replace(/[^\w\s-]/g, '').trim() || 'relatorio'}.jpg`,
                    content: buffer,
                    cid: 'relatorio-eventos',
                }],
            },
        );

        res.json({ ok: true, sent: destinatarios.length, recipients: destinatarios });
    } catch (error) {
        console.error('[events] sendReportEmail', error?.message);
        responseHandler.error(res, error.message);
    }
};
