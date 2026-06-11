import path from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * Validates user-supplied docker-compose stacks before Runnable runs them.
 *
 * The server executes these stacks with the daemon's full privileges, so a
 * malicious compose file could otherwise escape to the host (bind-mount `/`,
 * run privileged, share host namespaces, add capabilities, etc.). This is the
 * enforcement boundary that makes dropping the sandbox user's docker access
 * meaningful — without it, the user just supplies the escape directly.
 *
 * IMPORTANT: validate the output of `docker compose config`, NOT the raw file.
 * `config` resolves `${VAR}` interpolation (sourced from user-controlled env
 * vars), YAML merge keys / anchors, and `extends`, and normalizes volumes to
 * long form. Validating the raw YAML is unsound — e.g. a volume source of
 * `${HOST_ROOT}` or a `<<: *anchor` merge would slip past a text check and
 * still mount the host once Docker expands it.
 */
export class ComposePolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ComposePolicyError';
    }
}

// Service-level keys that grant host access we never allow for user stacks.
const FORBIDDEN_SERVICE_KEYS = [
    'privileged',
    'cap_add',
    'devices',
    'device_cgroup_rules',
    'cgroup_parent',
    'userns_mode',
    'ipc',
    'pid',
    'uts',
    'security_opt',
    'volumes_from',
    'group_add',
];

export class ComposePolicyService {
    /**
     * Validate a normalized compose document (the parsed output of
     * `docker compose config`). Throws ComposePolicyError on the first
     * violation.
     */
    static validate(doc: any): void {
        if (!doc || typeof doc !== 'object') {
            throw new ComposePolicyError('Compose file is empty or not an object');
        }

        const services = doc.services;
        if (!services || typeof services !== 'object') {
            throw new ComposePolicyError('Compose file has no "services" section');
        }

        for (const [name, svcRaw] of Object.entries(services)) {
            const svc = svcRaw as Record<string, any>;
            if (!svc || typeof svc !== 'object') continue;

            for (const key of FORBIDDEN_SERVICE_KEYS) {
                const val = svc[key];
                const present = val != null && !(Array.isArray(val) && val.length === 0);
                if (present) {
                    throw new ComposePolicyError(
                        `Service "${name}" uses "${key}", which is not allowed (host privilege escalation).`
                    );
                }
            }

            // Host/foreign-namespace sharing
            const networkMode = svc.network_mode;
            if (typeof networkMode === 'string') {
                const nm = networkMode.trim().toLowerCase();
                // `service:<other>` joins another service in the SAME stack — safe.
                // `host`/`shareable`/`container:<name>` reach outside it.
                if (nm === 'host' || nm === 'shareable' || nm.startsWith('container:')) {
                    throw new ComposePolicyError(
                        `Service "${name}" uses network_mode "${networkMode}", which is not allowed.`
                    );
                }
            }

            ComposePolicyService.validateVolumes(name, svc.volumes);
        }

        ComposePolicyService.validateTopLevelVolumes(doc.volumes);
    }

    /**
     * Convenience wrapper: parse a YAML string then validate. Used in tests.
     * Production validates the normalized `docker compose config` output via
     * validate() directly.
     */
    static validateYaml(content: string): void {
        let doc: any;
        try {
            doc = parseYaml(content, { merge: true });
        } catch (err: any) {
            throw new ComposePolicyError(`Could not parse compose file: ${err?.message || 'invalid YAML'}`);
        }
        ComposePolicyService.validate(doc);
    }

