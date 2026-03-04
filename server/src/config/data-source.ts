import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from './index';
import { User } from '../entities/User';
import { Project } from '../entities/Project';
import { GithubRepo } from '../entities/GithubRepo';
import { CustomDomain } from '../entities/CustomDomain';
import { AppSettings } from '../entities/AppSettings';
import { InitialSchema1709520000000 } from '../migrations/1709520000000-InitialSchema';

export const AppDataSource = new DataSource({
    type: 'postgres',
    host: config.database.host,
    port: config.database.port,
    username: config.database.user,
    password: config.database.password,
    database: config.database.name,
    synchronize: config.nodeEnv === 'development',
    migrationsRun: true, // Auto-run pending migrations on startup
    logging: config.nodeEnv === 'development',
    entities: [User, Project, GithubRepo, CustomDomain, AppSettings],
    migrations: [InitialSchema1709520000000],
    subscribers: [],
});
