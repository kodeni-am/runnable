import fs from 'fs/promises';
import path from 'path';

export interface ProjectDetection {
    runtime: 'node' | 'python' | 'go' | 'dotnet' | 'php' | 'ruby' | 'java' | 'rust' | 'elixir' | 'static' | 'unknown';
    buildCommand?: string;
    startCommand?: string;
    defaultPort: number;
    hasDockerfile: boolean;
}

export class DetectService {
    /**
     * Auto-detect the project type from files present in the directory.
     * Returns sensible defaults for build/start commands, which
     * the user can override via the Settings tab.
     */
    static async detect(directoryPath: string): Promise<ProjectDetection> {
        const files = await fs.readdir(directoryPath).catch(() => []);
        const fileSet = new Set(files);

        // 1. Dockerfile present → let Docker handle everything
        if (fileSet.has('Dockerfile') || fileSet.has('dockerfile')) {
            return {
                runtime: 'unknown',
                defaultPort: 8080,
                hasDockerfile: true,
            };
        }

        // 2. Node.js (package.json)
        if (fileSet.has('package.json')) {
            return DetectService.detectNode(directoryPath);
        }

        // 3. Python
        if (fileSet.has('requirements.txt') || fileSet.has('Pipfile') || fileSet.has('pyproject.toml')) {
            return DetectService.detectPython(directoryPath, fileSet);
        }

        // 4. Go
        if (fileSet.has('go.mod')) {
            return {
                runtime: 'go',
                buildCommand: 'go build -o app .',
                startCommand: './app',
                defaultPort: 8080,
                hasDockerfile: false,
            };
        }

        // 5. .NET (*.csproj or *.sln)
        const hasDotnet = files.some(f => f.endsWith('.csproj') || f.endsWith('.sln'));
        if (hasDotnet) {
            return {
                runtime: 'dotnet',
                buildCommand: 'dotnet publish -c Release -o out',
                startCommand: 'dotnet out/*.dll',
                defaultPort: 5000,
                hasDockerfile: false,
            };
        }

        // 6. PHP (composer.json)
        if (fileSet.has('composer.json')) {
            return {
                runtime: 'php',
                buildCommand: 'composer install --no-dev',
                startCommand: 'php -S 0.0.0.0:$PORT -t public',
                defaultPort: 8080,
                hasDockerfile: false,
            };
        }

        // 7. Ruby (Gemfile)
        if (fileSet.has('Gemfile')) {
            return {
                runtime: 'ruby',
                buildCommand: 'bundle install',
                startCommand: 'bundle exec ruby app.rb -p $PORT',
                defaultPort: 4567,
                hasDockerfile: false,
            };
        }

        // 8. Java (pom.xml or build.gradle)
        if (fileSet.has('pom.xml') || fileSet.has('build.gradle') || fileSet.has('build.gradle.kts')) {
            const isMaven = fileSet.has('pom.xml');
            return {
                runtime: 'java',
                buildCommand: isMaven ? 'mvn package -DskipTests' : './gradlew build -x test',
                startCommand: 'java -jar target/*.jar',
                defaultPort: 8080,
                hasDockerfile: false,
            };
        }

        // 9. Rust (Cargo.toml)
        if (fileSet.has('Cargo.toml')) {
            return {
                runtime: 'rust',
                buildCommand: 'cargo build --release',
                startCommand: './target/release/*',
                defaultPort: 8080,
                hasDockerfile: false,
            };
        }

        // 10. Elixir (mix.exs)
        if (fileSet.has('mix.exs')) {
            return {
                runtime: 'elixir',
                buildCommand: 'mix deps.get && mix compile',
                startCommand: 'mix phx.server',
                defaultPort: 4000,
                hasDockerfile: false,
            };
        }

        // 11. Static site (has index.html)
        if (fileSet.has('index.html')) {
            return {
                runtime: 'static',
                defaultPort: 8080,
                hasDockerfile: false,
            };
        }

        return {
            runtime: 'unknown',
            defaultPort: 8080,
            hasDockerfile: false,
        };
    }

    private static async detectNode(directoryPath: string): Promise<ProjectDetection> {
        try {
            const pkgRaw = await fs.readFile(path.join(directoryPath, 'package.json'), 'utf-8');
            const pkg = JSON.parse(pkgRaw);
            const scripts = pkg.scripts || {};
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

            let buildCommand = 'npm install';
            let startCommand: string | undefined;
            let defaultPort = 3000;

            // Detect build step
            if (scripts.build) {
                buildCommand = 'npm install && npm run build';
            }

            // Detect start command
            if (scripts.start) {
                startCommand = 'npm start';
            } else if (deps['next']) {
                startCommand = 'npx next start -p $PORT';
                defaultPort = 3000;
            } else if (deps['nuxt']) {
                startCommand = 'npx nuxt start';
                defaultPort = 3000;
            } else if (deps['vite'] && scripts.preview) {
                startCommand = 'npm run preview -- --port $PORT --host';
                defaultPort = 4173;
            }

            // Framework-specific port defaults
            if (deps['express'] || deps['fastify'] || deps['koa'] || deps['hapi']) {
                defaultPort = 3000;
            }

            return {
                runtime: 'node',
                buildCommand,
                startCommand,
                defaultPort,
                hasDockerfile: false,
            };
        } catch {
            return {
                runtime: 'node',
                buildCommand: 'npm install',
                defaultPort: 3000,
                hasDockerfile: false,
            };
        }
    }

    private static detectPython(directoryPath: string, fileSet: Set<string>): ProjectDetection {
        let buildCommand = 'pip install -r requirements.txt';
        let startCommand = 'python app.py';
        let defaultPort = 5000;

        if (fileSet.has('Pipfile')) {
            buildCommand = 'pipenv install';
        } else if (fileSet.has('pyproject.toml')) {
            buildCommand = 'pip install .';
        }

        // Common frameworks
        if (fileSet.has('manage.py')) {
            // Django
            startCommand = 'python manage.py runserver 0.0.0.0:$PORT';
            defaultPort = 8000;
        } else if (fileSet.has('wsgi.py') || fileSet.has('gunicorn.conf.py')) {
            startCommand = 'gunicorn wsgi:app --bind 0.0.0.0:$PORT';
        }

        return {
            runtime: 'python',
            buildCommand,
            startCommand,
            defaultPort,
            hasDockerfile: false,
        };
    }
}