    /**
     * Pre-scan the RAW compose file for file references that would make
     * `docker compose config` (run as root) read host files: `env_file`,
     * `extends.file`, and top-level `include`. These are resolved before
     * normalization, so they must be confined to the project directory here —
     * otherwise a user could inline e.g. /etc/shadow into their container env.
     */
    static validateRawReferences(content: string, projectDir: string): void {
        let doc: any;
        try {
            doc = parseYaml(content, { merge: true });
        } catch (err: any) {
            throw new ComposePolicyError(`Could not parse compose file: ${err?.message || 'invalid YAML'}`);
        }
        if (!doc || typeof doc !== 'object') return;
        const base = path.resolve(projectDir);

        const assertInProject = (ref: unknown, what: string) => {
            if (typeof ref !== 'string' || ref === '') return;
            const resolved = path.resolve(base, ref);
            if (resolved !== base && !resolved.startsWith(base + path.sep)) {
                throw new ComposePolicyError(
                    `${what} references "${ref}", which is outside the project directory.`
                );
            }
        };

        // Top-level include
        const include = doc.include;
        if (Array.isArray(include)) {
            for (const inc of include) {
                if (typeof inc === 'string') assertInProject(inc, 'include');
                else if (inc && typeof inc === 'object') {
                    const paths = Array.isArray(inc.path) ? inc.path : [inc.path];
                    for (const p of paths) assertInProject(p, 'include.path');
                    assertInProject(inc.env_file, 'include.env_file');
                    assertInProject(inc.project_directory, 'include.project_directory');
                }
            }
        }

        const services = doc.services;
        if (services && typeof services === 'object') {
            for (const [name, svcRaw] of Object.entries(services)) {
                const svc = svcRaw as Record<string, any>;
                if (!svc || typeof svc !== 'object') continue;

                // env_file: string | string[] | {path}[]
                const envFile = svc.env_file;
                const envEntries = Array.isArray(envFile) ? envFile : envFile != null ? [envFile] : [];
                for (const e of envEntries) {
                    if (typeof e === 'string') assertInProject(e, `Service "${name}" env_file`);
                    else if (e && typeof e === 'object') assertInProject(e.path, `Service "${name}" env_file`);
                }

                // extends: { file?, service } — a bare string extends a service in this file (safe)
                const ext = svc.extends;
                if (ext && typeof ext === 'object') {
                    assertInProject(ext.file, `Service "${name}" extends.file`);
                }
            }
        }
    }

    private static validateVolumes(service: string, volumes: unknown): void {
        if (!Array.isArray(volumes)) return;

        for (const vol of volumes) {
            if (typeof vol === 'string') {
                // Short syntax "SOURCE:TARGET[:MODE]" — a path-like source is a
                // host bind mount. (Normalized config emits long form, but guard
                // the short form too.)
                const parts = vol.split(':');
                if (parts.length < 2) continue; // anonymous volume — safe
                ComposePolicyService.rejectBindSource(service, parts[0]);
            } else if (vol && typeof vol === 'object') {
                const v = vol as Record<string, any>;
                // `docker compose config` sets type explicitly. Reject every
                // host bind mount regardless of where it points — a string/path
                // check can't account for symlinks inside the project that
                // Docker resolves at mount time, nor the validate→up TOCTOU gap.
                if (v.type === 'bind') {
                    throw new ComposePolicyError(
                        `Service "${service}" uses a host bind mount (source "${v.source ?? '?'}"), ` +
                        `which is not allowed. Use a named volume for persistent data.`
                    );
                }
                // type: volume / tmpfs are safe.
            }
        }
    }

    private static rejectBindSource(service: string, source: string): void {
        // Named volumes don't start with a path separator or "."/"~".
        if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
            throw new ComposePolicyError(
                `Service "${service}" bind-mounts host path "${source}", which is not allowed. ` +
                `Use a named volume for persistent data.`
            );
        }
    }

    private static validateTopLevelVolumes(volumes: unknown): void {
        if (!volumes || typeof volumes !== 'object') return;
        for (const [name, volRaw] of Object.entries(volumes as Record<string, any>)) {
            const vol = volRaw as Record<string, any>;
            if (!vol || typeof vol !== 'object') continue;
            // A "local" driver with type=none/o=bind + device is a named volume
            // that is really a host bind mount.
            const opts = vol.driver_opts;
            if (opts && typeof opts === 'object' && (opts.type === 'none' || opts.o === 'bind') && opts.device != null) {
                throw new ComposePolicyError(
                    `Volume "${name}" is a host bind mount (driver_opts device), which is not allowed.`
                );
            }
        }
    }
}
