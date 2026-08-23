import { AsyncLocalStorage } from "node:async_hooks";

export type RequestActor = {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  authentication?: "session" | "desktop-session" | "api-key";
};

export type RequestContext = {
  requestId?: string;
  actor: RequestActor | null;
};

const requestStorage = new AsyncLocalStorage<RequestContext | null>();

export function runWithRequestContext<T>(context: RequestContext, operation: () => T): T {
  return requestStorage.run(context, operation);
}

export function runWithRequestActor<T>(actor: RequestActor | null, operation: () => T): T {
  const current = requestStorage.getStore();
  return requestStorage.run({ ...(current?.requestId ? { requestId: current.requestId } : {}), actor }, operation);
}

export function currentRequestActor(): RequestActor | null {
  return requestStorage.getStore()?.actor ?? null;
}

export function currentRequestContext(): RequestContext | null {
  return requestStorage.getStore() ?? null;
}
