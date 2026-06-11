import { describe, it, expect } from 'vitest';
import {
    containerGenerations, nextContainerGeneration,
    composeGenerations, nextComposeGeneration,
} from '../deployNames';

describe('deployNames', () => {
    const base = 'runnable-abcd1234';

    it('lists all container generations including the legacy unsuffixed name', () => {
        expect(containerGenerations(base)).toEqual([base, `${base}-blue`, `${base}-green`]);
    });

    it('alternates blue/green', () => {
        expect(nextContainerGeneration(base, `${base}-blue`)).toBe(`${base}-green`);
        expect(nextContainerGeneration(base, `${base}-green`)).toBe(`${base}-blue`);
    });

    it('migrates from legacy unsuffixed / missing active to blue', () => {
        expect(nextContainerGeneration(base, base)).toBe(`${base}-blue`);
        expect(nextContainerGeneration(base, null)).toBe(`${base}-blue`);
        expect(nextContainerGeneration(base, undefined)).toBe(`${base}-blue`);
    });

    it('lists all compose generations including the legacy name', () => {
        expect(composeGenerations(base)).toEqual([base, `${base}-a`, `${base}-b`]);
    });

    it('alternates compose a/b and migrates from legacy', () => {
        expect(nextComposeGeneration(base, `${base}-a`)).toBe(`${base}-b`);
        expect(nextComposeGeneration(base, `${base}-b`)).toBe(`${base}-a`);
        expect(nextComposeGeneration(base, base)).toBe(`${base}-a`);
        expect(nextComposeGeneration(base, null)).toBe(`${base}-a`);
    });
});
