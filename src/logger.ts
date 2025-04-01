import path from "path";
import winston from "winston";

// Logger configuration
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
      let msg = `${timestamp} [${level}]: ${message}`;
      if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
      }
      return msg;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(process.env.LOG_PATH ?? "logs", "script.log"),
      level: "info",
    }),
    new winston.transports.File({
      filename: path.join(process.env.LOG_PATH ?? "logs", "error.log"),
      level: "error",
    }),
  ],
});
