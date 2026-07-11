import redis, { RedisClient } from "redis";
import { authConfig } from "../../../../config";

const { redisServerUser, redisServerPASS, redisServerURL, redisServerPort } =
  authConfig;

const redisConnection: RedisClient = redis.createClient({
  host: redisServerURL,
  port: redisServerPort,
  password: redisServerPASS,
  ...(redisServerUser ? { user: redisServerUser } : {}),
});

redisConnection.on("connect", () => {
  console.log(
    `[Redis]: Connected to redis server at ${authConfig.redisServerURL}:${authConfig.redisServerPort}`
  );
});

redisConnection.on("error", (err) => {
  console.error("[Redis]: Connection error", err.message);
});

export { redisConnection };
