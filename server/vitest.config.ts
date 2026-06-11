import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
    plugins: [
        // Compile TS with SWC so TypeORM's decorator metadata is emitted in tests.
        swc.vite({
            module: { type: 'es6' },
            jsc: {
                target: 'es2022',
                parser: { syntax: 'typescript', decorators: true },
                transform: { legacyDecorator: true, decoratorMetadata: true },
            },
        }),
    ],
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
});
