// api/models/eventModel.js
const Event = {
    addEvent: async (db, { title, description, eventDate, tags, images }) => {
        console.log('Tags:', JSON.stringify(tags)); // Confirma a conversão
        console.log('Images:', JSON.stringify(images)); // Confirma a conversão
        const sql = `INSERT INTO events (title, description, event_date, tags, images)
                   VALUES (?, ?, ?, ?, ?)`;
        const [result] = await db.execute(sql, [
            title,
            description,
            eventDate,
            JSON.stringify(tags),
            JSON.stringify(images)
        ]);
        return result;
    },

    getEvents: async (db) => {
        const sql = `SELECT id, title, description, post_date, event_date, tags, images FROM events ORDER BY event_date ASC`;
        const [rows] = await db.execute(sql);

        return rows.map(event => ({
            ...event,
            tags: typeof event.tags === 'string' ? JSON.parse(event.tags) : event.tags,
            images: typeof event.images === 'string' ? JSON.parse(event.images) : event.images
        }));

    },

    updateEvent: async (db, id, { title, description, eventDate, tags, images }) => {
        const sql = `UPDATE events 
                     SET title = ?, description = ?, event_date = ?, tags = ?, images = ? 
                     WHERE id = ?`;
        const [result] = await db.execute(sql, [
            title,
            description,
            eventDate,
            JSON.stringify(tags),
            JSON.stringify(images),
            id
        ]);
        return result;
    },

    deleteEvent: async (db, id) => {
        const sql = `DELETE FROM events WHERE id = ?`;
        const [result] = await db.execute(sql, [id]);
        return result;
    }

};

export default Event;
