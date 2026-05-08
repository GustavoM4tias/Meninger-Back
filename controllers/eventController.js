// api/controllers/eventController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { Op } from 'sequelize';
dayjs.extend(utc); dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';
const fmt = (iso) => (iso ? dayjs.utc(iso).tz(TZ).format('dddd, D [de] MMMM [de] YYYY • HH:mm') : '');

const { Event } = db;

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
            link: `/events?search=${encodeURIComponent(title)}`,
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
    // 🔒 precisa do user para sabermos a cidade
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    const isAdmin = req.user.role === 'admin';
    const userCity = req.user.city || '';

    // Base do findAll
    const base = {
      order: [['event_date', 'ASC']],
      attributes: [
        'id', 'title', 'description', 'post_date', 'event_date',
        'tags', 'images', 'address', 'created_by', 'organizers', 'notify_to'
      ],
    };

    // Admin -> vê tudo
    if (isAdmin) {
      const events = await Event.findAll(base);
      return responseHandler.success(res, { events });
    }

    // Não-admin -> precisa de cidade no token
    if (!userCity?.trim()) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    // 🎯 Filtro por address.city ILIKE %userCity%
    // Sequelize com Postgres permite json path com Sequelize.json('address.city')
    const whereCity = db.Sequelize.where(
      db.Sequelize.json('address.city'),
      { [Op.iLike]: `%${userCity}%` }
    );

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
        responseHandler.success(res, 'Evento excluído com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};
