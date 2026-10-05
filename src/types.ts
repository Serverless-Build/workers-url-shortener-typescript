export type AppEnv = Env | ClaimableEnv;
export type Link = { code: string; workspaceId: string; url: string; createdAt: number; expiresAt: number; clickCount: number; deleted: number };
export type Click = { id: string; clickedAt: number; userAgent: string; referrer: string };
export function isFull(env: AppEnv): env is Env { return env.STORAGE_PROFILE === 'full'; }
