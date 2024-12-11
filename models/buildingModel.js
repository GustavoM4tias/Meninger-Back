// api/models/buildingModel.js
const Building = {
    addBuilding: async (db, { title, description, buildingDate, tags, images, address, created_by, stage }) => {
        console.log('Tags:', JSON.stringify(tags)); // Confirma a conversão
        console.log('Images:', JSON.stringify(images)); // Confirma a conversão
        console.log('Address:', JSON.stringify(address)); // Confirma a conversão
        const sql = `INSERT INTO buildings (title, description, building_date, tags, images, address, created_by, stage)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await db.execute(sql, [
            title,
            description,
            buildingDate,
            JSON.stringify(tags),
            JSON.stringify(images),
            JSON.stringify(address),
            created_by,
            stage
        ]);
        return result;
    },

    getBuildings: async (db) => {
        const sql = `SELECT id, title, description, post_date, building_date, tags, images, address, created_by, stage FROM buildings ORDER BY building_date ASC`;
        const [rows] = await db.execute(sql);

        return rows.map(building => ({
            ...building,
            tags: typeof building.tags === 'string' ? JSON.parse(building.tags) : building.tags,
            images: typeof building.images === 'string' ? JSON.parse(building.images) : building.images,
            address: typeof building.address === 'string' ? JSON.parse(building.address) : building.address
        }));
    },

    updateBuilding: async (db, id, { title, description, buildingDate, tags, images, address, stage }) => {
        const sql = `UPDATE buildings 
                     SET title = ?, description = ?, building_date = ?, tags = ?, images = ?, address = ?, stage = ? 
                     WHERE id = ?`;
        const [result] = await db.execute(sql, [
            title,
            description,
            buildingDate,
            JSON.stringify(tags),
            JSON.stringify(images),
            JSON.stringify(address), 
            stage,
            id
        ]);
        return result;
    },

    deleteBuilding: async (db, id) => {
        const sql = `DELETE FROM buildings WHERE id = ?`;
        const [result] = await db.execute(sql, [id]);
        return result;
    }

};

export default Building;
