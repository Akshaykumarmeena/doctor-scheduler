export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  opensearchUrl: process.env.OPENSEARCH_URL ?? 'http://localhost:9200',
  searchIndex: process.env.SEARCH_ALIAS ?? 'doctors',
  port: Number(process.env.API_PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
};
