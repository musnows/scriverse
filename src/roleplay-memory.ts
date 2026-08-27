import { z } from "zod";

export const ROLEPLAY_MEMORY_CATEGORIES = ["event", "state", "relationship", "commitment", "knowledge", "scene"] as const;
export const ROLEPLAY_MEMORY_IMPORTANCE = ["low", "medium", "high"] as const;
export const ROLEPLAY_MEMORY_CERTAINTY = ["experienced", "observed", "heard", "believed"] as const;
export const ROLEPLAY_MEMORY_STATUSES = ["active", "superseded", "archived"] as const;

export type RoleplayMemoryCategory = typeof ROLEPLAY_MEMORY_CATEGORIES[number];
export type RoleplayMemoryImportance = typeof ROLEPLAY_MEMORY_IMPORTANCE[number];
export type RoleplayMemoryCertainty = typeof ROLEPLAY_MEMORY_CERTAINTY[number];
export type RoleplayMemoryStatus = typeof ROLEPLAY_MEMORY_STATUSES[number];

export const roleplayMemoryCandidateSchema = z.object({
  category: z.enum(ROLEPLAY_MEMORY_CATEGORIES),
  content: z.string().trim().min(1).max(500),
  importance: z.enum(ROLEPLAY_MEMORY_IMPORTANCE).default("medium"),
  certainty: z.enum(ROLEPLAY_MEMORY_CERTAINTY).default("experienced"),
  supersedesMemoryId: z.string().trim().min(1).max(200).optional()
}).strict();

export const rememberRoleplayArgumentsSchema = z.object({
  memories: z.array(roleplayMemoryCandidateSchema).min(1).max(8)
}).strict();

export const recallRoleplayMemoryArgumentsSchema = z.object({
  query: z.string().trim().max(200).default(""),
  categories: z.array(z.enum(ROLEPLAY_MEMORY_CATEGORIES)).max(ROLEPLAY_MEMORY_CATEGORIES.length).default([]),
  cursor: z.number().int().min(0).max(100_000).default(0)
}).strict();

export type RoleplayMemoryCandidate = z.infer<typeof roleplayMemoryCandidateSchema>;

export function normalizeRoleplayMemoryContent(value: string, maximumLength = 2_000): string {
  return Array.from(value.normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()).slice(0, maximumLength).join("");
}

export function roleplayMemoryCandidateIsSafe(value: string): boolean {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const forbidden = [
    /<\/?(?:system|developer|tool)(?:\s|>)/u,
    /(?:system prompt|developer message|系统提示(?:词)?|开发者消息)/u,
    /\b(?:bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9_-]{12,}|api[_ -]?key\s*[:=]\s*\S+)/iu,
    /(?:密码|口令|密钥|令牌)\s*[:=]\s*\S{8,}/u
  ];
  return forbidden.every((pattern) => !pattern.test(normalized));
}

export function renderRoleplayMemoriesForPrompt(memories: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({
    origin: "roleplay",
    canonical: false,
    memories: memories.map((memory) => ({
      id: memory.id,
      category: memory.category,
      content: memory.content,
      importance: memory.importance,
      certainty: memory.certainty,
      status: memory.status,
      isPinned: memory.isPinned
    }))
  });
}
