/**
 * Naming for blue-green deploy generations. Project.containerId always
 * stores the ACTIVE full name (container name, or compose project name);
 * the incoming deploy uses the other generation. The unsuffixed base name
 * is the legacy pre-blue-green form — it appears in the generation lists so
 * sweeps and migration can account for it, but is never chosen as "next".
 */

export function containerGenerations(base: string): string[] {
    return [base, `${base}-blue`, `${base}-green`];
}

export function nextContainerGeneration(base: string, active?: string | null): string {
    return active === `${base}-blue` ? `${base}-green` : `${base}-blue`;
}

export function composeGenerations(base: string): string[] {
    return [base, `${base}-a`, `${base}-b`];
}

export function nextComposeGeneration(base: string, active?: string | null): string {
    return active === `${base}-a` ? `${base}-b` : `${base}-a`;
}
