export type RestorableModule = "drafts" | "settings" | "characters" | "races" | "organizations" | "timeline" | "outlines" | "relationships" | "reviews" | "tasks" | "ai-settings";
export type PageRoute =
  | { view: "shelf" }
  | { view: "im" }
  | { view: "editor"; workId: string; chapterId: string | null }
  | { view: "reader"; workId: string; chapterId: string | null }
  | { view: "module"; workId: string; module: RestorableModule }
  | { view: "welcome"; workId: string }
  | { view: "settings" | "platform-ai"; workId: string | null; returnView?: "shelf" | "im" | "editor" | "module" | "welcome"; returnModule?: RestorableModule; returnChapterId?: string };

export const RESTORABLE_MODULES: readonly RestorableModule[];
export function serializePageRoute(route?: Record<string, unknown>): string;
export function parsePageRoute(hash?: string): PageRoute;
