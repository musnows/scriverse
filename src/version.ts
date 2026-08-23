export const APP_VERSION = "0.8.8";

export const SCRIVERSE_BETA_COMMIT_ENV = "SCRIVERSE_BETA_COMMIT";

export function resolveBetaVersionLabel(environment: NodeJS.ProcessEnv): string | undefined {
  const commit = environment[SCRIVERSE_BETA_COMMIT_ENV]?.trim().toLocaleLowerCase() ?? "";
  return /^[a-f0-9]{8,64}$/u.test(commit) ? `${commit.slice(0, 8)} beta` : undefined;
}
