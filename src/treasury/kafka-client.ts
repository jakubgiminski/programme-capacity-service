import { Logger } from '@nestjs/common';
import { Kafka, logLevel, type logCreator } from 'kafkajs';
import { type AppConfig } from '../config/config';

export const KAFKA = Symbol('KAFKA');

const kafkaLogCreator: logCreator = () => {
  const logger = new Logger('kafkajs');
  return ({ namespace, level, log }) => {
    const { message, ...extra } = log;
    const text = `[${namespace}] ${message}`;
    if (level === logLevel.ERROR) {
      logger.error({ ...extra }, text);
      return;
    }
    if (level === logLevel.WARN) {
      logger.warn({ ...extra }, text);
      return;
    }
    if (level === logLevel.INFO) {
      logger.log({ ...extra }, text);
      return;
    }
    logger.debug({ ...extra }, text);
  };
};

export function createKafka(config: AppConfig): Kafka {
  return new Kafka({
    clientId: config.KAFKA_CLIENT_ID,
    brokers: config.KAFKA_BROKERS,
    logLevel: logLevel.WARN,
    logCreator: kafkaLogCreator,
    retry: { initialRetryTime: 300, retries: 8 },
  });
}
