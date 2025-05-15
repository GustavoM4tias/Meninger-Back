// api/controllers/eventController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmailWithTemplate } from '../utils/emailService.js';
const { Event } = db;

export const addEvent = async (req, res) => {
    const { title, description, eventDate, tags, images, address, created_by, notification } = req.body;
    try {
        const e = await Event.create({
            title,
            description,
            event_date: eventDate,
            tags: tags || [],
            images: images || [],
            address: address || [],
            created_by
        });
        responseHandler.success(res, { message: 'Evento criado com sucesso', eventId: e.id });

        if (notification) {
            try {
                await sendEmailWithTemplate(
                    'gustavodiniz200513@gmail.com',
                    'Novo Evento Criado',
                    './templates/emailEventTemplate.html',
                    { title, description, eventDate, tags, images, address, created_by }
                );
            } catch (emailError) {
                console.error('Erro ao enviar e-mail:', emailError.message);
            }
        }
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const getEvents = async (req, res) => {
    try {
        const events = await Event.findAll({
            order: [['event_date', 'ASC']],
            attributes: ['id', 'title', 'description', 'post_date', 'event_date', 'tags', 'images', 'address', 'created_by']
        });
        responseHandler.success(res, { events });
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const updateEvent = async (req, res) => {
    const { id } = req.params;
    const { title, description, eventDate, tags, images, address } = req.body;
    try {
        const [updated] = await Event.update({
            title, description, event_date: eventDate,
            tags: tags || [], images: images || [], address: address || []
        }, { where: { id } });
        if (!updated) return responseHandler.error(res, 'Evento não encontrado');
        responseHandler.success(res, 'Evento atualizado com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
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
