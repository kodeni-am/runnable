# Implement Granular User & Project Permissions

Two-tier permissions system: **global user permissions** (what a user can do platform-wide) and **per-project collaborator permissions** (what a user can do on a specific project they've been invited to).

## User Review Required

> [!IMPORTANT]
> Please confirm the proposed permission flags below match your needs, and whether there are any you'd like added or removed.

### Tier 1: Global User Permissions (on [User](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/store/authStore.ts#4-13) entity)

A `permissions` JSONB column on `users` table:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `maxProjects` | number | `null` (unlimited) | Max projects this user can own |
| `canCreateProjects` | boolean | `true` | Whether user can create new projects |
| `canUseCustomDomains` | boolean | `true` | Whether user can map custom domains |
| `allowedServerTypes` | string[] | `null` (all) | Restrict to specific server types |

### Tier 2: Per-Project Collaborator Permissions (new `ProjectCollaborator` entity)

A new join table `project_collaborators` linking users to projects with specific rights:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `canStart` | boolean | `false` | Start/stop/restart the service |
| `canEditConfig` | boolean | `false` | Edit project settings (env vars, commands, server type) |
| `canEditDomains` | boolean | `false` | Add/remove/edit custom domains |
| `canEditFiles` | boolean | `false` | Upload/edit/delete files |
| `canDelete` | boolean | `false` | Delete the project |
| `canViewLogs` | boolean | `true` | View project logs |

The **project owner** always has full access. Only the owner (and admins) can invite collaborators and set their permissions.

---

## Proposed Changes

### Server — Entities & Migration

#### [NEW] [ProjectCollaborator.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/entities/ProjectCollaborator.ts)
- `id`, `userId`, `projectId`, `permissions` (JSONB with the flags above), `createdAt`
- Relations: `ManyToOne → User`, `ManyToOne → Project`

#### [MODIFY] [User.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/entities/User.ts)
- Add `permissions` JSONB column (Tier 1 flags)
- Add `OneToMany → ProjectCollaborator`

#### [MODIFY] [Project.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/entities/Project.ts)
- Add `OneToMany → ProjectCollaborator`

#### [MODIFY] [enums.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/entities/enums.ts)
- Export `ProjectPermission` enum for the flag keys

#### [MODIFY] [index.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/entities/index.ts)
- Re-export `ProjectCollaborator`

#### [NEW] Migration: `AddPermissions`
- Add `permissions` JSONB column to `users`
- Create `project_collaborators` table

#### [MODIFY] [data-source.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/config/data-source.ts)
- Register `ProjectCollaborator` entity and new migration

---

### Server — Middleware & Authorization

#### [MODIFY] [auth.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/middleware/auth.ts)
- Add `requireProjectAccess(...permissions)` middleware that:
  1. Checks if user is the project owner → full access
  2. Checks if user is admin → full access
  3. Looks up `ProjectCollaborator` row and validates requested permission flags
  4. Returns 403 if not authorized

---

### Server — Routes

#### [MODIFY] [projects.routes.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/routes/projects.routes.ts)
- `GET /` → also return projects where user is a collaborator
- `GET /:id` → allow collaborators to access
- `PUT /:id` → guard with `canEditConfig`
- `DELETE /:id` → guard with `canDelete`
- `POST /:id/start|stop|restart` → guard with `canStart`
- `GET /:id/logs` → guard with `canViewLogs`
- Add `POST /:id/collaborators` — invite a user by email/username with permissions
- Add `GET /:id/collaborators` — list collaborators
- Add `PUT /:id/collaborators/:userId` — update a collaborator's permissions
- Add `DELETE /:id/collaborators/:userId` — remove a collaborator

#### [MODIFY] [domains.routes.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/routes/domains.routes.ts)
- Guard domain CRUD with `canEditDomains`

#### [MODIFY] [files.routes.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/routes/files.routes.ts)
- Guard file operations with `canEditFiles`

#### [MODIFY] [admin.routes.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/server/src/routes/admin.routes.ts)
- Add `PUT /users/:id/permissions` — update a user's global permissions
- Include `permissions` in `GET /users` response

---

### Client — API & UI

#### [MODIFY] [admin.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/api/admin.ts)
- Add `updateUserPermissions()` API call
- Update [UserDTO](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/api/admin.ts#3-13) to include `permissions`

#### [MODIFY] [authStore.ts](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/store/authStore.ts)
- Add `permissions` to the [User](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/store/authStore.ts#4-13) interface

#### [MODIFY] [Admin.tsx](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/pages/Admin.tsx)
- Add a permissions edit modal/drawer per user (Tier 1 flags)

#### [MODIFY] [ProjectDetail.tsx](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/pages/ProjectDetail.tsx)
- Add "Collaborators" section (invite, list, edit permissions, remove)
- Conditionally show/hide buttons based on the user's project permissions
- Add collaborator API calls

#### [MODIFY] [Dashboard.tsx](file:///Users/araasryan/AndroidStudioProjects/runnable/client/src/pages/Dashboard.tsx)
- Show projects where user is a collaborator (with a "Shared" badge)

---

## Verification Plan

### Manual Verification
1. Admin sets a user's `maxProjects` to 1 → user cannot create a second project
2. Project owner invites a collaborator with only `canViewLogs` → collaborator can see the project and logs but cannot start/stop or edit
3. Owner grants `canStart` → collaborator can now start/stop
4. Removing a collaborator removes access entirely
5. Admin always has full access to all projects
