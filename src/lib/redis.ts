import IORedis, { Redis } from "ioredis";
import config from "../config";

let connection: Redis | null = null;

export const getRedisConnection = (): Redis => {
  if (!connection) {
    connection = new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null, // BullMQ requirement
      enableReadyCheck: true,
    });

    connection.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[redis] connection error", err.message);
    });
  }
  return connection;
};

export const closeRedisConnection = async (): Promise<void> => {
  if (connection) {
    await connection.quit();
    connection = null;
  }
};