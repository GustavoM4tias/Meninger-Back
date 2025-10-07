// api/controllers/eventController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmail } from '../email/email.service.js';
import { EmailType } from '../email/types.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { Op } from 'sequelize';
dayjs.extend(utc); dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const fmt = (iso) => (iso ? dayjs.utc(iso).tz(TZ).format('dddd, D [de] MMMM [de] YYYY • HH:mm') : '');
 
const { Event, User } = db;

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
        });

        res.status(201).json({ message: 'Evento criado com sucesso', eventId: created.id });

        if (!notification) return;

        // 1) resolve destinatários
        const set = new Set([...(notify_to.emails || [])]);

        if (notify_to.users?.length) {
            (await User.findAll({ where: { id: notify_to.users }, attributes: ['email'] }))
                .forEach(u => u?.email && set.add(u.email));
        }
        if (notify_to.positions?.length) {
            (await User.findAll({ where: { position: { [Op.in]: notify_to.positions } }, attributes: ['email'] }))
                .forEach(u => u?.email && set.add(u.email));
        }

        const recipients = [...set].filter(Boolean);
        if (!recipients.length) return;

        // 2) monta dados do template
        const data = {
            title,
            description,
            eventDateISO: eventDate,
            eventDateFormatted: fmt(eventDate),
            tags,
            images,
            address,
            organizers, 
        };

        // 3) dispara
        await sendEmail(EmailType.EVENT_CREATED, recipients, data);
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
            }
        }, { where: { id } });

        if (!updated) return responseHandler.error(res, 'Evento não encontrado');
        responseHandler.success(res, 'Evento atualizado com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

export const getEvents = async (req, res) => {
    try {
        const events = await Event.findAll({
            order: [['event_date', 'ASC']],
            attributes: ['id', 'title', 'description', 'post_date', 'event_date', 'tags', 'images', 'address', 'created_by', 'organizers', 'notify_to']
        });
        responseHandler.success(res, { events });
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const deleteEvent = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await Event.destroy({ where: { id } });
        if (!deleted) return responseHandler.error(res, 'Evento não encontrado');
        responseHandler.success(res, 'Evento excluído com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};
