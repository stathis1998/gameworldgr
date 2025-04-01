import {
  createConnection,
  ConnectionOptions,
  Connection,
  RowDataPacket,
} from "mysql2/promise";

import { logger } from "./logger";

// Database Configuration
const dbConfig: ConnectionOptions = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

export async function connectToDatabase() {
  try {
    const connection = await createConnection(dbConfig);
    logger.info("Connected to the database");
    return connection;
  } catch (error) {
    logger.error("An error occurred while connecting to the database");
    logger.error(error);
  }
}

export async function disconnectFromDatabase(connection: Connection) {
  try {
    await connection.end();
    logger.info("Disconnected from the database");
  } catch (error) {
    logger.error("An error occurred while disconnecting from the database");
    logger.error(error);
  }
}

export async function queryDatabase(
  connection: Connection,
  query: string,
  values?: any[]
) {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(query, values);
    logger.info("Query successful", { query, values });
    return rows;
  } catch (error) {
    logger.error("An error occurred while querying the database");
    logger.error(error);
  }
}
