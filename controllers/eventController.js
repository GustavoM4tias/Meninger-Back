// api/controllers/eventController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmailWithTemplate } from '../utils/emailService.js';

const { Event, User } = db; // <— supondo que exista db.User

export const addEvent = async (req, res) => {
    const {
        title,
        description,
        eventDate,
        tags = [],
        images = [],
        address = {},
        created_by,
        notification = false,
        organizers = [],
        notify_to = { users: [], positions: [], emails: [] }
    } = req.body;

    try {
        // LOG opcional pra conferir se o externo está chegando
        // console.log('organizers recebido:', JSON.stringify(organizers));

        const e = await Event.create({
            title,
            description,
            event_date: eventDate,
            tags: Array.isArray(tags) ? tags : [],
            images: Array.isArray(images) ? images : [],
            address: address && typeof address === 'object' ? address : {}, // <— corrigido
            created_by,
            organizers: Array.isArray(organizers) ? organizers : [],
            notify_to: {
                users: Array.isArray(notify_to?.users) ? notify_to.users : [],
                positions: Array.isArray(notify_to?.positions) ? notify_to.positions : [],
                emails: Array.isArray(notify_to?.emails) ? notify_to.emails : []
            }
        });

        responseHandler.success(res, { message: 'Evento criado com sucesso', eventId: e.id });

        if (notification) {
            // 1) Começa com os e-mails manuais
            const emails = new Set([...(notify_to?.emails || [])]);

            // 2) + e-mails dos usuários por ID
            if (User && Array.isArray(notify_to?.users) && notify_to.users.length) {
                const users = await User.findAll({
                    where: { id: notify_to.users },
                    attributes: ['id', 'email']
                });
                users.forEach(u => u?.email && emails.add(u.email));
            }

            // 3) + e-mails por cargo (position)
            if (User && Array.isArray(notify_to?.positions) && notify_to.positions.length) {
                const byPosition = await User.findAll({
                    where: { position: notify_to.positions },
                    attributes: ['id', 'email']
                });
                byPosition.forEach(u => u?.email && emails.add(u.email));
            }

            // (Opcional) Remover vazios e normalizar
            const finalEmails = Array.from(emails).filter(Boolean);

            for (const to of finalEmails) {
                try {
                    await sendEmailWithTemplate(
                        to,
                        'Novo Evento Criado',
                        './templates/emailEventTemplate.html',
                        { title, description, eventDate, tags, images, address, organizers }
                    );
                } catch (emailError) {
                    console.error('Erro ao enviar e-mail:', emailError.message);
                }
            }
        }
    } catch (error) {
        responseHandler.error(res, error);
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
