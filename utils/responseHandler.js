// api/utils/responseHandler.js
const responseHandler = {
    success: (res, data) => {
      res.json({ success: true, data });
    },
    error: (res, error) => {
      res.status(500).json({ success: false, error });
    },
  };
  
  module.exports = responseHandler;