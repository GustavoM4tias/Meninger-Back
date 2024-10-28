### Starter Api Structure

/api
  /controllers
    authController.js
  /routes
    authRoutes.js
  /models
    userModel.js
  /middlewares
    authMiddleware.js
  /config
    db.js
    jwtConfig.js
  /utils
    responseHandler.js
  server.js
  

Explanation of Each Component
/api: The main directory that contains all API-related files.

/controllers: This directory contains the logic for handling requests and responses.

authController.js: This file will contain functions for registering and logging in users. It handles the business logic and interacts with the model to perform operations.
/routes: This directory defines the API endpoints.

authRoutes.js: This file will define routes related to authentication, such as /register and /login. It will link the routes to the corresponding controller functions.
/models: This directory contains the data model definitions.

userModel.js: This file defines the user schema, including fields like username, email, password (hashed), and any other relevant user information. It also contains methods for interacting with the database.
/middlewares: This directory contains middleware functions that can process requests before they reach the controller.

authMiddleware.js: This file can include middleware for checking user authentication status, validating tokens, and protecting routes that require authentication.
/config: This directory contains configuration files for the application.

db.js: This file manages database connection settings and initialization.
jwtConfig.js: This file contains configurations for JSON Web Tokens (JWT), including secret keys and expiration settings.
/utils: This directory contains utility functions that can be reused across the application.

responseHandler.js: This file can define a standardized way to send responses, making it easier to maintain consistency in how responses are structured.
server.js: This is the entry point of the application. It initializes the server, connects to the database, and sets up middleware and routes.

Reasons for This Structure
Separation of Concerns: By organizing files into controllers, routes, models, and middlewares, you create a clear separation of concerns. This makes the codebase easier to navigate and maintain.

Scalability: As your application grows, you can easily add new features or modify existing ones without affecting unrelated parts of the codebase. For instance, if you decide to add password reset functionality, you can create a new controller and route


## Start development:

Initializing Node.js application
npm init -y

install requires dependencies
npm install express mysql bcryptjs jsonwebtoken dotenv express-session

- express: A web framework for Node.js to build APIs.
- mysql: A MySQL client for Node.js.
- bcryptjs: A library to hash passwords securely.
- jsonwebtoken: A library to create and verify JSON Web Tokens (JWT).
- dotenv: A module to load environment variables from a .env file.
- express-session: Middleware for managing sessions.







### The starter API

# Project Structure

Verify

Open In Editor
Edit
Copy code
/user-auth-api
  /api
    /controllers
      authController.js
    /routes
      authRoutes.js
    /models
      userModel.js
    /middlewares
      authMiddleware.js
    /config
      db.js
      jwtConfig.js
    /utils
      responseHandler.js
  .env
  server.js
Step 1: Create Essential Files
1. server.js
This file initializes the server and sets up the routes.

javascript

Verify

Open In Editor
Edit
Copy code
// server.js
const express = require('express');
const dotenv = require('dotenv');
const db = require('./api/config/db');
const authRoutes = require('./api/routes/authRoutes');

dotenv.config();

const app = express();
app.use(express.json()); // Middleware to parse JSON requests

// MySQL connection
db.connect(err => {
  if (err) {
    console.error('Database connection failed:', err);
    return;
  }
  console.log('Connected to MySQL database');
});

// Use authentication routes
app.use('/api/auth', authRoutes);

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
2. .env
Create a .env file to store environment variables.


Verify

Open In Editor
Edit
Copy code
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=user_auth
JWT_SECRET=your_jwt_secret
PORT=5000
3. api/config/db.js
This file establishes the MySQL connection.

javascript

Verify

Open In Editor
Edit
Copy code
// api/config/db.js
const mysql = require('mysql');
const dotenv = require('dotenv');

dotenv.config();

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

module.exports = db;
4. api/config/jwtConfig.js
This file can contain JWT configuration settings.

javascript

Verify

Open In Editor
Edit
Copy code
// api/config/jwtConfig.js
const dotenv = require('dotenv');

dotenv.config();

const jwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: '30d', // Token expiration
};

module.exports = jwtConfig;
5. api/models/userModel.js
Define the user model and database interaction functions.

javascript

Verify

Open In Editor
Edit
Copy code
// api/models/userModel.js
const bcrypt = require('bcryptjs');

const User = {
  // Register a new user
  register: async (db, username, password, email) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    return new Promise((resolve, reject) => {
      const sql = 'INSERT INTO users (username, password, email) VALUES (?, ?, ?)';
      db.query(sql, [username, hashedPassword, email], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  },

  // Find user by username
  findByUsername: (db, username) => {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM users WHERE username = ?';
      db.query(sql, [username], (err, results) => {
        if (err) return reject(err);
        resolve(results[0]);
      });
    });
  },
};

module.exports = User;
6. api/controllers/authController.js
Implement the logic for user registration and login.

javascript

Verify

Open In Editor
Edit
Copy code
// api/controllers/authController.js
const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');

const registerUser  = async (req, res) => {
  const { username, password, email } = req.body;

  try {
    const existingUser  = await User.findByUsername(req.db, username);
    if (existingUser ) {
      return res.status(400).json({ message: 'User  already exists' });
    }

    await User.register(req.db, username, password, email);
    res.status(201).json({ message: 'User  registered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error registering user', error });
  }
};

const loginUser  = async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findByUsername(req.db, username);
    if (user && (await bcrypt.compare(password, user.password))) {
      const token = jwt.sign({ id: user.id }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });
      res .json({ token });
    } else {
      res.status(401).json({ message: 'Invalid username or password' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error logging in user', error });
  }
};

module.exports = { registerUser, loginUser };
7. api/routes/authRoutes.js
Define the routes for user registration and login.

javascript

Verify

Open In Editor
Edit
Copy code
// api/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { registerUser, loginUser } = require('../controllers/authController');

router.post('/register', registerUser);
router.post('/login', loginUser);

module.exports = router;
8. api/middlewares/authMiddleware.js
This file can contain authentication middleware functions.

javascript

Verify

Open In Editor
Edit
Copy code
// api/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwtConfig');

const authenticate = async (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(400).json({ message: 'Invalid token.' });
  }
};

module.exports = authenticate;
9. api/utils/responseHandler.js
This file can contain utility functions for handling responses.

javascript

Verify

Open In Editor
Edit
Copy code
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
This structure and the provided files should help you create a Node.js API using MySQL for user registration and login. Make sure to replace the placeholders in the .env file with your actual database credentials and JWT secret.


## Database 

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

node server.js


 Test User Registration
Create a new request:
Set the request type to POST.
Enter the URL: http://localhost:5000/api/auth/register.
Set the request body:
Select Body.
Choose raw and set the format to JSON.
Enter the following JSON data:
json

Verify

Open In Editor
Edit
Copy code
{
    "username": "testuser",
    "password": "testpassword",
    "email": "testuser@example.com"
}
Send the request:
Click the Send button.
You should receive a response indicating that the user was registered successfully.
4. Test User Login
Create another request:

Set the request type to POST.
Enter the URL: http://localhost:5000/api/auth/login.
Set the request body:

Select Body.
Choose raw and set the format to JSON.
Enter the following JSON data:
json

Verify

Open In Editor
Edit
Copy code
{
    "username": "testuser",
    "password": "testpassword"
}
Send the request:
Click the Send button.
You should receive a response containing a JWT token if the login is successful.
5. Use the JWT Token for Protected Routes (if applicable)
If you have any protected routes in your API that require authentication, you can use the JWT token received from the login response:

Create a new request:

Set the request type to GET (or the appropriate method for your protected route).
Enter the URL for the protected route, e.g., http://localhost:5000/api/protected.
Set the Authorization header:

Go to the Headers tab.
Add a new key-value pair:
Key: Authorization
Value: Bearer <your_jwt_token> (replace <your_jwt_token> with the actual token you received).
Send the request:

Click the Send button.
You should receive a response based on the logic defined in your protected route.
