const mysql = require('mysql2');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ENCRYPTION_KEY = crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY || '12345678901234567890123456789012')).digest('base64').substr(0, 32); // Must be 32 bytes
const IV_LENGTH = 16; // Initialization vector length

class MySQLClient {
  constructor() {
    this.connection = mysql.createConnection({
      host: 'localhost',
      user: process.env.MYSQL_USER, // Use MYSQL_USER from .env
      password: process.env.MYSQL_PASSWORD
    });
    
    this.connection.connect(err => {
      if (err) {
        console.error('Error connecting to MySQL:', err);
        throw err;
      }
      console.log('Connected to MySQL server.');

      // Ensure the database and table exist
      this._initializeDatabase();
    });
  }

  // Encrypt PAT token
  encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  // Decrypt PAT token
  decrypt(text) {
    const [iv, encryptedText] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Initialize the database and table
  _initializeDatabase() {
    const createDatabaseQuery = `CREATE DATABASE IF NOT EXISTS teams_bot`;
    const useDatabaseQuery = `USE teams_bot`;
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS pat_tokens (
        email VARCHAR(255) PRIMARY KEY,
        pat_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.connection.query(createDatabaseQuery, err => {
      if (err) {
        console.error('Error creating database:', err);
        throw err;
      }
      console.log('Database ensured.');

      this.connection.query(useDatabaseQuery, err => {
        if (err) {
          console.error('Error selecting database:', err);
          throw err;
        }
        console.log('Using database.');

        this.connection.query(createTableQuery, err => {
          if (err) {
            console.error('Error creating table:', err);
            throw err;
          }
          console.log('Table ensured.');
        });
      });
    });
  }

  // Store PAT token
  async storePatToken(email, patToken) {
    return new Promise((resolve, reject) => {
      const encryptedToken = this.encrypt(patToken);
      const query = `
        INSERT INTO pat_tokens (email, pat_token)
        VALUES ('${email}', '${encryptedToken}')
        ON DUPLICATE KEY UPDATE pat_token = VALUES(pat_token), created_at = CURRENT_TIMESTAMP
      `;
      this.connection.query(query, [email, encryptedToken], (err, result) => {
        if (err) {
          console.error('Error storing PAT token:', err);
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  // Retrieve PAT token
  async getPatToken(email) {
    return new Promise((resolve, reject) => {
      const query = `SELECT pat_token FROM pat_tokens WHERE email ='${email}'`;
      this.connection.query(query, [email], (err, results) => {
        if (err) {
          console.error('Error retrieving PAT token:', err);
          return reject(err);
        }
        if (results.length === 0) {
          return resolve(null); // No PAT token found
        }
        const decryptedToken = this.decrypt(results[0].pat_token);
        resolve(decryptedToken);
      });
    });
  }
}

module.exports = new MySQLClient();