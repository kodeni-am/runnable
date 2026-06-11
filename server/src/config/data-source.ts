import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from './index';
import { User } from '../entities/User';
import { Project } from '../entities/Project';
import { GithubRepo } from '../entities/GithubRepo';
import { CustomDomain } from '../entities/CustomDomain';
import { AppSettings } from '../entities/AppSettings';
import { ProjectCollaborator } from '../entities/ProjectCollaborator';
import { Deployment } from '../entities/Deployment';
import { InitialSchema1709520000000 } from '../migrations/1709520000000-InitialSchema';
import { AddDomainRedirectTarget1772633000000 } from '../migration/1772633000000-AddDomainRedirectTarget';
import { AddPermissions1772634000000 } from '../migrations/1772634000000-AddPermissions';
import { AddComposeSupport1772635000000 } from '../migrations/1772635000000-AddComposeSupport';
import { AddDeployments1772636000000 } from '../migrations/1772636000000-AddDeployments';
import { AddNotificationsAndAutoRestart1772637000000 } from '../migrations/1772637000000-AddNotificationsAndAutoRestart';
import { AddTokenVersion1772638000000 } from '../migrations/1772638000000-AddTokenVersion';
import { AddPreviewColumns1772639000000 } from '../migrations/1772639000000-AddPreviewColumns';
import { AddBuildCacheKeepGB1772640000000 } from '../migrations/1772640000000-AddBuildCacheKeepGB';
import { AddZeroDowntime1772641000000 } from '../migrations/1772641000000-AddZeroDowntime';

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
    entities: [User, Project, GithubRepo, CustomDomain, AppSettings, ProjectCollaborator, Deployment],
    migrations: [InitialSchema1709520000000, AddDomainRedirectTarget1772633000000, AddPermissions1772634000000, AddComposeSupport1772635000000, AddDeployments1772636000000, AddNotificationsAndAutoRestart1772637000000, AddTokenVersion1772638000000, AddPreviewColumns1772639000000, AddBuildCacheKeepGB1772640000000, AddZeroDowntime1772641000000],
    subscribers: [],
});
