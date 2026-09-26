import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureApp } from './app-setup.js';
import { API_PREFIX } from './common/constants.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  const port = app.get(ConfigService).get<number>('port') ?? 3000;
  await app.listen(port, '0.0.0.0');

  Logger.log(`知源 API 已启动:http://localhost:${port}/${API_PREFIX}`, 'Bootstrap');
}

void bootstrap();
