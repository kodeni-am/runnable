import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from './index';
import { User } from '../entities/User';
import { Project } from '../entities/Project';
import { GithubRepo } from '../entities/GithubRepo';
import { CustomDomain } from '../entities/CustomDomain';
import { AppSettings } from '../entities/AppSettings';

export const AppDataSource = new DataSource({
    type: 'postgres',
    host: config.database.host,
    port: config.database.port,
    username: config.database.user,
    password: config.database.password,
    database: config.database.name,
    synchronize: config.nodeEnv === 'development',
    logging: config.nodeEnv === 'development',
    entities: [User, Project, GithubRepo, CustomDomain, AppSettings],
    migrations: ['src/migrations/*.ts'],
    subscribers: [],
});
